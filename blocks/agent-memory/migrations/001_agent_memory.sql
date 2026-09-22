-- Block 21: agent memory store.
--
-- Rides the agent wave, and Neon already pitches Functions for agent tool-loops. The real problem is not storing messages — it is that a conversation outgrows the context window, and naive truncation drops the beginning, which is usually where the task was defined. Compaction plus retrieval is what keeps an agent coherent past a few dozen turns.

CREATE SCHEMA IF NOT EXISTS blocks_agent_memory;

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS blocks_agent_memory.sessions (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Namespaced by agent and owner. Two agents sharing a store would cross-contaminate, and one
  -- tenant retrieving another's turns is a data leak rather than a quirk.
  agent_code    text        NOT NULL,
  owner_ref     text        NOT NULL,

  title         text,
  -- Running total, maintained on insert. Deciding when to compact needs this, and recomputing it
  -- from text every turn is both slow and approximate.
  total_tokens  integer     NOT NULL DEFAULT 0,
  turn_count    integer     NOT NULL DEFAULT 0,

  -- Set when compaction has run at least once, so the retrieval path knows summaries exist.
  compacted_through_turn integer NOT NULL DEFAULT 0,
  last_compacted_at timestamptz,

  status        text        NOT NULL DEFAULT 'active',
  expires_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sessions_status_valid CHECK (status IN ('active', 'archived'))
);

CREATE INDEX IF NOT EXISTS sessions_owner_idx
  ON blocks_agent_memory.sessions (agent_code, owner_ref, updated_at DESC);
-- Serves the compaction sweeper without scanning sessions that are comfortably small.
CREATE INDEX IF NOT EXISTS sessions_compact_idx
  ON blocks_agent_memory.sessions (total_tokens DESC) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS blocks_agent_memory.turns (
  id            bigserial   PRIMARY KEY,
  session_id    uuid        NOT NULL REFERENCES blocks_agent_memory.sessions(id) ON DELETE CASCADE,
  turn_index    integer     NOT NULL,

  role          text        NOT NULL,
  content       text        NOT NULL,
  token_count   integer     NOT NULL DEFAULT 0,

  -- Embedded for retrieval. Pulling the three relevant messages from turn 200 beats replaying the
  -- last fifty, and costs far fewer tokens.
  embedding     vector(1536),

  -- Retained after compaction rather than deleted: a summary is lossy, so the original is the only
  -- place a compacted-away detail still exists.
  is_compacted  boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT turns_order_uniq UNIQUE (session_id, turn_index),
  CONSTRAINT turns_role_valid CHECK (role IN ('system', 'user', 'assistant', 'tool'))
);

CREATE INDEX IF NOT EXISTS turns_session_idx ON blocks_agent_memory.turns (session_id, turn_index);
CREATE INDEX IF NOT EXISTS turns_embedding_idx
  ON blocks_agent_memory.turns USING hnsw (embedding vector_cosine_ops);

-- Summaries of compacted ranges. First-class rows rather than a mutated field, so the record of
-- what was compacted, and when, survives.
CREATE TABLE IF NOT EXISTS blocks_agent_memory.summaries (
  id            bigserial   PRIMARY KEY,
  session_id    uuid        NOT NULL REFERENCES blocks_agent_memory.sessions(id) ON DELETE CASCADE,
  from_turn     integer     NOT NULL,
  to_turn       integer     NOT NULL,
  summary       text        NOT NULL,
  token_count   integer     NOT NULL DEFAULT 0,
  model         text,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT summaries_range_sane CHECK (to_turn >= from_turn),
  CONSTRAINT summaries_range_uniq UNIQUE (session_id, from_turn, to_turn)
);

CREATE INDEX IF NOT EXISTS summaries_session_idx
  ON blocks_agent_memory.summaries (session_id, from_turn);

-- ---------------------------------------------------------------------------
-- Observability (§10)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW blocks_agent_memory.v_status AS
SELECT
  (SELECT count(*) FROM blocks_agent_memory.sessions WHERE status = 'active') AS sessions_active,
  (SELECT count(*) FROM blocks_agent_memory.sessions WHERE status = 'archived') AS sessions_archived,
  (SELECT count(*) FROM blocks_agent_memory.turns)                       AS turns_total,
  (SELECT count(*) FROM blocks_agent_memory.turns WHERE is_compacted)    AS turns_compacted,
  -- Turns with no vector cannot be retrieved semantically, only replayed in order.
  (SELECT count(*) FROM blocks_agent_memory.turns WHERE embedding IS NULL) AS turns_unembedded,
  (SELECT count(*) FROM blocks_agent_memory.summaries)                   AS summaries_total,

  -- Sessions over the threshold that have not been compacted. These are the ones about to overflow a
  -- context window, which is the failure this block exists to prevent.
  (SELECT count(*) FROM blocks_agent_memory.sessions
     WHERE status = 'active' AND total_tokens > 24000
       AND turn_count > compacted_through_turn)                          AS sessions_needing_compaction,
  (SELECT COALESCE(max(total_tokens), 0) FROM blocks_agent_memory.sessions
     WHERE status = 'active')                                            AS largest_session_tokens,
  (SELECT count(*) FROM blocks_agent_memory.sessions
     WHERE expires_at IS NOT NULL AND expires_at < now())                AS sessions_expired
;
