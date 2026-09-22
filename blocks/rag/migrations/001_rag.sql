-- Block 2: document → RAG ingestion.
--
-- Two tables: documents (one row per ingested object) and chunks (the embedded pieces).
-- Split rather than combined because re-chunking a document replaces all its chunks while the
-- document row, its status history, and its error state survive.

CREATE SCHEMA IF NOT EXISTS blocks_rag;

-- pgvector is the whole point of this block. Fail loudly and early if it is unavailable rather
-- than at the first INSERT.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS blocks_rag.documents (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_name      text        NOT NULL,
  object_key       text        NOT NULL,

  -- The other half of the idempotency contract. Overwriting an object re-fires the trigger
  -- with new content, so keying on object_key alone would serve stale embeddings forever.
  etag             text        NOT NULL,

  content_type     text,
  size_bytes       bigint,
  -- SHA-256 of extracted text. Lets a re-upload of identical content skip embedding entirely,
  -- which is the difference between a cheap no-op and paying to re-embed a 200-page PDF.
  content_hash     text,

  status           text        NOT NULL DEFAULT 'pending',
  kind             text,
  chunk_count      integer     NOT NULL DEFAULT 0,
  token_estimate   integer,
  embedding_model  text,
  error            text,

  -- Set by the reconciliation sweeper when an object vanishes from the bucket. There are no
  -- storage delete events, so without this pass orphaned rows are permanent.
  deleted_at       timestamptz,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  ingested_at      timestamptz,

  CONSTRAINT documents_status_valid
    CHECK (status IN ('pending', 'extracting', 'embedding', 'ready', 'failed', 'skipped', 'deleted')),
  CONSTRAINT documents_identity UNIQUE (bucket_name, object_key, etag)
);

CREATE INDEX IF NOT EXISTS documents_status_idx ON blocks_rag.documents (status, created_at);
CREATE INDEX IF NOT EXISTS documents_object_idx ON blocks_rag.documents (bucket_name, object_key);
CREATE INDEX IF NOT EXISTS documents_hash_idx
  ON blocks_rag.documents (content_hash) WHERE content_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS blocks_rag.chunks (
  id              bigserial   PRIMARY KEY,
  document_id     uuid        NOT NULL REFERENCES blocks_rag.documents(id) ON DELETE CASCADE,
  chunk_index     integer     NOT NULL,
  content         text        NOT NULL,

  -- Character offsets in the extracted text, for citation and highlighting. Without these a
  -- retrieved chunk can be shown but not located in the source.
  start_offset    integer     NOT NULL DEFAULT 0,
  end_offset      integer     NOT NULL DEFAULT 0,

  -- 1536 matches text-embedding-3-small. Changing the model means changing this column, which
  -- is a migration and not a config change -- see RAG_EMBEDDING_DIMENSIONS.
  embedding       vector(1536),

  token_estimate  integer,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chunks_unique_per_document UNIQUE (document_id, chunk_index)
);

-- Full-text column maintained by Postgres, not the application. Generated so it cannot drift
-- from `content`, and present here so the hybrid-search block (rank 7) has a BM25 side to fuse
-- with the vector side.
ALTER TABLE blocks_rag.chunks
  ADD COLUMN IF NOT EXISTS content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON blocks_rag.chunks USING gin (content_tsv);
CREATE INDEX IF NOT EXISTS chunks_document_idx ON blocks_rag.chunks (document_id, chunk_index);

-- HNSW over cosine distance: better recall/latency than IVFFlat and, critically, it needs no
-- training step, so it works on an empty table. An IVFFlat index built before any rows exist
-- silently performs terribly.
CREATE INDEX IF NOT EXISTS chunks_embedding_idx
  ON blocks_rag.chunks USING hnsw (embedding vector_cosine_ops);

CREATE OR REPLACE FUNCTION blocks_rag.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS documents_touch ON blocks_rag.documents;
CREATE TRIGGER documents_touch
  BEFORE UPDATE ON blocks_rag.documents
  FOR EACH ROW EXECUTE FUNCTION blocks_rag.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Observability (§10)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW blocks_rag.v_status AS
SELECT
  count(*)                                                      AS documents_total,
  count(*) FILTER (WHERE status = 'ready')                       AS documents_ready,
  count(*) FILTER (WHERE status = 'pending')                     AS documents_pending,
  count(*) FILTER (WHERE status = 'failed')                      AS documents_failed,
  count(*) FILTER (WHERE status = 'skipped')                     AS documents_skipped,
  count(*) FILTER (WHERE deleted_at IS NOT NULL)                 AS documents_deleted,

  -- Stuck mid-pipeline for over an hour: almost always a function that died between
  -- 'extracting' and 'ready', which the reconciler is responsible for retrying.
  count(*) FILTER (
    WHERE status IN ('extracting', 'embedding') AND updated_at < now() - interval '1 hour'
  )                                                              AS documents_stuck,

  (SELECT count(*) FROM blocks_rag.chunks)                       AS chunks_total,
  -- Chunks with no vector cannot be retrieved. A non-zero count here means embedding failed
  -- partway, and the block looks healthy while being partly useless.
  (SELECT count(*) FROM blocks_rag.chunks WHERE embedding IS NULL) AS chunks_unembedded,
  (SELECT count(DISTINCT embedding_model) FROM blocks_rag.documents
     WHERE embedding_model IS NOT NULL)                          AS embedding_models_in_use
FROM blocks_rag.documents;

COMMENT ON VIEW blocks_rag.v_status IS
  'Health summary. embedding_models_in_use > 1 means vectors in this table are not mutually '
  'comparable and search quality is silently degraded.';
