-- Block 17: compliance pack.
--
-- The audit log is the part that is hard to retrofit, which is the reason to have it early. An audit trail added after the fact covers only what the application remembers to log; a trigger-based one captures writes from any client including psql, which is what auditors actually ask about. Row-event triggers would make this considerably better -- see docs/ROW_EVENTS.md.

CREATE SCHEMA IF NOT EXISTS blocks_compliance;

-- The audit log. Append-only by intent and by convention; the chain below makes violations
-- detectable rather than merely forbidden.
CREATE TABLE IF NOT EXISTS blocks_compliance.audit_log (
  id            bigserial   PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),

  -- Who and what. actor is set from a session variable, so it survives writes made outside the
  -- application -- which is exactly the case an auditor asks about.
  actor         text,
  action        text        NOT NULL,
  target_schema text        NOT NULL,
  target_table  text        NOT NULL,
  target_id     text,

  old_row       jsonb,
  new_row       jsonb,

  -- Hash of this entry's content plus the previous entry's hash. Deleting or editing history breaks
  -- the chain detectably; without it, an audit log is only as trustworthy as whoever has table
  -- access, who is precisely the person being audited.
  entry_hash    text,
  prev_hash     text,

  CONSTRAINT audit_action_valid CHECK (action IN ('insert', 'update', 'delete'))
);

CREATE INDEX IF NOT EXISTS audit_occurred_idx ON blocks_compliance.audit_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_target_idx
  ON blocks_compliance.audit_log (target_schema, target_table, target_id);
CREATE INDEX IF NOT EXISTS audit_actor_idx ON blocks_compliance.audit_log (actor, occurred_at DESC);

-- Which tables hold data for a data subject, and how to find it. Declared so adding a table to an
-- export is configuration rather than code: an export that silently misses a table is a compliance
-- failure that looks like success.
CREATE TABLE IF NOT EXISTS blocks_compliance.subject_links (
  id            bigserial   PRIMARY KEY,
  target_schema text        NOT NULL,
  target_table  text        NOT NULL,
  -- Column holding the subject identifier.
  subject_column text       NOT NULL,
  -- 'export' includes it in exports; 'erase' also hard-deletes it; 'anonymize' masks in place, for
  -- rows that must survive for accounting reasons.
  handling      text        NOT NULL DEFAULT 'export',

  CONSTRAINT subject_links_uniq UNIQUE (target_schema, target_table, subject_column),
  CONSTRAINT subject_links_handling_valid CHECK (handling IN ('export', 'erase', 'anonymize'))
);

-- Erasure and export requests, with an audit trail of their own. Regulators ask when a request was
-- received and when it was satisfied, so both timestamps are recorded.
CREATE TABLE IF NOT EXISTS blocks_compliance.subject_requests (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_ref   text        NOT NULL,
  kind          text        NOT NULL,
  status        text        NOT NULL DEFAULT 'pending',

  -- Per-table counts, so a partial completion can be understood rather than guessed at.
  detail        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  error         text,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,

  CONSTRAINT subject_requests_kind_valid CHECK (kind IN ('export', 'erase')),
  CONSTRAINT subject_requests_status_valid
    CHECK (status IN ('pending', 'running', 'complete', 'failed'))
);

CREATE INDEX IF NOT EXISTS subject_requests_pending_idx
  ON blocks_compliance.subject_requests (requested_at) WHERE status IN ('pending', 'running');

-- Suspends purge for data under litigation. Declared here; enforcement is a TODO, and that gap is
-- the difference between a retention policy and a compliance control.
CREATE TABLE IF NOT EXISTS blocks_compliance.legal_holds (
  id            bigserial   PRIMARY KEY,
  subject_ref   text,
  target_schema text,
  target_table  text,
  reason        text        NOT NULL,
  placed_by     text,
  placed_at     timestamptz NOT NULL DEFAULT now(),
  released_at   timestamptz
);

CREATE INDEX IF NOT EXISTS legal_holds_active_idx
  ON blocks_compliance.legal_holds (subject_ref) WHERE released_at IS NULL;

-- ---------------------------------------------------------------------------
-- Capture trigger
-- ---------------------------------------------------------------------------
-- Attach to your own tables. Captures writes from ANY client, including a human at a psql prompt --
-- application-level logging misses exactly the events an auditor cares about.

CREATE OR REPLACE FUNCTION blocks_compliance.audit_row_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_key_column text := COALESCE(TG_ARGV[0], 'id');
  v_old        jsonb;
  v_new        jsonb;
  v_target_id  text;
  v_prev_hash  text;
  v_entry_hash text;
  v_actor      text;
BEGIN
  v_old := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  v_new := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  v_target_id := COALESCE(v_new ->> v_key_column, v_old ->> v_key_column);

  -- Set by the application with SET LOCAL. Falls back to the database user, which is still useful:
  -- an unattributed write by 'postgres' is itself an audit finding.
  v_actor := COALESCE(
    current_setting('blocks_compliance.actor', true),
    session_user
  );

  -- Chain to the previous entry. FOR UPDATE serialises audit writes, which is the cost of making
  -- tampering detectable -- acceptable at audit volumes, not if you audit every read.
  SELECT entry_hash INTO v_prev_hash
  FROM blocks_compliance.audit_log
  ORDER BY id DESC LIMIT 1
  FOR UPDATE;

  v_entry_hash := encode(
    sha256(
      convert_to(
        COALESCE(v_prev_hash, '') || TG_OP || TG_TABLE_SCHEMA || TG_TABLE_NAME ||
        COALESCE(v_target_id, '') || COALESCE(v_old::text, '') || COALESCE(v_new::text, '') ||
        COALESCE(v_actor, ''),
        'UTF8'
      )
    ),
    'hex'
  );

  INSERT INTO blocks_compliance.audit_log
    (actor, action, target_schema, target_table, target_id, old_row, new_row, entry_hash, prev_hash)
  VALUES
    (v_actor, lower(TG_OP), TG_TABLE_SCHEMA, TG_TABLE_NAME, v_target_id,
     v_old, v_new, v_entry_hash, v_prev_hash);

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION blocks_compliance.audit_row_trigger() IS
  'Captures row changes into the hash-chained audit log. Attach with attach_audit_trigger().';

CREATE OR REPLACE FUNCTION blocks_compliance.attach_audit_trigger(
  p_schema     text,
  p_table      text,
  p_key_column text DEFAULT 'id'
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_trigger_name text := 'blocks_audit_' || p_table;
BEGIN
  -- format() with %I quotes identifiers, so a hostile or awkward table name cannot break out.
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I.%I', v_trigger_name, p_schema, p_table);
  EXECUTE format(
    'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I.%I '
    'FOR EACH ROW EXECUTE FUNCTION blocks_compliance.audit_row_trigger(%L)',
    v_trigger_name, p_schema, p_table, p_key_column
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Observability (§10)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW blocks_compliance.v_status AS
SELECT
  (SELECT count(*) FROM blocks_compliance.audit_log)                    AS audit_entries,
  (SELECT count(*) FROM blocks_compliance.audit_log
     WHERE occurred_at > now() - interval '1 day')                      AS audit_entries_last_day,
  -- Entries with no hash. Either chaining was disabled, or someone inserted directly -- both worth
  -- knowing about, because the chain cannot be verified across a gap.
  (SELECT count(*) FROM blocks_compliance.audit_log WHERE entry_hash IS NULL) AS audit_unchained,
  (SELECT count(*) FROM blocks_compliance.subject_links)                AS subject_links,
  (SELECT count(*) FROM blocks_compliance.subject_requests
     WHERE status IN ('pending', 'running'))                            AS requests_open,
  -- GDPR gives a one-month deadline. An open request past 30 days is a regulatory exposure, not a
  -- backlog item.
  (SELECT count(*) FROM blocks_compliance.subject_requests
     WHERE status IN ('pending', 'running')
       AND requested_at < now() - interval '30 days')                   AS requests_overdue,
  (SELECT count(*) FROM blocks_compliance.subject_requests WHERE status = 'failed')
                                                                        AS requests_failed,
  (SELECT count(*) FROM blocks_compliance.legal_holds WHERE released_at IS NULL)
                                                                        AS legal_holds_active
;
