-- Block 1: outbox + durable job queue.
--
-- Two tables that everything else in the catalog leans on:
--   blocks_core.outbox_events  the logical event stream (docs/ROW_EVENTS.md)
--   blocks_queue.jobs          durable work with retries, leases, and a DLQ
--
-- blocks_core is the one shared schema every block may reference, because the event contract
-- has to live somewhere neutral. No other cross-schema references are permitted (§1).

CREATE SCHEMA IF NOT EXISTS blocks_core;
CREATE SCHEMA IF NOT EXISTS blocks_queue;

-- Migration ledger. Also created by @neon-blocks/migrate's bootstrap, but declared here so
-- this migration is self-contained and can be applied by hand.
CREATE TABLE IF NOT EXISTS blocks_core.migrations (
  block       text        NOT NULL,
  version     text        NOT NULL,
  name        text        NOT NULL,
  checksum    text        NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (block, version)
);

-- ---------------------------------------------------------------------------
-- Event outbox
-- ---------------------------------------------------------------------------
-- Neon has not shipped database row-event triggers, so this table *is* the event stream.
-- Producers insert; a cron-driven drain claims batches with FOR UPDATE SKIP LOCKED. When
-- native row triggers ship, the drain is replaced and consumers do not change.

CREATE TABLE IF NOT EXISTS blocks_core.outbox_events (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type        text        NOT NULL,
  subject           text        NOT NULL,
  payload           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  meta              jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- When the change happened, not when it was delivered. Consumers that care about ordering
  -- use this, because delivery order is not guaranteed.
  occurred_at       timestamptz NOT NULL DEFAULT now(),

  -- Caller-supplied dedupe key. Without it, an app retrying a failed request double-publishes
  -- and the consumer's own idempotency is the only thing preventing a double side effect.
  idempotency_key   text,

  attempts          integer     NOT NULL DEFAULT 0,
  claimed_at        timestamptz,
  claimed_by        text,
  delivered_at      timestamptz,
  retry_at          timestamptz,
  dead_lettered_at  timestamptz,
  last_error        text,

  CONSTRAINT outbox_event_type_shape CHECK (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$')
);

-- Partial unique index rather than a plain one: NULL keys must not collide with each other,
-- and most events are published without a key.
CREATE UNIQUE INDEX IF NOT EXISTS outbox_idempotency_key_uniq
  ON blocks_core.outbox_events (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- The drain's hot path: undelivered, due, oldest first. Partial so the index stays small as
-- delivered events accumulate — the alternative is an index that grows forever and a drain
-- that gets slower every day.
CREATE INDEX IF NOT EXISTS outbox_pending_idx
  ON blocks_core.outbox_events (occurred_at)
  WHERE delivered_at IS NULL AND dead_lettered_at IS NULL;

CREATE INDEX IF NOT EXISTS outbox_type_pending_idx
  ON blocks_core.outbox_events (event_type, occurred_at)
  WHERE delivered_at IS NULL AND dead_lettered_at IS NULL;

-- ---------------------------------------------------------------------------
-- Producer helper: attach an outbox trigger to a user table
-- ---------------------------------------------------------------------------
-- The closest available approximation of a native row-event trigger, with the same
-- at-least-once semantics. This function is what gets RETIRED when Neon ships row events —
-- consumers keep working untouched.

CREATE OR REPLACE FUNCTION blocks_core.outbox_row_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event_type text := TG_ARGV[0];
  v_key_column text := COALESCE(TG_ARGV[1], 'id');
  v_subject    text;
  v_row        jsonb;
BEGIN
  v_row := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  v_subject := COALESCE(v_row ->> v_key_column, '');

  IF v_subject = '' THEN
    RAISE EXCEPTION 'blocks_core.outbox_row_trigger: column % not found on %.%',
      v_key_column, TG_TABLE_SCHEMA, TG_TABLE_NAME;
  END IF;

  INSERT INTO blocks_core.outbox_events (event_type, subject, payload, meta)
  VALUES (
    v_event_type,
    v_subject,
    jsonb_build_object(
      'op',  TG_OP,
      'new', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END,
      -- Old row included on UPDATE so consumers can diff and skip no-op writes. This is what
      -- lets the embedding-freshness block avoid re-embedding when an unrelated column
      -- changed.
      'old', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END
    ),
    jsonb_build_object('table', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, 'via', 'db_trigger')
  );

  RETURN NULL; -- AFTER trigger; return value is ignored.
END;
$$;

COMMENT ON FUNCTION blocks_core.outbox_row_trigger() IS
  'Writes row changes to the outbox. Stand-in for Neon row-event triggers, which have not '
  'shipped. Retire this when they do; see docs/ROW_EVENTS.md.';

CREATE OR REPLACE FUNCTION blocks_core.attach_outbox_trigger(
  p_schema      text,
  p_table       text,
  p_event_type  text,
  p_key_column  text DEFAULT 'id'
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_trigger_name text := 'blocks_outbox_' || p_table;
BEGIN
  -- format() with %I quotes identifiers, so a table named "my table" or a hostile name
  -- cannot break out of the statement.
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I.%I', v_trigger_name, p_schema, p_table);
  EXECUTE format(
    'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I.%I '
    'FOR EACH ROW EXECUTE FUNCTION blocks_core.outbox_row_trigger(%L, %L)',
    v_trigger_name, p_schema, p_table, p_event_type, p_key_column
  );
END;
$$;

COMMENT ON FUNCTION blocks_core.attach_outbox_trigger(text, text, text, text) IS
  'Attach row-change publishing to one of your tables. Example: '
  'SELECT blocks_core.attach_outbox_trigger(''public'', ''orders'', ''order.changed'');';

-- ---------------------------------------------------------------------------
-- Job queue
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS blocks_queue.jobs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type         text        NOT NULL,
  payload          jsonb       NOT NULL DEFAULT '{}'::jsonb,

  state            text        NOT NULL DEFAULT 'pending',
  attempts         integer     NOT NULL DEFAULT 0,
  max_attempts     integer     NOT NULL DEFAULT 5,

  -- Higher runs first; ties break oldest-first. Stops a high-priority job being starved by
  -- a long backlog of ordinary work.
  priority         integer     NOT NULL DEFAULT 0,
  run_at           timestamptz NOT NULL DEFAULT now(),

  -- A function can die mid-job. Without a lease the job sits in 'running' forever and
  -- nothing retries it, which is the classic Postgres-as-queue failure.
  leased_until     timestamptz,
  claimed_by       text,
  claimed_at       timestamptz,
  finished_at      timestamptz,

  last_error       text,
  idempotency_key  text,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT jobs_state_valid CHECK (state IN ('pending', 'running', 'succeeded', 'failed', 'dead')),
  CONSTRAINT jobs_type_shape CHECK (job_type ~ '^[a-z][a-z0-9_.]*$'),
  CONSTRAINT jobs_attempts_sane CHECK (attempts >= 0 AND max_attempts >= 1),
  -- A running job must hold a lease. Catches a claim path that forgets to set one, which
  -- would otherwise manifest as a job invisible to both the worker and the reaper.
  CONSTRAINT jobs_running_has_lease CHECK (state <> 'running' OR leased_until IS NOT NULL)
);

-- Idempotency scoped to *active* jobs only, so "send user 7's digest" is enqueueable again
-- tomorrow once today's finished. A plain unique index would make the key single-use forever.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_idempotency_active
  ON blocks_queue.jobs (idempotency_key)
  WHERE idempotency_key IS NOT NULL AND state IN ('pending', 'running');

-- The claim query's index: priority DESC, run_at ASC over runnable rows.
CREATE INDEX IF NOT EXISTS jobs_runnable_idx
  ON blocks_queue.jobs (priority DESC, run_at)
  WHERE state = 'pending';

-- Lets the reaper find expired leases without scanning finished jobs.
CREATE INDEX IF NOT EXISTS jobs_lease_idx
  ON blocks_queue.jobs (leased_until)
  WHERE state = 'running';

CREATE INDEX IF NOT EXISTS jobs_type_state_idx ON blocks_queue.jobs (job_type, state);

CREATE INDEX IF NOT EXISTS jobs_purge_idx
  ON blocks_queue.jobs (finished_at)
  WHERE state = 'succeeded';

-- ---------------------------------------------------------------------------
-- Observability (§10)
-- ---------------------------------------------------------------------------

-- Dead letters, newest first. Deliberately a view over the same table rather than a separate
-- DLQ table: replay is then an UPDATE, not a cross-table move that can half-fail.
CREATE OR REPLACE VIEW blocks_queue.v_dead_letters AS
SELECT id, job_type, payload, attempts, max_attempts, last_error, finished_at, created_at
FROM blocks_queue.jobs
WHERE state = 'dead'
ORDER BY finished_at DESC NULLS LAST;

CREATE OR REPLACE VIEW blocks_queue.v_job_stats AS
SELECT
  job_type,
  count(*) FILTER (WHERE state = 'pending')   AS pending,
  count(*) FILTER (WHERE state = 'running')   AS running,
  count(*) FILTER (WHERE state = 'succeeded') AS succeeded,
  count(*) FILTER (WHERE state = 'dead')      AS dead,
  count(*) FILTER (WHERE state = 'pending' AND run_at <= now()) AS due_now,
  max(attempts)                               AS max_attempts_seen
FROM blocks_queue.jobs
GROUP BY job_type;

-- The health view. Every block ships one of these with exactly this name (§10) so the HTTP
-- /health route and the SQL answer cannot drift apart.
CREATE OR REPLACE VIEW blocks_queue.v_status AS
SELECT
  (SELECT count(*) FROM blocks_queue.jobs WHERE state = 'pending')                        AS jobs_pending,
  (SELECT count(*) FROM blocks_queue.jobs WHERE state = 'pending' AND run_at <= now())    AS jobs_due,
  (SELECT count(*) FROM blocks_queue.jobs WHERE state = 'running')                        AS jobs_running,
  (SELECT count(*) FROM blocks_queue.jobs WHERE state = 'running' AND leased_until < now()) AS jobs_lease_expired,
  (SELECT count(*) FROM blocks_queue.jobs WHERE state = 'dead')                           AS jobs_dead,

  -- Age of the oldest due job. The single most useful number here: if this climbs, the cron
  -- trigger is disabled (child branches inherit triggers DISABLED) or the worker is failing.
  (SELECT COALESCE(EXTRACT(EPOCH FROM (now() - min(run_at)))::bigint, 0)
     FROM blocks_queue.jobs WHERE state = 'pending' AND run_at <= now())                  AS oldest_due_seconds,

  (SELECT count(*) FROM blocks_core.outbox_events
     WHERE delivered_at IS NULL AND dead_lettered_at IS NULL)                             AS outbox_pending,
  (SELECT count(*) FROM blocks_core.outbox_events WHERE dead_lettered_at IS NOT NULL)      AS outbox_dead,
  (SELECT COALESCE(EXTRACT(EPOCH FROM (now() - min(occurred_at)))::bigint, 0)
     FROM blocks_core.outbox_events
     WHERE delivered_at IS NULL AND dead_lettered_at IS NULL)                             AS outbox_lag_seconds;
