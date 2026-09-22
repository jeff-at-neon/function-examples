-- Block 12: api edge pack.
--
-- Everyone rebuilds this, and everyone rebuilds it badly: keys stored in plaintext, rate limits that reset on deploy because they live in memory, idempotency that isn't. Putting it in Postgres makes the limits survive restarts and the keys survive a database dump landing in the wrong place.

CREATE SCHEMA IF NOT EXISTS blocks_api_edge;

CREATE TABLE IF NOT EXISTS blocks_api_edge.api_keys (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant        text        NOT NULL,
  name          text        NOT NULL,

  -- SHA-256 of the key. The plaintext is shown once at creation and never stored, so a database dump
  -- leaks nothing usable.
  key_hash      text        NOT NULL,
  -- First few characters, for lookup and for display. Without it, verifying a key means hashing the
  -- candidate against every row; with it, one index lookup.
  key_prefix    text        NOT NULL,

  -- Coarse capability strings, e.g. {read,write}. Checked by the caller, not enforced here.
  scopes        text[]      NOT NULL DEFAULT '{}',
  -- Per-key override of API_DEFAULT_RATE_LIMIT. NULL means use the default.
  rate_limit    integer,

  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT api_keys_hash_uniq UNIQUE (key_hash)
);

CREATE INDEX IF NOT EXISTS api_keys_prefix_idx ON blocks_api_edge.api_keys (key_prefix)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS api_keys_tenant_idx ON blocks_api_edge.api_keys (tenant);

-- Fixed-window counters. In Postgres rather than in memory, because in-memory state is per-instance
-- and resets on deploy -- which means the limit is not actually a limit.
CREATE TABLE IF NOT EXISTS blocks_api_edge.rate_windows (
  subject       text        NOT NULL,
  window_start  timestamptz NOT NULL,
  count         integer     NOT NULL DEFAULT 0,

  PRIMARY KEY (subject, window_start)
);

CREATE INDEX IF NOT EXISTS rate_windows_start_idx ON blocks_api_edge.rate_windows (window_start);

-- Idempotency records. Stores the RESPONSE, not just the key: a retried request must receive the
-- original response back, not a 409. Storing only the key leaves the client unable to recover the
-- result of a call it already made.
CREATE TABLE IF NOT EXISTS blocks_api_edge.idempotency (
  key           text        PRIMARY KEY,
  tenant        text        NOT NULL,
  -- Hash of the request body. A client reusing a key with a different payload is a bug, and
  -- returning the first response for a different request would be worse than erroring.
  request_hash  text        NOT NULL,
  response_status integer,
  response_body text,
  -- 'in_flight' until the handler completes, so concurrent duplicates can be told to wait rather
  -- than both executing.
  state         text        NOT NULL DEFAULT 'in_flight',
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,

  CONSTRAINT idempotency_state_valid CHECK (state IN ('in_flight', 'complete'))
);

CREATE INDEX IF NOT EXISTS idempotency_expiry_idx ON blocks_api_edge.idempotency (expires_at);

-- ---------------------------------------------------------------------------
-- Observability (§10)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW blocks_api_edge.v_status AS
SELECT
  (SELECT count(*) FROM blocks_api_edge.api_keys WHERE revoked_at IS NULL)  AS keys_active,
  (SELECT count(*) FROM blocks_api_edge.api_keys WHERE revoked_at IS NOT NULL) AS keys_revoked,
  -- Expired but not revoked. These already fail, but they are worth cleaning up.
  (SELECT count(*) FROM blocks_api_edge.api_keys
     WHERE expires_at IS NOT NULL AND expires_at < now() AND revoked_at IS NULL) AS keys_expired,
  (SELECT count(*) FROM blocks_api_edge.api_keys
     WHERE last_used_at IS NULL AND created_at < now() - interval '30 days') AS keys_never_used,
  (SELECT count(*) FROM blocks_api_edge.rate_windows)                       AS rate_windows_live,
  -- Windows past their usefulness. A growing number means the sweeper is not running.
  (SELECT count(*) FROM blocks_api_edge.rate_windows
     WHERE window_start < now() - interval '1 hour')                        AS rate_windows_stale,
  (SELECT count(*) FROM blocks_api_edge.idempotency WHERE state = 'complete') AS idempotency_stored,
  -- In-flight for a long time means a handler crashed mid-request, and the key is now stuck.
  (SELECT count(*) FROM blocks_api_edge.idempotency
     WHERE state = 'in_flight' AND created_at < now() - interval '15 minutes') AS idempotency_stuck
;
