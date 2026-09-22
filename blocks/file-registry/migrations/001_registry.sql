-- Block 4: file registry + signed uploads.
--
-- Object Storage branches with your data, which is excellent -- but it is unqueryable. You cannot
-- ask "every file this tenant owns, newest first" or join files to your domain tables or enforce
-- a quota. This table is that index, and it is the keystone the rest of the storage family reads.

CREATE SCHEMA IF NOT EXISTS blocks_file_registry;

CREATE TABLE IF NOT EXISTS blocks_file_registry.objects (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_name    text        NOT NULL,
  object_key     text        NOT NULL,

  -- Lifecycle: pending (URL issued, bytes not yet arrived) -> ready -> deleted/abandoned.
  -- Without 'pending' a client cannot upload directly to storage, and proxying bytes through a
  -- function burns Capacity-Hours doing nothing but copying.
  status         text        NOT NULL DEFAULT 'pending',

  -- Populated by a HEAD at finalize time. Nullable because a pending row predates the object.
  size_bytes     bigint,
  content_type   text,
  etag           text,

  -- Parsed from the key by convention (prefix/<tenant>/...). Indexed so RLS policies and
  -- per-tenant quotas are cheap.
  tenant         text,
  owner          text,

  -- What the client claimed when requesting the URL. Kept separately from the HEAD-observed
  -- values: the difference between them is exactly how you detect a client that lied about
  -- content type or size.
  declared_content_type text,
  declared_size_bytes   bigint,
  max_bytes             bigint,

  metadata       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  error          text,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  ready_at       timestamptz,
  deleted_at     timestamptz,

  CONSTRAINT objects_status_valid
    CHECK (status IN ('pending', 'ready', 'deleted', 'abandoned', 'rejected')),
  -- One live row per object key. Partial so a deleted row does not block re-upload of the same
  -- key, which is ordinary behaviour for a replaced avatar or document.
  CONSTRAINT objects_key_shape CHECK (object_key <> '' AND length(object_key) <= 1024)
);

CREATE UNIQUE INDEX IF NOT EXISTS objects_live_key_uniq
  ON blocks_file_registry.objects (bucket_name, object_key)
  WHERE status IN ('pending', 'ready');

CREATE INDEX IF NOT EXISTS objects_tenant_idx
  ON blocks_file_registry.objects (tenant, created_at DESC)
  WHERE status = 'ready';

CREATE INDEX IF NOT EXISTS objects_status_idx ON blocks_file_registry.objects (status, created_at);

-- Lets the reconciler find pending uploads that never completed without scanning ready rows.
CREATE INDEX IF NOT EXISTS objects_pending_idx
  ON blocks_file_registry.objects (created_at)
  WHERE status = 'pending';

CREATE OR REPLACE FUNCTION blocks_file_registry.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS objects_touch ON blocks_file_registry.objects;
CREATE TRIGGER objects_touch
  BEFORE UPDATE ON blocks_file_registry.objects
  FOR EACH ROW EXECUTE FUNCTION blocks_file_registry.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row-level security scaffolding
-- ---------------------------------------------------------------------------
-- Enabled but with no policies by default, which denies all access to non-owner roles. That is
-- the safe default: a registry that is readable by every role would leak file listings across
-- tenants. Users add policies keyed to their own auth model -- an example is in the README.

ALTER TABLE blocks_file_registry.objects ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Quotas
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW blocks_file_registry.v_tenant_usage AS
SELECT tenant,
       count(*)                                  AS file_count,
       COALESCE(sum(size_bytes), 0)              AS bytes_used,
       max(created_at)                           AS most_recent_upload
FROM blocks_file_registry.objects
WHERE status = 'ready' AND tenant IS NOT NULL
GROUP BY tenant;

COMMENT ON VIEW blocks_file_registry.v_tenant_usage IS
  'Per-tenant storage usage. Join against your own plan limits to enforce quotas before issuing '
  'an upload URL.';

-- ---------------------------------------------------------------------------
-- Observability (§10)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW blocks_file_registry.v_status AS
SELECT
  count(*)                                                   AS objects_total,
  count(*) FILTER (WHERE status = 'ready')                    AS objects_ready,
  count(*) FILTER (WHERE status = 'pending')                  AS objects_pending,
  count(*) FILTER (WHERE status = 'deleted')                  AS objects_deleted,
  count(*) FILTER (WHERE status = 'abandoned')                AS objects_abandoned,
  count(*) FILTER (WHERE status = 'rejected')                 AS objects_rejected,

  -- Pending for over an hour: either the client abandoned the upload, or the storage trigger
  -- never fired. The reconciler distinguishes these; a growing number means one of them is
  -- happening systematically.
  count(*) FILTER (WHERE status = 'pending' AND created_at < now() - interval '1 hour')
                                                             AS objects_pending_stale,

  COALESCE(sum(size_bytes) FILTER (WHERE status = 'ready'), 0) AS bytes_stored,
  count(DISTINCT tenant) FILTER (WHERE tenant IS NOT NULL)     AS tenants
FROM blocks_file_registry.objects;
