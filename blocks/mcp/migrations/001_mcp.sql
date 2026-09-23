-- Block 29: MCP server on Postgres.
--
-- Exposes Postgres-backed tools to an AI agent over the Model Context Protocol (JSON-RPC). The
-- server runs on a Neon Function next to the database, so a tool call is a local query. Two tables:
-- a small demo `products` catalog the example tools read, and a `tool_calls` audit log so you can
-- see exactly what an agent invoked.

CREATE SCHEMA IF NOT EXISTS blocks_mcp;

-- Demo data the example tools read. Replace with your own tables (and point the tools at them) to
-- expose real product, customer, or order data. Seeded so the example returns results out of the box.
CREATE TABLE IF NOT EXISTS blocks_mcp.products (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  sku         text        NOT NULL UNIQUE,
  name        text        NOT NULL,
  description text        NOT NULL DEFAULT '',
  price_cents integer     NOT NULL CHECK (price_cents >= 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO blocks_mcp.products (sku, name, description, price_cents) VALUES
  ('SKU-001', 'Aeron Chair', 'Ergonomic office chair with lumbar support', 129900),
  ('SKU-002', 'Standing Desk', 'Height-adjustable sit-stand desk, 60 inch', 79900),
  ('SKU-003', 'Desk Lamp', 'LED desk lamp with adjustable color temperature', 4900)
ON CONFLICT (sku) DO NOTHING;

-- Audit log of every tools/call. Answers "what did the agent actually do?", and its error rate is
-- the block's health signal.
CREATE TABLE IF NOT EXISTS blocks_mcp.tool_calls (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tool        text        NOT NULL,
  arguments   jsonb       NOT NULL DEFAULT '{}',
  ok          boolean     NOT NULL,
  duration_ms integer     NOT NULL,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tool_calls_created_idx ON blocks_mcp.tool_calls (created_at DESC);

-- Convention 10: is this healthy right now?
CREATE OR REPLACE VIEW blocks_mcp.v_status AS
SELECT
  (SELECT count(*) FROM blocks_mcp.products)                                  AS products,
  (SELECT count(*) FROM blocks_mcp.tool_calls)                                AS tool_calls_total,
  (SELECT count(*) FROM blocks_mcp.tool_calls
     WHERE created_at > now() - interval '1 hour')                            AS tool_calls_last_hour,
  (SELECT count(*) FROM blocks_mcp.tool_calls
     WHERE ok = false AND created_at > now() - interval '1 hour')            AS errors_last_hour;
