-- Block 28: scheduled cleanup job.
--
-- Demonstrates the scheduled-trigger pattern that several blocks rely on, on its own: a UTC cron
-- trigger fires /run, which expires records whose deadline has passed. The timer lives outside the
-- compute, so it fires correctly even when the function has scaled to zero. The block owns the
-- table it expires, so the example is self-contained; point the query at your own table to adapt it.

CREATE SCHEMA IF NOT EXISTS blocks_scheduled_cleanup;

CREATE TABLE IF NOT EXISTS blocks_scheduled_cleanup.expiring_records (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What kind of thing this is: 'trial', 'session', 'cart', or whatever the caller registers.
  -- Reported per-kind so a run says what it expired, not just how much.
  kind        text        NOT NULL CHECK (length(kind) BETWEEN 1 AND 64),

  -- The caller's own identifier for the thing (a user id, cart id, session token). Opaque here.
  reference   text        NOT NULL,

  status      text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired')),
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expired_at  timestamptz
);

-- The working index for the sweep: due, still-active records, ordered by deadline.
CREATE INDEX IF NOT EXISTS expiring_due_idx
  ON blocks_scheduled_cleanup.expiring_records (expires_at)
  WHERE status = 'active';

-- One row per run: what it scanned and expired, and the per-kind breakdown. An audit trail that
-- also answers "is the cron actually firing?".
CREATE TABLE IF NOT EXISTS blocks_scheduled_cleanup.runs (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at     timestamptz NOT NULL DEFAULT now(),
  scanned    integer     NOT NULL DEFAULT 0,
  expired    integer     NOT NULL DEFAULT 0,
  by_kind    jsonb       NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS runs_ran_at_idx ON blocks_scheduled_cleanup.runs (ran_at DESC);

-- Convention 10: is this healthy right now? "overdue" is the important signal: active records past
-- their expiry mean the cron is not firing (a common surprise, since child branches inherit
-- triggers disabled).
CREATE OR REPLACE VIEW blocks_scheduled_cleanup.v_status AS
SELECT
  (SELECT count(*) FROM blocks_scheduled_cleanup.expiring_records WHERE status = 'active')  AS active,
  (SELECT count(*) FROM blocks_scheduled_cleanup.expiring_records
     WHERE status = 'active' AND expires_at <= now())                                       AS overdue,
  (SELECT max(ran_at) FROM blocks_scheduled_cleanup.runs)                                   AS last_run_at,
  (SELECT coalesce(sum(expired), 0) FROM blocks_scheduled_cleanup.runs
     WHERE ran_at > now() - interval '24 hours')                                            AS expired_last_24h;
