/**
 * Registry operations: issue an upload URL, finalize on arrival, reconcile against storage.
 */

import { createLogger, NotFoundError, type Logger, type Queryable } from "@neon-blocks/core";
import { ObjectNotFoundError, type StorageClient } from "@neon-blocks/storage";
import { buildObjectKey, parseTenantFromKey } from "./keys.js";

export interface IssueUploadOptions {
  bucket: string;
  prefix: string;
  tenant: string;
  owner?: string;
  filename: string;
  contentType?: string;
  declaredSizeBytes?: number;
  maxBytes: number;
  ttlSeconds: number;
  storage: StorageClient;
  metadata?: Record<string, unknown>;
}

export interface IssuedUpload {
  id: string;
  objectKey: string;
  uploadUrl: string;
  expiresAt: Date;
}

/**
 * Create a pending row and return a presigned PUT URL.
 *
 * The row is written *before* the URL is returned so that an upload can never arrive for an object
 * the registry has no record of — the finalizer would then have to invent a row from an
 * unauthenticated trigger, which is exactly the trust we are avoiding.
 */
export async function issueUpload(
  db: Queryable,
  opts: IssueUploadOptions,
): Promise<IssuedUpload> {
  if (opts.declaredSizeBytes !== undefined && opts.declaredSizeBytes > opts.maxBytes) {
    throw new Error(
      `Declared size ${opts.declaredSizeBytes} exceeds the ${opts.maxBytes} byte limit`,
    );
  }

  const id = crypto.randomUUID();
  const objectKey = buildObjectKey({
    prefix: opts.prefix,
    tenant: opts.tenant,
    id,
    filename: opts.filename,
  });

  await db.query(
    `INSERT INTO blocks_file_registry.objects
       (id, bucket_name, object_key, status, tenant, owner,
        declared_content_type, declared_size_bytes, max_bytes, metadata)
     VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      id,
      opts.bucket,
      objectKey,
      opts.tenant,
      opts.owner ?? null,
      opts.contentType ?? null,
      opts.declaredSizeBytes ?? null,
      opts.maxBytes,
      JSON.stringify(opts.metadata ?? {}),
    ],
  );

  const uploadUrl = opts.storage.presignPut(opts.bucket, objectKey, {
    expiresInSeconds: opts.ttlSeconds,
    ...(opts.contentType ? { contentType: opts.contentType } : {}),
  });

  return {
    id,
    objectKey,
    uploadUrl,
    expiresAt: new Date(Date.now() + opts.ttlSeconds * 1_000),
  };
}

export type FinalizeResult =
  | { status: "ready"; id: string; sizeBytes: number; etag: string }
  | { status: "rejected"; id: string; reason: string }
  | { status: "ignored"; reason: string };

/**
 * Flip a pending row to ready, recording observed metadata.
 *
 * Called from the storage trigger. Three things make this safe against a forged POST:
 *   1. the key must parse under the configured prefix
 *   2. a matching registry row must already exist (we never invent rows from trigger input)
 *   3. HEAD establishes the object genuinely exists and supplies real metadata
 *
 * Idempotent: re-delivery of the same event, or an overwrite with a new etag, both converge.
 */
export async function finalizeUpload(
  db: Queryable,
  opts: {
    bucket: string;
    prefix: string;
    objectKey: string;
    storage: StorageClient;
    logger?: Logger;
  },
): Promise<FinalizeResult> {
  const log = opts.logger ?? createLogger({ block: "file-registry", op: "finalize" });

  const tenant = parseTenantFromKey(opts.objectKey, opts.prefix);
  if (tenant === null) {
    // Outside the managed prefix. Storage triggers have no negative filter, so unrelated objects
    // in the same bucket reach this handler routinely — not an error.
    return { status: "ignored", reason: "key is not under the registry prefix" };
  }

  const existing = await db.query<{ id: string; max_bytes: string | null; status: string }>(
    `SELECT id, max_bytes, status FROM blocks_file_registry.objects
     WHERE bucket_name = $1 AND object_key = $2 AND status IN ('pending', 'ready')`,
    [opts.bucket, opts.objectKey],
  );
  const row = existing.rows[0];

  if (!row) {
    // No pending row: either a forged event, or an object written directly to the bucket without
    // going through the registry. Recorded, not created — inventing a row here would let anyone
    // with the function URL populate the registry.
    log.warn("storage event for an object with no registry row", {
      objectKey: opts.objectKey,
      tenant,
    });
    return { status: "ignored", reason: "no pending registry row for this key" };
  }

  let metadata;
  try {
    metadata = await opts.storage.headVerified(opts.bucket, opts.objectKey);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      // The object does not exist, so this event was forged or the object was deleted immediately.
      log.warn("storage event for nonexistent object", { objectKey: opts.objectKey });
      return { status: "ignored", reason: "object does not exist" };
    }
    throw err;
  }

  // Enforce the size limit the client agreed to at issue time. A presigned PUT cannot enforce a
  // maximum on its own, so this is the only place an oversized upload is caught.
  const maxBytes = row.max_bytes === null ? null : Number(row.max_bytes);
  if (maxBytes !== null && metadata.size > maxBytes) {
    await db.query(
      `UPDATE blocks_file_registry.objects
       SET status = 'rejected',
           size_bytes = $2,
           content_type = $3,
           etag = $4,
           error = $5
       WHERE id = $1`,
      [
        row.id,
        metadata.size,
        metadata.contentType,
        metadata.etag,
        `object is ${metadata.size} bytes, over the agreed ${maxBytes} byte limit`,
      ],
    );
    log.warn("rejected oversized upload", {
      objectKey: opts.objectKey,
      size: metadata.size,
      maxBytes,
    });
    return {
      status: "rejected",
      id: row.id,
      reason: `object exceeds the ${maxBytes} byte limit`,
    };
  }

  await db.query(
    `UPDATE blocks_file_registry.objects
     SET status = 'ready',
         size_bytes = $2,
         content_type = $3,
         etag = $4,
         ready_at = COALESCE(ready_at, now()),
         error = NULL,
         deleted_at = NULL
     WHERE id = $1`,
    [row.id, metadata.size, metadata.contentType, metadata.etag],
  );

  log.info("upload finalized", {
    objectKey: opts.objectKey,
    id: row.id,
    size: metadata.size,
    tenant,
  });

  return { status: "ready", id: row.id, sizeBytes: metadata.size, etag: metadata.etag };
}

export interface ReconcileResult {
  /** Index signature so the result can be passed straight to the structured logger. */
  [field: string]: unknown;
  objectsScanned: number;
  finalizedNow: number;
  deletionsDetected: number;
  abandonedExpired: number;
  listingTruncated: boolean;
  warnings: string[];
}

/**
 * Reconcile the registry against the bucket (convention §5).
 *
 * Three drifts to fix, each corresponding to a gap in the trigger:
 *   * pending rows whose object exists  → the trigger was missed; finalize now
 *   * ready rows whose object is gone   → no delete events exist, so detect by absence
 *   * pending rows with no object       → the client abandoned the upload
 */
export async function reconcile(
  db: Queryable,
  opts: {
    bucket: string;
    prefix: string;
    storage: StorageClient;
    abandonAfterMinutes: number;
    maxObjects?: number;
    logger?: Logger;
  },
): Promise<ReconcileResult> {
  const log = opts.logger ?? createLogger({ block: "file-registry", op: "reconcile" });
  const maxObjects = opts.maxObjects ?? 1_000;
  const warnings: string[] = [];

  const listing = await opts.storage.listObjects(opts.bucket, {
    prefix: opts.prefix,
    maxKeys: maxObjects,
  });
  const presentKeys = listing.objects.map((o) => o.key);
  const listingTruncated = listing.nextContinuationToken !== null;

  // (1) Pending rows whose object actually arrived. Finalize with observed metadata.
  let finalizedNow = 0;
  if (presentKeys.length > 0) {
    const { rows } = await db.query<{ object_key: string }>(
      `SELECT object_key FROM blocks_file_registry.objects
       WHERE bucket_name = $1 AND status = 'pending' AND object_key = ANY($2::text[])`,
      [opts.bucket, presentKeys],
    );

    for (const { object_key } of rows) {
      try {
        const result = await finalizeUpload(db, {
          bucket: opts.bucket,
          prefix: opts.prefix,
          objectKey: object_key,
          storage: opts.storage,
          logger: log,
        });
        if (result.status === "ready") finalizedNow++;
      } catch (err) {
        // One failure must not abort the sweep.
        log.error("reconcile finalize failed", {
          objectKey: object_key,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (finalizedNow > 0) {
      warnings.push(
        `${finalizedNow} upload(s) were finalized by the reconciler, meaning the storage ` +
          `trigger did not deliver. It is Beta with no delivery guarantee — and check it is ` +
          `enabled on this branch, since child branches inherit triggers DISABLED.`,
      );
    }
  }

  // (2) Deletions. Only safe on a complete listing — from a partial view every unlisted object
  // looks deleted and live files would be wrongly marked gone.
  let deletionsDetected = 0;
  if (!listingTruncated) {
    const { rowCount } = await db.query(
      `UPDATE blocks_file_registry.objects
       SET status = 'deleted', deleted_at = now()
       WHERE bucket_name = $1
         AND status = 'ready'
         AND object_key LIKE $2 || '%'
         AND NOT (object_key = ANY($3::text[]))`,
      [opts.bucket, opts.prefix, presentKeys],
    );
    deletionsDetected = rowCount ?? 0;
  } else {
    warnings.push(
      `listing truncated at ${maxObjects} objects; deletion detection skipped this run to ` +
        `avoid marking unseen files as deleted`,
    );
    log.capped("bucket listing truncated", { bucket: opts.bucket, maxObjects });
  }

  // (3) Abandoned uploads: a URL was issued, the bytes never arrived.
  const { rowCount: abandonedExpired } = await db.query(
    `UPDATE blocks_file_registry.objects
     SET status = 'abandoned',
         error = 'no object arrived before the abandon window elapsed'
     WHERE status = 'pending'
       AND created_at < now() - make_interval(mins => $1::int)
       AND NOT (object_key = ANY($2::text[]))`,
    [opts.abandonAfterMinutes, presentKeys],
  );

  const result: ReconcileResult = {
    objectsScanned: listing.objects.length,
    finalizedNow,
    deletionsDetected,
    abandonedExpired: abandonedExpired ?? 0,
    listingTruncated,
    warnings,
  };

  for (const warning of warnings) log.warn(warning);
  log.info("reconcile complete", result);
  return result;
}

export interface FileRecord {
  id: string;
  objectKey: string;
  sizeBytes: number | null;
  contentType: string | null;
  etag: string | null;
  tenant: string | null;
  createdAt: Date;
  readyAt: Date | null;
  metadata: Record<string, unknown>;
}

/** List a tenant's ready files, newest first — the query Object Storage alone cannot answer. */
export async function listTenantFiles(
  db: Queryable,
  opts: { bucket: string; tenant: string; limit?: number; offset?: number },
): Promise<FileRecord[]> {
  interface Row {
    [column: string]: unknown;
    id: string;
    object_key: string;
    size_bytes: string | null;
    content_type: string | null;
    etag: string | null;
    tenant: string | null;
    created_at: Date;
    ready_at: Date | null;
    metadata: Record<string, unknown>;
  }

  const { rows } = await db.query<Row>(
    `SELECT id, object_key, size_bytes, content_type, etag, tenant, created_at, ready_at, metadata
     FROM blocks_file_registry.objects
     WHERE bucket_name = $1 AND tenant = $2 AND status = 'ready'
     ORDER BY created_at DESC
     LIMIT $3 OFFSET $4`,
    [opts.bucket, opts.tenant, Math.min(opts.limit ?? 50, 500), opts.offset ?? 0],
  );

  return rows.map((row) => ({
    id: row.id,
    objectKey: row.object_key,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    contentType: row.content_type,
    etag: row.etag,
    tenant: row.tenant,
    createdAt: row.created_at,
    readyAt: row.ready_at,
    metadata: row.metadata,
  }));
}

/**
 * Soft-delete a registry row and remove the object.
 *
 * Registry row first, object second: if the storage delete fails, the reconciler sees a deleted
 * row whose object still exists and can retry. The reverse order would leave a ready row pointing
 * at nothing, which reads as a working file until someone tries to fetch it.
 */
export async function deleteFile(
  db: Queryable,
  opts: { bucket: string; objectKey: string; tenant: string; storage: StorageClient },
): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE blocks_file_registry.objects
     SET status = 'deleted', deleted_at = now()
     WHERE bucket_name = $1 AND object_key = $2 AND tenant = $3 AND status IN ('pending', 'ready')`,
    [opts.bucket, opts.objectKey, opts.tenant],
  );

  if ((rowCount ?? 0) === 0) {
    // Also the not-your-file case. Deliberately indistinguishable from not-found so the endpoint
    // cannot be used to probe which keys exist in other tenants.
    throw new NotFoundError("No such file for this tenant");
  }

  await opts.storage.deleteObject(opts.bucket, opts.objectKey);
}
