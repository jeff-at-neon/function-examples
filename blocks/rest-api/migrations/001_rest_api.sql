-- Block 27: REST API on Postgres.
--
-- The canonical first example: an HTTP request lands on a Neon Function, which reads or writes a
-- Postgres table in the same region and returns JSON. The table is the block's own, so the example
-- is self-contained and installing it never touches your existing tables.

CREATE SCHEMA IF NOT EXISTS blocks_rest_api;

CREATE TABLE IF NOT EXISTS blocks_rest_api.todos (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  title      text        NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  done       boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS todos_created_idx ON blocks_rest_api.todos (created_at DESC);

-- Convention 10: is this healthy right now?
CREATE OR REPLACE VIEW blocks_rest_api.v_status AS
SELECT
  (SELECT count(*) FROM blocks_rest_api.todos)                 AS todos,
  (SELECT count(*) FROM blocks_rest_api.todos WHERE done)      AS done,
  (SELECT max(updated_at) FROM blocks_rest_api.todos)          AS last_updated_at;
