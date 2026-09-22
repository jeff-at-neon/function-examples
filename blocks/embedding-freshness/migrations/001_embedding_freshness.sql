-- Block 14: embedding freshness worker.
--
-- Stale vectors are pgvector's number one failure mode: text is edited, the embedding is not regenerated, and search silently returns the old meaning. Nothing errors, so nobody notices until a user reports that search is 'wrong'. This is also the block that row-event triggers would most improve — see docs/ROW_EVENTS.md, where it moves from rank 14 to about 6.

CREATE SCHEMA IF NOT EXISTS blocks_embedding_freshness;

-- A registered source of embeddable text. Generic so the block works against user tables, not just
-- the rag block's corpus.
CREATE TABLE IF NOT EXISTS blocks_embedding_freshness.sources (
  code            text        PRIMARY KEY,
  source_schema   text        NOT NULL,
  source_table    text        NOT NULL,
  -- Primary key column, for identifying rows.
  key_column      text        NOT NULL DEFAULT 'id',
  -- Columns concatenated to form the embedded text.
  text_columns    text[]      NOT NULL,
  -- Column compared against the watermark. NULL means this source is outbox-driven only.
  updated_column  text,
  -- Where the vector lives. Usually the same table.
  vector_schema   text        NOT NULL,
  vector_table    text        NOT NULL,
  vector_column   text        NOT NULL DEFAULT 'embedding',

  -- High-water mark. Rows with updated_column beyond this are candidates.
  watermark       timestamptz NOT NULL DEFAULT '-infinity',
  is_active       boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sources_text_columns_present CHECK (cardinality(text_columns) >= 1)
);

-- Hash of the text that was actually embedded, per row. This is what stops an updated_at bump from
-- an unrelated column change from triggering a paid re-embed.
CREATE TABLE IF NOT EXISTS blocks_embedding_freshness.embedded_state (
  source_code   text        NOT NULL REFERENCES blocks_embedding_freshness.sources(code) ON DELETE CASCADE,
  row_key       text        NOT NULL,
  content_hash  text        NOT NULL,
  model         text        NOT NULL,
  embedded_at   timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (source_code, row_key)
);

CREATE INDEX IF NOT EXISTS embedded_state_model_idx
  ON blocks_embedding_freshness.embedded_state (source_code, model);

-- Rows known to need re-embedding. Queued rather than embedded inline, because a bulk update
-- touching 50,000 rows must not attempt 50,000 model calls in one invocation.
CREATE TABLE IF NOT EXISTS blocks_embedding_freshness.pending (
  source_code   text        NOT NULL REFERENCES blocks_embedding_freshness.sources(code) ON DELETE CASCADE,
  row_key       text        NOT NULL,
  reason        text        NOT NULL,
  detected_at   timestamptz NOT NULL DEFAULT now(),
  attempts      integer     NOT NULL DEFAULT 0,
  last_error    text,

  PRIMARY KEY (source_code, row_key)
);

CREATE INDEX IF NOT EXISTS pending_detected_idx ON blocks_embedding_freshness.pending (detected_at);

-- ---------------------------------------------------------------------------
-- Observability (§10)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW blocks_embedding_freshness.v_status AS
SELECT
  (SELECT count(*) FROM blocks_embedding_freshness.sources WHERE is_active) AS sources_active,
  (SELECT count(*) FROM blocks_embedding_freshness.embedded_state)          AS rows_embedded,
  (SELECT count(*) FROM blocks_embedding_freshness.pending)                 AS rows_pending,
  -- Pending for over an hour means the worker is not keeping up, and those vectors are stale right
  -- now -- search is silently returning old meanings.
  (SELECT count(*) FROM blocks_embedding_freshness.pending
     WHERE detected_at < now() - interval '1 hour')                         AS rows_stale_over_hour,
  (SELECT count(*) FROM blocks_embedding_freshness.pending WHERE attempts >= 3) AS rows_failing,
  -- More than one model in use means vectors in the index are not mutually comparable.
  (SELECT count(DISTINCT model) FROM blocks_embedding_freshness.embedded_state) AS models_in_use,
  (SELECT COALESCE(EXTRACT(EPOCH FROM (now() - min(watermark)))::bigint, 0)
     FROM blocks_embedding_freshness.sources WHERE is_active
       AND watermark > '-infinity')                                         AS oldest_watermark_seconds
;
