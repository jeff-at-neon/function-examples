/**
 * Block 23 — Image Derivatives.
 *
 * Thumbnails and transforms with EXIF stripping, generated on read and cached, not eagerly on upload.
 *
 * Table stakes, not a differentiator: Cloudflare Images and Vercel do this well, and being next
 * to Postgres buys nothing for pixel pushing. It is here so nobody asks why the catalog cannot do
 * the obvious thing. Its real value is the registry join -- "every image this tenant owns and
 * whether its thumbnail exists" -- rather than the resizing itself.
 * 
 * Ranked at 23 for packaging, not cost. The economics are fine: active Capacity-Hours are 4x
 * waiting, not 40x, which works out around $16-26 per million images -- roughly 1.3-2x Lambda and
 * some 30x cheaper than Cloudinary. The blocker is that the default esbuild bundle cannot load
 * native .node binaries, so sharp breaks the one-command install.
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
  loadConfig,
  NotFoundError,
  parseTriggerEvent,
  problem,
  Router,
  ValidationError,
  type Logger,
} from "@neon-blocks/core";
import { StorageClient, detectKind, ObjectNotFoundError } from "@neon-blocks/storage";

const log: Logger = createLogger({ block: "image-derivatives" });

const SPEC = {
  block: "image-derivatives",
  required: ["IMAGES_SOURCE_BUCKET"],
  optional: {
    IMAGES_SOURCE_PREFIX: "uploads/",
    IMAGES_DERIVATIVE_BUCKET: "",
    IMAGES_DERIVATIVE_PREFIX: "derived/",
    IMAGES_MAX_PIXELS: "40000000",
    IMAGES_MAX_BYTES: "26214400",
    IMAGES_ALLOWED_WIDTHS: "64,128,256,512,1024,2048",
    IMAGES_CACHE_CONTROL: "public, max-age=31536000, immutable",
  },
} as const;

function config() {
  return loadConfig(SPEC);
}

const router = new Router();

/**
 * Validate transform parameters against the allowlist.
 *
 * An allowlist rather than a range, deliberately. Arbitrary widths let a caller request 10,000
 * distinct sizes of one image and bill you for every one -- on a public endpoint that is a
 * cost-amplification attack, not a hypothetical.
 */
export function parseTransform(
  params: URLSearchParams,
  allowedWidths: readonly number[],
): { width: number; height: number | null; format: string; fit: string } {
  const widthRaw = params.get("w");
  if (!widthRaw) throw new ValidationError("?w= (width) is required");

  const width = Number(widthRaw);
  if (!allowedWidths.includes(width)) {
    throw new ValidationError(
      `Width ${widthRaw} is not permitted. Allowed: ${allowedWidths.join(", ")}. This is an ` +
        `allowlist because arbitrary widths let a caller generate unlimited derivatives at your expense.`,
    );
  }

  const heightRaw = params.get("h");
  const height = heightRaw ? Number(heightRaw) : null;
  if (height !== null && (!Number.isInteger(height) || height < 1 || height > 8192)) {
    throw new ValidationError("?h= must be an integer between 1 and 8192");
  }

  const format = params.get("f") ?? "webp";
  if (!["webp", "jpeg", "png", "avif"].includes(format)) {
    throw new ValidationError("?f= must be one of webp, jpeg, png, avif");
  }

  const fit = params.get("fit") ?? "cover";
  if (!["cover", "contain", "fill", "inside"].includes(fit)) {
    throw new ValidationError("?fit= must be one of cover, contain, fill, inside");
  }

  return { width, height, format, fit };
}

/** Derivative key, derived from the source, the etag, and every transform parameter. */
export function derivativeKeyFor(
  prefix: string,
  sourceKey: string,
  etag: string,
  t: { width: number; height: number | null; format: string; fit: string },
): string {
  const base = sourceKey.replace(/\.[^./]+$/, "").replace(/^.*\//, "");
  const dims = t.height === null ? `w${t.width}` : `w${t.width}h${t.height}`;
  // The etag is in the key, so an overwritten source cannot serve a stale derivative: the new etag
  // simply misses and regenerates.
  return `${prefix}${base}-${dims}-${t.fit}-${etag.slice(0, 8)}.${t.format}`;
}

router.get("/i/:key", async (_request, ctx) => {
  const cfg = config();
  const sourceKey = ctx.params["key"]!;

  const allowedWidths = cfg
    .get("IMAGES_ALLOWED_WIDTHS")
    .split(",")
    .map((w) => Number(w.trim()))
    .filter((w) => Number.isInteger(w) && w > 0);

  const transform = parseTransform(ctx.url.searchParams, allowedWidths);

  const sourceBucket = cfg.get("IMAGES_SOURCE_BUCKET");
  const derivativeBucket = cfg.get("IMAGES_DERIVATIVE_BUCKET") || sourceBucket;
  const derivativePrefix = cfg.get("IMAGES_DERIVATIVE_PREFIX");

  // §8, checked here as well as at startup. Writing derivatives into the watched bucket retriggers
  // the pipeline forever and there is no negative prefix filter to stop it.
  assertNoLoop({
    inputBucket: sourceBucket,
    inputPrefix: cfg.get("IMAGES_SOURCE_PREFIX"),
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

  const maxBytes = cfg.int("IMAGES_MAX_BYTES", { min: 1024 });
  if (sourceMeta.size > maxBytes) {
    return problem(
      413,
      "source_too_large",
      `Source is ${sourceMeta.size} bytes, over the ${maxBytes} limit. Functions run at a fixed ` +
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
        "cache-control": cfg.get("IMAGES_CACHE_CONTROL"),
      },
    });
  }

  void derivativeKey;

  // TODO(image-derivatives): the resize.
  //   1. GET the source, bounded by IMAGES_MAX_BYTES
  //   2. read dimensions and reject if width*height > IMAGES_MAX_PIXELS. This must happen BEFORE
  //      decoding: a 40KB PNG can decode to 30000x30000 and exhaust memory instantly, which a byte
  //      limit does not catch.
  //   3. resize with WASM libvips (default) or native sharp (opt-in, needs bundler: "none" plus a
  //      platform-matched node_modules -- and unbundled deploys cannot ship TypeScript)
  //   4. strip EXIF and GPS unconditionally. A phone photo carries the coordinates where it was
  //      taken, and serving that with an avatar is a privacy leak nobody remembers to handle.
  //   5. PUT to derivativeBucket/derivativeKey and record the row as ready
  //
  //   Without a CDN in front of this endpoint every request is a billed invocation.
  //   Transform-on-read is only economical with edge caching.
  return problem(
    501,
    "not_implemented",
    "Resizing is not yet wired. See the TODO in src/index.ts. The cache lookup, loop guard, and " +
      "dimension validation above are real; the WASM-vs-native choice determines packaging, since " +
      "the default esbuild bundle cannot load native .node binaries.",
  );
});

router.post("/reconcile", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", `/reconcile expects a schedule trigger, got ${event.type}`);
  }

  const cfg = config();
  const storage = StorageClient.fromEnv();
  const pool = getPool();
  const sourceBucket = cfg.get("IMAGES_SOURCE_BUCKET");

  // No storage delete events exist, so orphans are detected by absence. Without this a deleted
  // source leaves its derivatives on disk forever and you keep paying for them.
  const listing = await storage.listObjects(sourceBucket, {
    prefix: cfg.get("IMAGES_SOURCE_PREFIX"),
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

  // TODO(image-derivatives): delete orphaned objects from storage, then their rows. Marking works;
  // the storage delete does not, so orphaned bytes are still being paid for -- v_status reports
  // orphaned_bytes so that cost is visible rather than silent.
  return json({
    ok: true,
    scheduledAt: event.scheduledAt,
    sourcesScanned: listing.objects.length,
    orphansMarked: marked ?? 0,
    note: marked ? "Orphans marked; storage deletion is not yet wired." : undefined,
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
