-- Block 5: ingest router.
--
-- Storage triggers have no suffix or content-type filter, so one trigger per bucket receives
-- everything and must sort it out in-function. This table is the dispatch ledger: what arrived,
-- what it was classified as, which jobs were enqueued, and what was deliberately not routed.
--
-- The ledger exists because "nothing happened" has three very different causes -- no route
-- configured, object too large, or delivery never arrived -- and a router that cannot tell them
-- apart is impossible to debug.

CREATE SCHEMA IF NOT EXISTS blocks_ingest_router;

CREATE TABLE IF NOT EXISTS blocks_ingest_router.dispatches (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_name   text        NOT NULL,
  object_key    text        NOT NULL,

  -- Idempotency is on (key, etag), not key alone: overwriting an object re-fires the trigger with
  -- new content, and keying on the object would silently ignore the new version.
  etag          text        NOT NULL,

  kind          text,
  content_type  text,
  size_bytes    bigint,

  status        text        NOT NULL DEFAULT 'routed',
  -- Job types enqueued for this object, for tracing a file through the pipeline.
  routed_to     text[]      NOT NULL DEFAULT '{}',
  reason        text,

  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT dispatches_status_valid
    CHECK (status IN ('routed', 'unrouted', 'skipped', 'rejected', 'failed')),
  CONSTRAINT dispatches_identity UNIQUE (bucket_name, object_key, etag)
);

CREATE INDEX IF NOT EXISTS dispatches_created_idx ON blocks_ingest_router.dispatches (created_at DESC);
CREATE INDEX IF NOT EXISTS dispatches_status_idx ON blocks_ingest_router.dispatches (status, created_at);
CREATE INDEX IF NOT EXISTS dispatches_kind_idx ON blocks_ingest_router.dispatches (kind, created_at);
CREATE INDEX IF NOT EXISTS dispatches_key_idx ON blocks_ingest_router.dispatches (bucket_name, object_key);

-- ---------------------------------------------------------------------------
-- Observability (§10)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW blocks_ingest_router.v_by_kind AS
SELECT kind,
       status,
       count(*)                AS objects,
       COALESCE(sum(size_bytes), 0) AS bytes,
       max(created_at)         AS most_recent
FROM blocks_ingest_router.dispatches
GROUP BY kind, status;

COMMENT ON VIEW blocks_ingest_router.v_by_kind IS
  'What is arriving and where it goes. A large "unrouted" count for a kind means a route is '
  'missing from ROUTER_ROUTES, not that the router is broken.';

CREATE OR REPLACE VIEW blocks_ingest_router.v_status AS
SELECT
  count(*)                                        AS dispatches_total,
  count(*) FILTER (WHERE status = 'routed')        AS dispatches_routed,

  -- Not an error. A kind with no configured route is a deliberate outcome, recorded so it is
  -- visible rather than looking like a silent drop.
  count(*) FILTER (WHERE status = 'unrouted')      AS dispatches_unrouted,

  count(*) FILTER (WHERE status = 'skipped')       AS dispatches_skipped,
  count(*) FILTER (WHERE status = 'rejected')      AS dispatches_rejected,
  count(*) FILTER (WHERE status = 'failed')        AS dispatches_failed,

  count(*) FILTER (WHERE created_at > now() - interval '1 hour')   AS dispatches_last_hour,
  (SELECT count(DISTINCT kind) FROM blocks_ingest_router.dispatches
     WHERE kind IS NOT NULL)                       AS kinds_seen,
  (SELECT COALESCE(EXTRACT(EPOCH FROM (now() - max(created_at)))::bigint, -1)
     FROM blocks_ingest_router.dispatches)         AS seconds_since_last_dispatch
FROM blocks_ingest_router.dispatches;
