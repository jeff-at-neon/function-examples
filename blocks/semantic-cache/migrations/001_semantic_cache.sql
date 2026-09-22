-- Block 20: semantic cache for llm calls.
--
-- Cuts AI spend on repeated questions. An exact-match cache misses almost everything, because nobody asks the same question the same way twice -- similarity matching is what makes a cache hit at all.

CREATE SCHEMA IF NOT EXISTS blocks_semantic_cache;

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS blocks_semantic_cache.entries (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Keeps prompts separate. A cached answer for one system prompt or tenant must never serve
  -- another: conflating them is a cross-tenant data leak wearing a performance improvement.
  namespace     text        NOT NULL DEFAULT 'default',

  prompt        text        NOT NULL,
  -- Exact-match fast path. Cheap to check and skips the embedding call entirely on a repeat.
  prompt_hash   text        NOT NULL,
  prompt_embedding vector(1536),

  response      text        NOT NULL,
  -- Part of the key, not metadata: a response from a weaker model must not be served as if it came
  -- from a stronger one.
  model         text        NOT NULL,

  -- What the original call cost, so savings can be measured. A cache nobody can measure gets
  -- removed during the next cleanup.
  prompt_tokens integer,
  completion_tokens integer,

  hit_count     integer     NOT NULL DEFAULT 0,
  last_hit_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,

  CONSTRAINT entries_namespace_hash_model_uniq UNIQUE (namespace, prompt_hash, model)
);

CREATE INDEX IF NOT EXISTS entries_expiry_idx ON blocks_semantic_cache.entries (expires_at);
CREATE INDEX IF NOT EXISTS entries_namespace_idx ON blocks_semantic_cache.entries (namespace, model);

-- HNSW over cosine distance. No training step, so it works on an empty table -- unlike IVFFlat,
-- which silently performs terribly when built before any rows exist.
CREATE INDEX IF NOT EXISTS entries_embedding_idx
  ON blocks_semantic_cache.entries USING hnsw (prompt_embedding vector_cosine_ops);

-- Hit and miss counters. Aggregated rather than per-request rows: the cache exists to save money,
-- and logging every lookup would add write volume to the path meant to be cheap.
CREATE TABLE IF NOT EXISTS blocks_semantic_cache.stats (
  namespace     text        NOT NULL,
  day           date        NOT NULL,
  hits          bigint      NOT NULL DEFAULT 0,
  misses        bigint      NOT NULL DEFAULT 0,
  -- Tokens the cache avoided spending. The number that justifies keeping it.
  tokens_saved  bigint      NOT NULL DEFAULT 0,

  PRIMARY KEY (namespace, day)
);

-- ---------------------------------------------------------------------------
-- Observability (§10)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW blocks_semantic_cache.v_status AS
SELECT
  (SELECT count(*) FROM blocks_semantic_cache.entries)                  AS entries_total,
  (SELECT count(*) FROM blocks_semantic_cache.entries WHERE expires_at > now())
                                                                        AS entries_live,
  -- Expired but not swept. A growing number means the sweeper is not running.
  (SELECT count(*) FROM blocks_semantic_cache.entries WHERE expires_at <= now())
                                                                        AS entries_expired,
  -- Entries with no vector can never be matched by similarity, only by exact hash.
  (SELECT count(*) FROM blocks_semantic_cache.entries WHERE prompt_embedding IS NULL)
                                                                        AS entries_unembedded,
  (SELECT COALESCE(sum(hits), 0) FROM blocks_semantic_cache.stats)      AS hits_total,
  (SELECT COALESCE(sum(misses), 0) FROM blocks_semantic_cache.stats)    AS misses_total,
  -- The number that decides whether this block is worth keeping.
  (SELECT COALESCE(round(100.0 * sum(hits) / GREATEST(sum(hits) + sum(misses), 1), 1), 0)
     FROM blocks_semantic_cache.stats)                                  AS hit_rate_pct,
  (SELECT COALESCE(sum(tokens_saved), 0) FROM blocks_semantic_cache.stats) AS tokens_saved,
  (SELECT count(DISTINCT model) FROM blocks_semantic_cache.entries)      AS models_cached
;
