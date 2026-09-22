-- Block 23: image derivatives.
--
-- Table stakes, not a differentiator: Cloudflare Images and Vercel do this well, and being next
-- to Postgres buys nothing for pixel pushing. It is here so nobody asks why the catalog cannot do
-- the obvious thing. Its real value is the registry join -- "every image this tenant owns and
-- whether its thumbnail exists" -- rather than the resizing itself.
-- 
-- Ranked at 23 for packaging, not cost. The economics are fine: active Capacity-Hours are 4x
-- waiting, not 40x, which works out around $16-26 per million images -- roughly 1.3-2x Lambda and
-- some 30x cheaper than Cloudinary. The blocker is that the default esbuild bundle cannot load
-- native .node binaries, so sharp breaks the one-command install.

CREATE SCHEMA IF NOT EXISTS blocks_image_derivatives;

-- One row per generated derivative. The point of recording them in SQL is the registry join:
-- "every image belonging to this tenant, and whether its thumbnail exists yet" is not a question
-- Object Storage can answer.
CREATE TABLE IF NOT EXISTS blocks_image_derivatives.derivatives (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  source_bucket   text        NOT NULL,
  source_key      text        NOT NULL,
  -- The other half of the idempotency contract: overwriting a source produces a new etag, so its
  -- derivatives must be regenerated rather than served stale.
  source_etag     text        NOT NULL,

  -- Transform parameters, part of the identity so an identical request hits the cache.
  width           integer     NOT NULL,
  height          integer,
  format          text        NOT NULL DEFAULT 'webp',
  fit             text        NOT NULL DEFAULT 'cover',

  derivative_bucket text      NOT NULL,
  derivative_key  text        NOT NULL,
  derivative_bytes bigint,

  status          text        NOT NULL DEFAULT 'pending',
  error           text,

  -- Set by the reconciler when the source no longer exists. Without storage delete events these
  -- rows would be permanent, and so would the storage cost of the files they point at.
  orphaned_at     timestamptz,

  hit_count       integer     NOT NULL DEFAULT 0,
  last_served_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  generated_at    timestamptz,

  CONSTRAINT derivatives_status_valid
    CHECK (status IN ('pending', 'generating', 'ready', 'failed', 'rejected', 'orphaned')),
  CONSTRAINT derivatives_format_valid CHECK (format IN ('webp', 'jpeg', 'png', 'avif')),
  CONSTRAINT derivatives_fit_valid CHECK (fit IN ('cover', 'contain', 'fill', 'inside')),
  CONSTRAINT derivatives_dimensions_sane CHECK (width > 0 AND (height IS NULL OR height > 0)),
  -- Identity includes every transform parameter AND the source etag, so a cache hit is an exact
  -- match on both the request and the underlying bytes.
  CONSTRAINT derivatives_identity
    UNIQUE (source_bucket, source_key, source_etag, width, height, format, fit)
);

CREATE INDEX IF NOT EXISTS derivatives_source_idx
  ON blocks_image_derivatives.derivatives (source_bucket, source_key);
CREATE INDEX IF NOT EXISTS derivatives_status_idx
  ON blocks_image_derivatives.derivatives (status, created_at);
-- Serves the orphan sweep without scanning healthy rows.
CREATE INDEX IF NOT EXISTS derivatives_orphan_idx
  ON blocks_image_derivatives.derivatives (orphaned_at) WHERE orphaned_at IS NOT NULL;
-- Least-recently-served first, for evicting derivatives nobody requests.
CREATE INDEX IF NOT EXISTS derivatives_lru_idx
  ON blocks_image_derivatives.derivatives (last_served_at NULLS FIRST)
  WHERE status = 'ready';

-- ---------------------------------------------------------------------------
-- Observability (§10)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW blocks_image_derivatives.v_status AS
SELECT
  count(*)                                              AS derivatives_total,
  count(*) FILTER (WHERE status = 'ready')               AS derivatives_ready,
  count(*) FILTER (WHERE status = 'failed')              AS derivatives_failed,
  -- Rejected for exceeding a pixel or dimension guard. Expected, not alarming: it is the
  -- decompression-bomb defence working.
  count(*) FILTER (WHERE status = 'rejected')            AS derivatives_rejected,
  count(*) FILTER (WHERE status IN ('pending', 'generating')
                     AND created_at < now() - interval '1 hour') AS derivatives_stuck,

  -- Derivatives whose source is gone. You are paying to store these.
  count(*) FILTER (WHERE orphaned_at IS NOT NULL)        AS derivatives_orphaned,
  COALESCE(sum(derivative_bytes) FILTER (WHERE orphaned_at IS NOT NULL), 0) AS orphaned_bytes,

  COALESCE(sum(derivative_bytes) FILTER (WHERE status = 'ready'), 0) AS bytes_stored,
  COALESCE(sum(hit_count), 0)                           AS serves_total,
  -- Generated but never served: a size nobody requests, which is what eager generation produces.
  count(*) FILTER (WHERE status = 'ready' AND hit_count = 0
                     AND created_at < now() - interval '7 days') AS derivatives_never_served
FROM blocks_image_derivatives.derivatives
;
