-- Block 16: structured document extraction.
--
-- High willingness to pay, because the alternative is someone typing invoice totals into a form. The part that makes it usable in production is not the extraction -- it is the confidence scoring and the review queue. An extraction system with no review step either needs a human to check everything, which defeats the purpose, or silently books wrong numbers.

CREATE SCHEMA IF NOT EXISTS blocks_doc_extraction;

-- What to extract, per document type. Declared rather than inferred so a missing field is a
-- detectable error rather than an absent key nobody notices.
CREATE TABLE IF NOT EXISTS blocks_doc_extraction.schemas (
  code        text        PRIMARY KEY,
  description text,
  -- field name -> {type, required, description}. The description is sent to the model, so it is
  -- prompt text as much as documentation.
  fields      jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS blocks_doc_extraction.extractions (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_name   text        NOT NULL,
  object_key    text        NOT NULL,
  -- Each extraction is a paid model call, so identity includes the etag: an unchanged document is
  -- never re-extracted, an overwritten one always is.
  etag          text        NOT NULL,
  schema_code   text        REFERENCES blocks_doc_extraction.schemas(code),

  status        text        NOT NULL DEFAULT 'pending',
  -- field -> value, as extracted.
  extracted     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- field -> 0..1. Per field, not per document: an invoice with a certain total and a guessed tax
  -- line needs the tax line reviewed and nothing else.
  confidence    jsonb       NOT NULL DEFAULT '{}'::jsonb,

  model         text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  extracted_at  timestamptz,

  CONSTRAINT extractions_status_valid
    CHECK (status IN ('pending', 'extracting', 'ready', 'needs_review', 'failed', 'skipped')),
  CONSTRAINT extractions_identity UNIQUE (bucket_name, object_key, etag)
);

CREATE INDEX IF NOT EXISTS extractions_status_idx
  ON blocks_doc_extraction.extractions (status, created_at);

-- One row per field needing human attention. Queued per field so a reviewer corrects the tax line
-- without re-entering the whole invoice.
CREATE TABLE IF NOT EXISTS blocks_doc_extraction.review_queue (
  id            bigserial   PRIMARY KEY,
  extraction_id uuid        NOT NULL REFERENCES blocks_doc_extraction.extractions(id) ON DELETE CASCADE,
  field_name    text        NOT NULL,
  extracted_value text,
  confidence    real,

  -- The human's answer. Stored ALONGSIDE the extraction, never overwriting it: the pair is training
  -- data and an audit trail for when the numbers are disputed.
  corrected_value text,
  reviewed_by   text,
  reviewed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT review_field_once UNIQUE (extraction_id, field_name)
);

CREATE INDEX IF NOT EXISTS review_pending_idx
  ON blocks_doc_extraction.review_queue (confidence NULLS FIRST, created_at)
  WHERE reviewed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Observability (§10)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW blocks_doc_extraction.v_status AS
SELECT
  count(*)                                              AS extractions_total,
  count(*) FILTER (WHERE status = 'ready')               AS extractions_ready,
  count(*) FILTER (WHERE status = 'needs_review')        AS extractions_needs_review,
  count(*) FILTER (WHERE status = 'failed')              AS extractions_failed,
  count(*) FILTER (WHERE status IN ('pending', 'extracting')
                     AND updated_at < now() - interval '1 hour') AS extractions_stuck,
  (SELECT count(*) FROM blocks_doc_extraction.review_queue WHERE reviewed_at IS NULL)
                                                        AS review_pending,
  -- Ageing review items are the real operational signal: an extraction pipeline whose review queue
  -- is never worked is just a slower manual process.
  (SELECT count(*) FROM blocks_doc_extraction.review_queue
     WHERE reviewed_at IS NULL AND created_at < now() - interval '7 days') AS review_stale,
  (SELECT count(*) FROM blocks_doc_extraction.review_queue WHERE reviewed_at IS NOT NULL)
                                                        AS review_completed,
  (SELECT count(*) FROM blocks_doc_extraction.schemas)   AS schemas_count
FROM blocks_doc_extraction.extractions
;
