-- Block 9: AI vision enrichment.
--
-- Network-bound, so it bills at the waiting rate ($0.025/Capacity-Hour) rather than the active rate
-- -- the function is idle while the model works. That makes this one of the cheapest blocks to run
-- per unit of value, and it is why it is ranked above the CPU-bound image work in block 23.

CREATE SCHEMA IF NOT EXISTS blocks_vision;

CREATE TABLE IF NOT EXISTS blocks_vision.analyses (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_name    text        NOT NULL,
  object_key     text        NOT NULL,

  -- Re-analysing costs a model call, so identity includes the etag: an unchanged image is never
  -- re-analysed, an overwritten one always is.
  etag           text        NOT NULL,

  status         text        NOT NULL DEFAULT 'pending',

  tags           text[]      NOT NULL DEFAULT '{}',
  caption        text,

  -- Kept nullable AND allowed to be empty: alt = '' is correct markup for a decorative image and
  -- is different from having no alt text at all. Collapsing the two is an accessibility regression.
  alt_text       text,

  ocr_text       text,
  dominant_colors text[]     NOT NULL DEFAULT '{}',

  confidence     real,
  model          text,
  error          text,

  created_at     timestamptz NOT NULL DEFAULT now(),
  analyzed_at    timestamptz,

  CONSTRAINT analyses_status_valid CHECK (status IN ('pending', 'ready', 'failed', 'skipped')),
  CONSTRAINT analyses_identity UNIQUE (bucket_name, object_key, etag)
);

CREATE INDEX IF NOT EXISTS analyses_status_idx ON blocks_vision.analyses (status, created_at);
CREATE INDEX IF NOT EXISTS analyses_object_idx ON blocks_vision.analyses (bucket_name, object_key);

-- GIN over tags, so "every image tagged 'invoice'" is an index lookup rather than a scan. This is
-- the query that makes the block worth having: images become searchable.
CREATE INDEX IF NOT EXISTS analyses_tags_idx ON blocks_vision.analyses USING gin (tags);

-- Full-text over OCR output plus caption, so text *inside* images becomes searchable. Generated so
-- it cannot drift from its sources.
ALTER TABLE blocks_vision.analyses
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(ocr_text, '') || ' ' || coalesce(caption, ''))
  ) STORED;

CREATE INDEX IF NOT EXISTS analyses_search_idx ON blocks_vision.analyses USING gin (search_tsv);

-- ---------------------------------------------------------------------------
-- Observability (§10)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW blocks_vision.v_tag_frequency AS
SELECT unnest(tags) AS tag, count(*) AS images
FROM blocks_vision.analyses
WHERE status = 'ready'
GROUP BY tag
ORDER BY images DESC;

CREATE OR REPLACE VIEW blocks_vision.v_status AS
SELECT
  count(*)                                          AS analyses_total,
  count(*) FILTER (WHERE status = 'ready')           AS analyses_ready,
  count(*) FILTER (WHERE status = 'pending')         AS analyses_pending,
  count(*) FILTER (WHERE status = 'failed')          AS analyses_failed,
  count(*) FILTER (WHERE status = 'skipped')         AS analyses_skipped,

  -- Images with no alt text at all. This is the accessibility gap the block exists to close, so it
  -- is surfaced directly rather than inferred. Empty-string alt text is deliberately NOT counted
  -- here: that is a valid decorative marking, not a gap.
  count(*) FILTER (WHERE status = 'ready' AND alt_text IS NULL) AS missing_alt_text,

  count(*) FILTER (WHERE status = 'ready' AND ocr_text IS NOT NULL) AS with_ocr_text,
  COALESCE(round(avg(confidence)::numeric, 2), 0)    AS mean_confidence,
  -- Low-confidence results are where a human review queue should look first.
  count(*) FILTER (WHERE confidence < 0.5)           AS low_confidence,
  (SELECT count(DISTINCT model) FROM blocks_vision.analyses WHERE model IS NOT NULL) AS models_used
FROM blocks_vision.analyses;
