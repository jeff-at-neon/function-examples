-- Block 15: pii anonymizer for branches.
--
-- The flagship branching demo. Neon branches give you a full production copy in seconds, and Object Storage branches with it — which is exactly why handing one to a contractor or pointing an AI agent at it is a data-protection problem. This turns 'a copy of prod' into 'a safe copy of prod', which is what makes the branching feature usable for the thing people most want to do with it.

CREATE SCHEMA IF NOT EXISTS blocks_pii_anonymizer;

-- One rule per column. Declared rather than discovered: a column-name heuristic that misses one
-- column gives false confidence, which is worse than no automation at all.
CREATE TABLE IF NOT EXISTS blocks_pii_anonymizer.rules (
  id            bigserial   PRIMARY KEY,
  target_schema text        NOT NULL,
  target_table  text        NOT NULL,
  target_column text        NOT NULL,

  -- How to mask. Each strategy preserves the format the application expects, because a masked email
  -- that is not a valid email fails validation and makes the branch unusable.
  strategy      text        NOT NULL,
  -- Strategy-specific options, e.g. {"domain":"example.test"} for email.
  options       jsonb       NOT NULL DEFAULT '{}'::jsonb,

  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT rules_target_uniq UNIQUE (target_schema, target_table, target_column),
  CONSTRAINT rules_strategy_valid CHECK (strategy IN (
    'email', 'phone', 'name', 'address', 'text', 'ip', 'uuid', 'date_shift', 'null_out', 'redact'
  ))
);

-- Run history. Kept because "was this branch masked, and when?" is a question people need to answer
-- with certainty before sharing access.
CREATE TABLE IF NOT EXISTS blocks_pii_anonymizer.runs (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_name   text,
  status        text        NOT NULL DEFAULT 'running',
  rules_applied integer     NOT NULL DEFAULT 0,
  rows_masked   bigint      NOT NULL DEFAULT 0,
  -- Per-rule detail, so a partial run can be understood and resumed.
  detail        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  error         text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,

  CONSTRAINT runs_status_valid CHECK (status IN ('running', 'complete', 'failed', 'refused'))
);

CREATE INDEX IF NOT EXISTS runs_started_idx ON blocks_pii_anonymizer.runs (started_at DESC);

-- ---------------------------------------------------------------------------
-- Observability (§10)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW blocks_pii_anonymizer.v_status AS
SELECT
  (SELECT count(*) FROM blocks_pii_anonymizer.rules WHERE is_active)     AS rules_active,
  (SELECT count(DISTINCT target_schema || '.' || target_table)
     FROM blocks_pii_anonymizer.rules WHERE is_active)                   AS tables_covered,
  (SELECT count(*) FROM blocks_pii_anonymizer.runs WHERE status = 'complete') AS runs_complete,
  (SELECT count(*) FROM blocks_pii_anonymizer.runs WHERE status = 'failed')   AS runs_failed,
  -- A refused run is the safety interlock working, not a fault.
  (SELECT count(*) FROM blocks_pii_anonymizer.runs WHERE status = 'refused')  AS runs_refused,
  -- Running for over an hour almost certainly means a function died mid-run, which leaves the branch
  -- PARTIALLY masked -- the most dangerous state, because it looks masked.
  (SELECT count(*) FROM blocks_pii_anonymizer.runs
     WHERE status = 'running' AND started_at < now() - interval '1 hour')  AS runs_stuck,
  (SELECT max(finished_at) FROM blocks_pii_anonymizer.runs WHERE status = 'complete')
                                                                          AS last_complete_run
;
