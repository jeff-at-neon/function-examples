-- Block 18: moderation and quarantine.
--
-- A trust-and-safety requirement for any app with user-generated content, and the one design decision that matters is fail-closed: content is quarantined until it passes, not served until it fails. Fail-open moderation means the window between upload and classification is a window in which anything can be served, and that window is exactly when abuse is posted.

CREATE SCHEMA IF NOT EXISTS blocks_moderation;

CREATE TABLE IF NOT EXISTS blocks_moderation.items (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Either a storage object or inline text. One table so the review queue and the decision history
  -- are shared rather than duplicated per content type.
  bucket_name   text,
  object_key    text,
  etag          text,
  content_text  text,

  kind          text        NOT NULL,

  -- Quarantined until proven otherwise. Fail-closed: the alternative -- serve now, remove on fail --
  -- guarantees a window in which the worst content is served, and that window is exactly when abuse
  -- is posted.
  status        text        NOT NULL DEFAULT 'quarantined',

  -- category -> 0..1. Scored independently because adult, violence, and self-harm warrant different
  -- thresholds and different escalation paths.
  scores        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- Categories that crossed their threshold.
  flagged       text[]      NOT NULL DEFAULT '{}',

  -- Modelled so the field is not silently absent, but nothing populates it: malware scanning needs a
  -- real engine and cannot be done by an LLM.
  malware_status text       NOT NULL DEFAULT 'unscanned',

  model         text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,

  CONSTRAINT items_kind_valid CHECK (kind IN ('image', 'video', 'text', 'document', 'other')),
  CONSTRAINT items_status_valid
    CHECK (status IN ('quarantined', 'scanning', 'approved', 'blocked', 'needs_review', 'failed')),
  CONSTRAINT items_malware_valid
    CHECK (malware_status IN ('unscanned', 'clean', 'infected', 'scan_failed')),
  -- Either an object or text, never neither.
  CONSTRAINT items_has_content CHECK (object_key IS NOT NULL OR content_text IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS items_status_idx ON blocks_moderation.items (status, created_at);
CREATE INDEX IF NOT EXISTS items_object_idx ON blocks_moderation.items (bucket_name, object_key);
CREATE INDEX IF NOT EXISTS items_flagged_idx ON blocks_moderation.items USING gin (flagged);
-- Serves the "what is stuck in quarantine?" question, which is the operational one.
CREATE INDEX IF NOT EXISTS items_quarantined_idx
  ON blocks_moderation.items (created_at) WHERE status IN ('quarantined', 'needs_review');

-- Decision history. A human decision always beats a model score and is recorded as such: appeals
-- exist, models are wrong, and "a human approved this on the 14th" is what you need when a decision
-- is challenged.
CREATE TABLE IF NOT EXISTS blocks_moderation.decisions (
  id          bigserial   PRIMARY KEY,
  item_id     uuid        NOT NULL REFERENCES blocks_moderation.items(id) ON DELETE CASCADE,
  decision    text        NOT NULL,
  -- 'model' or 'human'. The distinction is the audit trail.
  source      text        NOT NULL,
  actor       text,
  reason      text,
  decided_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT decisions_decision_valid CHECK (decision IN ('approve', 'block', 'escalate')),
  CONSTRAINT decisions_source_valid CHECK (source IN ('model', 'human'))
);

CREATE INDEX IF NOT EXISTS decisions_item_idx ON blocks_moderation.decisions (item_id, decided_at);

-- ---------------------------------------------------------------------------
-- Observability (§10)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW blocks_moderation.v_status AS
SELECT
  count(*)                                              AS items_total,
  count(*) FILTER (WHERE status = 'quarantined')         AS items_quarantined,
  count(*) FILTER (WHERE status = 'approved')            AS items_approved,
  count(*) FILTER (WHERE status = 'blocked')             AS items_blocked,
  count(*) FILTER (WHERE status = 'needs_review')        AS items_needs_review,
  count(*) FILTER (WHERE status = 'failed')              AS items_failed,

  -- Quarantined for over an hour. Because this block fails closed, a stuck item is a user's upload
  -- that never appeared -- a functional bug, not a safety one.
  count(*) FILTER (WHERE status IN ('quarantined', 'scanning')
                     AND created_at < now() - interval '1 hour') AS items_stuck,
  count(*) FILTER (WHERE malware_status = 'infected')    AS items_infected,
  -- Nothing populates malware scanning yet, so this counts everything. Surfaced rather than hidden.
  count(*) FILTER (WHERE malware_status = 'unscanned')   AS items_unscanned,
  (SELECT count(*) FROM blocks_moderation.decisions WHERE source = 'human') AS human_decisions
FROM blocks_moderation.items
;
