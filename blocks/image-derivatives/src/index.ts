/**
 * Block 23 — Image Derivatives.
 *
 * Thumbnails and transforms with EXIF stripping, generated on read and cached, not eagerly on upload.
 *
 * Image resizing is well served by dedicated image CDNs, and running it next to Postgres buys
 * nothing for the pixel work itself. What it does buy is the registry join -- "every image this
 * tenant owns, and whether its thumbnail exists yet" -- which is not a question object storage
 * can answer on its own.
 * 
 * Built late because of packaging, not cost. The compute is affordable: active Capacity-Hours are
 * 4x waiting rather than 40x, which works out around $16-26 per million images. The real obstacle
 * is that the default esbuild bundle cannot load native .node binaries, so sharp breaks the
 * one-command install.
 *
 * Routes:
 *   GET    /i/:key                Serve a derivative, generating on a cache miss.
 *   POST   /reconcile             Cron. Mark derivatives whose source is gone.
 *   GET    /derivatives           Derivatives for a source key.
 *
 * STATUS: scaffold. The schema, safety checks, and control flow are real; the marked TODO seams are
 * the remaining work. Endpoints that are not implemented return 501 with a specific explanation
 * rather than failing in a way that looks like a bug.
 */

import {
  assertTriggerAuthentic,
  assertNoLoop,
  checkHealth,
  createLogger,
  getPool,
  json,
  NotFoundError,
  parseTriggerEvent,
  problem,
  Router,
  ValidationError,
  type Logger,
} from "@neon-blocks/core";
import { StorageClient, detectKind, ObjectNotFoundError } from "@neon-blocks/storage";
import { loadImagesConfig } from "./config.js";
import { parseTransform, derivativeKeyFor } from "./transform.js";
import { CodecNotConfiguredError, generateDerivative } from "./resize.js";

const log: Logger = createLogger({ block: "image-derivatives" });

const router = new Router();

router.get("/i/:key", async (_request, ctx) => {
  const cfg = loadImagesConfig();
  const sourceKey = ctx.params["key"]!;

  const transform = parseTransform(ctx.url.searchParams, cfg.allowedWidths);

  const sourceBucket = cfg.sourceBucket;
  const derivativeBucket = cfg.derivativeBucket;
  const derivativePrefix = cfg.derivativePrefix;

  // §8, checked here as well as at startup. Writing derivatives into the watched bucket retriggers
  // the pipeline forever and there is no negative prefix filter to stop it.
  assertNoLoop({
    inputBucket: sourceBucket,
    inputPrefix: cfg.sourcePrefix,
    outputBucket: derivativeBucket,
    outputPrefix: derivativePrefix,
  });

  const storage = StorageClient.fromEnv();

  if (detectKind({ key: sourceKey }) !== "image") {
    return problem(400, "not_an_image", `${sourceKey} does not look like an image`);
  }

  // HEAD the source for its etag, which is part of the cache key.
  let sourceMeta;
  try {
    sourceMeta = await storage.headVerified(sourceBucket, sourceKey);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) throw new NotFoundError("No such source image");
    throw err;
  }

  if (sourceMeta.size > cfg.maxBytes) {
    return problem(
      413,
      "source_too_large",
      `Source is ${sourceMeta.size} bytes, over the ${cfg.maxBytes} limit. Functions run at a fixed ` +
        `size, so there is no scaling up for large images.`,
    );
  }

  const derivativeKey = derivativeKeyFor(derivativePrefix, sourceKey, sourceMeta.etag, transform);
  const pool = getPool();

  // Cache check first -- the whole point of transform-on-read. A hit costs one indexed lookup and a
  // redirect, with no pixel work at all.
  const { rows: cached } = await pool.query<{ id: string; derivative_key: string }>(
    `UPDATE blocks_image_derivatives.derivatives
     SET hit_count = hit_count + 1, last_served_at = now()
     WHERE source_bucket = $1 AND source_key = $2 AND source_etag = $3
       AND width = $4 AND height IS NOT DISTINCT FROM $5 AND format = $6 AND fit = $7
       AND status = 'ready'
     RETURNING id, derivative_key`,
    [sourceBucket, sourceKey, sourceMeta.etag, transform.width, transform.height,
     transform.format, transform.fit],
  );

  if (cached[0]) {
    // Redirect to a presigned URL rather than streaming bytes through the function: streaming would
    // bill Capacity-Hours to do nothing but copy, on every request.
    return new Response(null, {
      status: 302,
      headers: {
        location: storage.presignGet(derivativeBucket, cached[0].derivative_key, {
          expiresInSeconds: 3600,
        }),
        "cache-control": cfg.cacheControl,
      },
    });
  }

  // Cache miss: generate. The pixel-budget bomb guard runs BEFORE decode and EXIF/GPS is stripped
  // (pure, tested); the pixel resize runs through the configured codec adapter.
  try {
    const result = await generateDerivative(
      { db: pool, storage },
      {
        sourceBucket,
        sourceKey,
        sourceEtag: sourceMeta.etag,
        derivativeBucket,
        derivativeKey,
        transform,
        maxBytes: cfg.maxBytes,
        maxPixels: cfg.maxPixels,
      },
    );
    if (result.status === "rejected") {
      return problem(422, "rejected", result.reason ?? "image rejected");
    }
    return new Response(null, {
      status: 302,
      headers: {
        location: storage.presignGet(derivativeBucket, derivativeKey, { expiresInSeconds: 3600 }),
        "cache-control": cfg.cacheControl,
      },
    });
  } catch (err) {
    if (err instanceof CodecNotConfiguredError) {
      // Honest boundary: guards ran and the row is recorded, but no codec is installed to resize.
      return problem(503, "codec_not_configured", err.message);
    }
    throw err;
  }
});

router.post("/reconcile", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", `/reconcile expects a schedule trigger, got ${event.type}`);
  }

  const cfg = loadImagesConfig();
  const storage = StorageClient.fromEnv();
  const pool = getPool();
  const sourceBucket = cfg.sourceBucket;

  // No storage delete events exist, so orphans are detected by absence. Without this a deleted
  // source leaves its derivatives on disk forever and you keep paying for them.
  const listing = await storage.listObjects(sourceBucket, {
    prefix: cfg.sourcePrefix,
    maxKeys: 1000,
  });

  if (listing.nextContinuationToken) {
    // From a partial listing every unlisted source looks deleted, which would orphan live
    // derivatives. §10: reported rather than silently narrowed.
    log.capped("source listing truncated; orphan detection skipped", {
      bucket: sourceBucket,
      scanned: listing.objects.length,
    });
    return json({
      ok: true,
      scheduledAt: event.scheduledAt,
      sourcesScanned: listing.objects.length,
      orphansMarked: 0,
      listingTruncated: true,
      note: "Orphan detection skipped: a partial listing would wrongly orphan live derivatives.",
    });
  }

  const { rowCount: marked } = await pool.query(
    `UPDATE blocks_image_derivatives.derivatives
     SET status = 'orphaned', orphaned_at = now()
     WHERE source_bucket = $1
       AND orphaned_at IS NULL
       AND NOT (source_key = ANY($2::text[]))`,
    [sourceBucket, listing.objects.map((o) => o.key)],
  );

  // Delete a bounded batch of orphaned derivatives from storage, then their rows, so orphaned bytes
  // stop accruing cost. Bounded per run (§6) rather than deleting everything in one invocation.
  const { rows: orphans } = await pool.query<{ id: string; derivative_bucket: string; derivative_key: string }>(
    `SELECT id, derivative_bucket, derivative_key
     FROM blocks_image_derivatives.derivatives
     WHERE status = 'orphaned'
     ORDER BY orphaned_at
     LIMIT 500`,
  );
  let deleted = 0;
  for (const o of orphans) {
    try {
      await storage.deleteObject(o.derivative_bucket, o.derivative_key);
      await pool.query(`DELETE FROM blocks_image_derivatives.derivatives WHERE id = $1`, [o.id]);
      deleted++;
    } catch (err) {
      log.warn("failed to delete orphaned derivative", {
        key: o.derivative_key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return json({
    ok: true,
    scheduledAt: event.scheduledAt,
    sourcesScanned: listing.objects.length,
    orphansMarked: marked ?? 0,
    orphansDeleted: deleted,
  });
});

router.get("/derivatives", async (_request, ctx) => {
  const sourceKey = ctx.url.searchParams.get("key");
  if (!sourceKey) throw new ValidationError("?key= is required");

  const { rows } = await getPool().query(
    `SELECT width, height, format, fit, status, derivative_bytes, hit_count,
            last_served_at, generated_at
     FROM blocks_image_derivatives.derivatives
     WHERE source_key = $1
     ORDER BY width, format`,
    [sourceKey],
  );

  return json({ sourceKey, count: rows.length, derivatives: rows });
});

router.get("/health", async () => {
  const report = await checkHealth(getPool(), {
    block: "image-derivatives",
    schema: "blocks_image_derivatives",
    evaluate: (status) => {
      const problems: string[] = [];

      const stuck = Number(status["derivatives_stuck"] ?? 0);
      const failed = Number(status["derivatives_failed"] ?? 0);
      const orphaned = Number(status["derivatives_orphaned"] ?? 0);
      const orphanedBytes = Number(status["orphaned_bytes"] ?? 0);
      const neverServed = Number(status["derivatives_never_served"] ?? 0);

      if (stuck > 0) problems.push(`${stuck} derivative(s) stuck generating for over an hour`);
      if (failed > 0) problems.push(`${failed} derivative(s) failed to generate`);
      if (orphaned > 0) {
        // Real money spent on files nothing references.
        problems.push(
          `${orphaned} orphaned derivative(s) holding ${Math.round(orphanedBytes / 1_048_576)} MiB; ` +
            `their sources are gone and you are still paying to store them`,
        );
      }
      if (neverServed > 100) {
        problems.push(
          `${neverServed} derivative(s) generated over a week ago have never been served, which ` +
            `suggests sizes are being produced that nobody requests`,
        );
      }
      return problems;
    },
  });

  return json(report, { status: report.status === "ok" ? 200 : 503 });
});

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new ValidationError("Request body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value === "") {
    throw new ValidationError(`"${key}" is required and must be a non-empty string`);
  }
  return value;
}

export default {
  fetch: (request: Request): Promise<Response> => router.handle(request),
};

// Re-exported so unit tests can import the pure logic directly.
export { loadImagesConfig, SPEC } from "./config.js";
export { parseTransform, derivativeKeyFor } from "./transform.js";
export { readImageDimensions, withinPixelBudget, stripJpegMetadata } from "./image.js";
export { generateDerivative, setCodec, CodecNotConfiguredError } from "./resize.js";
