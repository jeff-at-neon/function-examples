-- Block 7: hybrid search.
--
-- This block owns no content table. It searches whatever the RAG block ingested
-- (blocks_rag.chunks) and records queries for relevance tuning. That is a deliberate exception to
-- the "never reference another block's schema" rule, declared via dependsOn: hybrid search over
-- your own copy of the corpus would mean duplicating every embedding.
--
-- What it adds is the indexes and extensions that retrieval needs but ingestion does not.

CREATE SCHEMA IF NOT EXISTS blocks_hybrid_search;

-- Trigram matching, for typo tolerance ("recieve" -> "receive"). Full-text search cannot do this:
-- to_tsvector stems words but has no notion of near-misses.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Accent-insensitive matching, so "resume" finds "résumé".
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Query log. The point is relevance work: you cannot tune a ranking you have not measured, and
-- "zero results" queries are the single most actionable signal a search system produces.
CREATE TABLE IF NOT EXISTS blocks_hybrid_search.queries (
  id            bigserial   PRIMARY KEY,
  query_text    text        NOT NULL,
  -- Which retrievers ran, and their weights, so a ranking change can be correlated with a config
  -- change rather than guessed at.
  retrievers    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  result_count  integer     NOT NULL DEFAULT 0,
  duration_ms   integer,
  tenant        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS queries_created_idx ON blocks_hybrid_search.queries (created_at DESC);
-- Partial index on the failures, which is what you actually review.
CREATE INDEX IF NOT EXISTS queries_zero_result_idx
  ON blocks_hybrid_search.queries (created_at DESC)
  WHERE result_count = 0;

-- Click-through, for measuring whether a ranking change helped. Optional to record.
CREATE TABLE IF NOT EXISTS blocks_hybrid_search.clicks (
  id          bigserial   PRIMARY KEY,
  query_id    bigint      NOT NULL REFERENCES blocks_hybrid_search.queries(id) ON DELETE CASCADE,
  chunk_id    bigint      NOT NULL,
  -- 1-based position of the clicked result. Position bias means rank 1 gets clicked far more than
  -- rank 10 regardless of quality, so relevance conclusions need this to be meaningful.
  rank        integer     NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS clicks_query_idx ON blocks_hybrid_search.clicks (query_id);

-- ---------------------------------------------------------------------------
-- Indexes on the corpus
-- ---------------------------------------------------------------------------
-- Created here rather than in the RAG block because they serve retrieval, not ingestion, and a
-- user who only ingests should not pay to maintain them. Guarded so this migration still applies
-- when the RAG block is not installed.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'blocks_rag' AND table_name = 'chunks'
  ) THEN
    -- GIN over trigrams. Expensive to build and maintain, which is why trigram matching is applied
    -- selectively to short queries at search time.
    CREATE INDEX IF NOT EXISTS chunks_content_trgm_idx
      ON blocks_rag.chunks USING gin (content gin_trgm_ops);
  ELSE
    RAISE NOTICE 'blocks_rag.chunks not found; install the rag block, then re-run this migration '
                 'to add the trigram index.';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Observability (§10)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW blocks_hybrid_search.v_zero_result_queries AS
SELECT query_text, count(*) AS occurrences, max(created_at) AS most_recent
FROM blocks_hybrid_search.queries
WHERE result_count = 0
GROUP BY query_text
ORDER BY occurrences DESC, most_recent DESC;

COMMENT ON VIEW blocks_hybrid_search.v_zero_result_queries IS
  'Queries that returned nothing, most frequent first. The most actionable signal in search: each '
  'row is either missing content or a retrieval gap.';

CREATE OR REPLACE VIEW blocks_hybrid_search.v_status AS
SELECT
  count(*)                                                       AS queries_total,
  count(*) FILTER (WHERE created_at > now() - interval '1 hour')  AS queries_last_hour,
  count(*) FILTER (WHERE result_count = 0)                        AS queries_zero_result,

  -- Ratio is what matters, not the raw count: a handful of empty results is normal, a third of all
  -- queries returning nothing means the corpus or the retrieval is wrong.
  ROUND(
    100.0 * count(*) FILTER (WHERE result_count = 0) / GREATEST(count(*), 1), 1
  )                                                              AS zero_result_pct,

  COALESCE(percentile_disc(0.5) WITHIN GROUP (ORDER BY duration_ms), 0)  AS p50_duration_ms,
  COALESCE(percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms), 0) AS p95_duration_ms,
  (SELECT count(*) FROM blocks_hybrid_search.clicks)             AS clicks_total
FROM blocks_hybrid_search.queries;
