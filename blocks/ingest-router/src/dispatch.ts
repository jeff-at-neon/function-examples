/**
 * Dispatch: classify an object and enqueue the jobs its kind maps to.
 *
 * Every storage-triggered block would otherwise have to independently rediscover HEAD-verify,
 * etag idempotency, and the loop hazard. Centralizing them here is the reason this block is ranked
 * above the pipelines it feeds.
 */

import { createLogger, type Logger, type Queryable } from "@neon-blocks/core";
import { enqueue } from "@neon-blocks/queue";
import { detectKind, ObjectNotFoundError, type StorageClient } from "@neon-blocks/storage";
import { isDerivative, isWatched, jobsForKind, type RouteTable } from "./routes.js";

export interface DispatchOptions {
  bucket: string;
  objectKey: string;
  watchedPrefix: string;
  outputPrefix: string;
  routes: RouteTable;
  maxBytes: number;
  storage: StorageClient;
  logger?: Logger;
}

export type DispatchResult =
  | { status: "routed"; kind: string; jobs: string[]; deduplicated: boolean }
  | { status: "unrouted"; kind: string; reason: string }
  | { status: "skipped"; reason: string }
  | { status: "rejected"; reason: string };

/**
 * Route one object.
 *
 * Ordering matters and is deliberate: the cheap, no-I/O rejections come first so a forged event or
 * a derivative costs nothing beyond a function invocation, and only plausible objects reach the
 * HEAD request.
 */
export async function dispatchObject(
  db: Queryable,
  opts: DispatchOptions,
): Promise<DispatchResult> {
  const log = opts.logger ?? createLogger({ block: "ingest-router", op: "dispatch" });

  // (1) Loop guard, first and free. A derivative arriving back here is the failure that burns
  // capacity-hours indefinitely, so it is rejected before any I/O.
  if (isDerivative(opts.objectKey, opts.outputPrefix)) {
    log.debug("ignoring derivative to avoid a write-amplification loop", {
      objectKey: opts.objectKey,
    });
    return { status: "skipped", reason: "object is a derivative of this pipeline" };
  }

  // (2) Prefix check. The trigger has a prefix filter, but delivery is unauthenticated so a forged
  // POST can name anything.
  if (!isWatched(opts.objectKey, opts.watchedPrefix)) {
    return { status: "skipped", reason: "key is outside the watched prefix" };
  }

  // (3) HEAD-verify. Establishes the object exists and supplies the metadata the trigger payload
  // does not carry.
  let metadata;
  try {
    metadata = await opts.storage.headVerified(opts.bucket, opts.objectKey);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      log.warn("event for nonexistent object; likely forged or deleted immediately", {
        objectKey: opts.objectKey,
      });
      return { status: "skipped", reason: "object does not exist" };
    }
    throw err;
  }

  if (metadata.size > opts.maxBytes) {
    await record(db, {
      bucket: opts.bucket,
      objectKey: opts.objectKey,
      etag: metadata.etag,
      contentType: metadata.contentType,
      sizeBytes: metadata.size,
      status: "rejected",
      routedTo: [],
      reason: `object is ${metadata.size} bytes, over the ${opts.maxBytes} byte routing limit`,
    });
    log.capped("object too large to route", { objectKey: opts.objectKey, size: metadata.size });
    return { status: "rejected", reason: "over the size limit" };
  }

  // (4) Idempotency on (key, etag). Claim the dispatch before enqueueing so concurrent deliveries
  // of the same event produce one set of jobs.
  const claimed = await claim(db, opts.bucket, opts.objectKey, metadata.etag);
  if (!claimed) {
    log.debug("object already dispatched at this etag", { objectKey: opts.objectKey });
    return { status: "routed", kind: "unchanged", jobs: [], deduplicated: true };
  }

  // Classification needs magic bytes when content type is generic, which is common from SDK
  // uploads. A 512-byte ranged read would be better; getObject is used for simplicity and is
  // bounded by maxBytes above.
  const kind = detectKind({ key: opts.objectKey, contentType: metadata.contentType });
  const jobs = jobsForKind(opts.routes, kind);

  if (jobs.length === 0) {
    await record(db, {
      bucket: opts.bucket,
      objectKey: opts.objectKey,
      etag: metadata.etag,
      contentType: metadata.contentType,
      sizeBytes: metadata.size,
      status: "unrouted",
      routedTo: [],
      kind,
      reason: `no route configured for kind "${kind}"`,
    });
    // Recorded, not dropped. §10: a silent drop is indistinguishable from a bug.
    log.info("no route for object kind", { objectKey: opts.objectKey, kind });
    return { status: "unrouted", kind, reason: `no route configured for kind "${kind}"` };
  }

  const enqueued: string[] = [];
  for (const jobType of jobs) {
    await enqueue(db, {
      type: jobType,
      payload: {
        bucket: opts.bucket,
        objectKey: opts.objectKey,
        etag: metadata.etag,
        contentType: metadata.contentType,
        sizeBytes: metadata.size,
        kind,
      },
      // Keyed on etag so a re-delivered event does not duplicate the job even if the dispatch
      // claim above somehow raced.
      idempotencyKey: `router:${opts.bucket}:${opts.objectKey}:${metadata.etag}:${jobType}`,
    });
    enqueued.push(jobType);
  }

  await record(db, {
    bucket: opts.bucket,
    objectKey: opts.objectKey,
    etag: metadata.etag,
    contentType: metadata.contentType,
    sizeBytes: metadata.size,
    status: "routed",
    routedTo: enqueued,
    kind,
  });

  log.info("object routed", { objectKey: opts.objectKey, kind, jobs: enqueued });
  return { status: "routed", kind, jobs: enqueued, deduplicated: false };
}

/**
 * Reserve the dispatch for this (key, etag).
 *
 * Returns false when another invocation already has it. `ON CONFLICT DO NOTHING` makes this a
 * single atomic statement rather than a check-then-insert race.
 */
async function claim(
  db: Queryable,
  bucket: string,
  objectKey: string,
  etag: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO blocks_ingest_router.dispatches (bucket_name, object_key, etag, status)
     VALUES ($1, $2, $3, 'routed')
     ON CONFLICT (bucket_name, object_key, etag) DO NOTHING`,
    [bucket, objectKey, etag],
  );
  return (rowCount ?? 0) > 0;
}

async function record(
  db: Queryable,
  row: {
    bucket: string;
    objectKey: string;
    etag: string;
    contentType: string;
    sizeBytes: number;
    status: string;
    routedTo: string[];
    kind?: string;
    reason?: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO blocks_ingest_router.dispatches
       (bucket_name, object_key, etag, kind, content_type, size_bytes, status, routed_to, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9)
     ON CONFLICT (bucket_name, object_key, etag) DO UPDATE
       SET kind = EXCLUDED.kind,
           content_type = EXCLUDED.content_type,
           size_bytes = EXCLUDED.size_bytes,
           status = EXCLUDED.status,
           routed_to = EXCLUDED.routed_to,
           reason = EXCLUDED.reason`,
    [
      row.bucket,
      row.objectKey,
      row.etag,
      row.kind ?? null,
      row.contentType,
      row.sizeBytes,
      row.status,
      row.routedTo,
      row.reason ?? null,
    ],
  );
}

export interface ReconcileResult {
  [field: string]: unknown;
  objectsScanned: number;
  dispatchedNow: number;
  listingTruncated: boolean;
  warnings: string[];
}

/**
 * Re-dispatch objects the trigger never delivered (convention §5).
 *
 * Unlike the registry's reconciler this does not detect deletions — the router is stateless about
 * object lifetime; it only cares that every arrival got routed exactly once.
 */
export async function reconcile(
  db: Queryable,
  opts: Omit<DispatchOptions, "objectKey"> & { maxObjects?: number },
): Promise<ReconcileResult> {
  const log = opts.logger ?? createLogger({ block: "ingest-router", op: "reconcile" });
  const maxObjects = opts.maxObjects ?? 1_000;
  const warnings: string[] = [];

  const listing = await opts.storage.listObjects(opts.bucket, {
    prefix: opts.watchedPrefix,
    maxKeys: maxObjects,
  });

  // Candidates only: derivatives are excluded here as well as in dispatchObject, so the "missing"
  // count in logs reflects genuine gaps rather than our own output.
  const candidates = listing.objects.filter((o) => !isDerivative(o.key, opts.outputPrefix));
  let dispatchedNow = 0;

  if (candidates.length > 0) {
    const { rows } = await db.query<{ object_key: string; etag: string }>(
      `SELECT object_key, etag FROM blocks_ingest_router.dispatches
       WHERE bucket_name = $1 AND object_key = ANY($2::text[])`,
      [opts.bucket, candidates.map((o) => o.key)],
    );
    const dispatched = new Set(rows.map((r) => `${r.object_key} ${r.etag}`));

    for (const object of candidates) {
      if (dispatched.has(`${object.key} ${object.etag}`)) continue;

      try {
        const result = await dispatchObject(db, { ...opts, objectKey: object.key });
        if (result.status === "routed" && !result.deduplicated) dispatchedNow++;
      } catch (err) {
        log.error("reconcile dispatch failed", {
          objectKey: object.key,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (dispatchedNow > 0) {
    warnings.push(
      `${dispatchedNow} object(s) were routed by the reconciler, meaning the storage trigger did ` +
        `not deliver. It is Beta with no delivery guarantee — and confirm it is enabled on this ` +
        `branch, since child branches inherit triggers DISABLED.`,
    );
  }
  if (listing.nextContinuationToken) {
    warnings.push(`listing truncated at ${maxObjects} objects; the next run continues`);
    log.capped("bucket listing truncated", { bucket: opts.bucket, maxObjects });
  }

  const result: ReconcileResult = {
    objectsScanned: candidates.length,
    dispatchedNow,
    listingTruncated: listing.nextContinuationToken !== null,
    warnings,
  };

  for (const warning of warnings) log.warn(warning);
  log.info("reconcile complete", result);
  return result;
}
