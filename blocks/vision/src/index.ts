/**
 * Block 9 — AI Vision Enrichment.
 *
 * Tags, captions, alt text, and OCR for uploaded images. Network-bound, so it bills at the waiting
 * rate and is one of the cheapest blocks per unit of value — ranked deliberately above the
 * CPU-bound image work in block 23.
 *
 * Auto alt text is the underrated part: accessibility compliance is a real obligation, and nobody
 * writes alt text for user-uploaded images by hand.
 *
 * Routes:
 *   POST /analyze    storage trigger, or queue-driven — analyse one image
 *   POST /reconcile  cron — retry failures, find images the trigger missed
 *   GET  /search     tag and OCR search over analysed images
 *   GET  /health     observability
 */

import {
  assertTriggerAuthentic,
  checkHealth,
  createLogger,
  getPool,
  json,
  loadConfig,
  parseTriggerEvent,
  parseTriggerRequest,
  problem,
  Router,
  ValidationError,
  type Logger,
  type Queryable,
} from "@neon-blocks/core";
import { autoMigrate } from "@neon-blocks/migrate";
import { defaultChat } from "@neon-blocks/ai";
import { detectKind, extensionOf, ObjectNotFoundError, StorageClient } from "@neon-blocks/storage";
import { analyzeImage, type AnalysisKind } from "./analyze.js";

const log: Logger = createLogger({ block: "vision" });

const SPEC = {
  block: "vision",
  required: ["VISION_BUCKET"],
  optional: {
    VISION_PREFIX: "uploads/",
    VISION_MODEL: "gpt-5-mini",
    VISION_OUTPUTS: "tags,caption,altText,ocr",
    VISION_MAX_TAGS: "12",
    VISION_MAX_BYTES: "20971520",
    VISION_URL_TTL_SECONDS: "300",
  },
} as const;

const VALID_OUTPUTS: readonly AnalysisKind[] = ["tags", "caption", "altText", "ocr", "colors"];

function config() {
  const raw = loadConfig(SPEC);

  const outputs = raw
    .get("VISION_OUTPUTS")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

  for (const output of outputs) {
    if (!VALID_OUTPUTS.includes(output as AnalysisKind)) {
      throw new ValidationError(
        `VISION_OUTPUTS contains unknown output "${output}". Valid: ${VALID_OUTPUTS.join(", ")}.`,
      );
    }
  }
  if (outputs.length === 0) {
    throw new ValidationError("VISION_OUTPUTS is empty; there would be nothing to analyse.");
  }

  return {
    bucket: raw.get("VISION_BUCKET"),
    prefix: raw.get("VISION_PREFIX"),
    model: raw.get("VISION_MODEL"),
    outputs: outputs as AnalysisKind[],
    maxTags: raw.int("VISION_MAX_TAGS", { min: 1, max: 50 }),
    maxBytes: raw.int("VISION_MAX_BYTES", { min: 1_024 }),
    // Short-lived: the URL is handed to a third-party model provider, so it should expire quickly.
    urlTtlSeconds: raw.int("VISION_URL_TTL_SECONDS", { min: 60, max: 3_600 }),
  };
}

const router = new Router();

router.post("/analyze", async (request) => {
  assertTriggerAuthentic(request, { requireSecret: false });

  // DIAGNOSTIC: Neon's storage-trigger delivery does not match the assumed
  // { type: "storage_object_created", data: { bucket_name, object_key } } shape — it parses with no
  // type, so /analyze rejected it as wrong_trigger. Capture the raw delivery (query + headers + body,
  // secrets redacted) so we can read the real field names and fix the parser. To be removed once the
  // contract is known.
  const rawBody = await request.text();
  const url = new URL(request.url);
  const query: Record<string, string> = {};
  for (const [k, v] of url.searchParams) query[k] = /secret|token|key/i.test(k) ? "<redacted>" : v;
  const headers: Record<string, string> = {};
  for (const [k, v] of request.headers) {
    headers[k] = /secret|token|authorization|cookie/i.test(k) ? "<redacted>" : v;
  }
  log.info("analyze raw delivery", { method: request.method, path: url.pathname, query, headers, body: rawBody.slice(0, 4000) });

  let parsedBody: unknown = {};
  if (rawBody.trim() !== "") {
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      /* logged above as raw text */
    }
  }
  const event = parseTriggerEvent(parsedBody, request.headers);

  log.info("analyze invoked", {
    type: event.type,
    bucketName: event.type === "storage_object_created" ? event.bucketName : undefined,
    objectKey: event.type === "storage_object_created" ? event.objectKey : undefined,
  });

  if (event.type !== "storage_object_created") {
    log.warn("analyze got a non-storage trigger", { type: event.type });
    return problem(400, "wrong_trigger", `/analyze expects a storage trigger, got ${event.type}`);
  }

  const cfg = config();
  if (event.bucketName !== cfg.bucket) {
    log.warn("analyze got an event for a different bucket", {
      eventBucket: event.bucketName,
      configuredBucket: cfg.bucket,
    });
    return problem(403, "wrong_bucket", `This function only analyses "${cfg.bucket}"`);
  }

  const result = await analyzeObject(getPool(), {
    bucket: event.bucketName,
    objectKey: event.objectKey,
    cfg,
    logger: log.child({ objectKey: event.objectKey }),
  });

  log.info("analyze finished", { objectKey: event.objectKey, status: result.status, reason: result.reason });
  return json({ ok: true, ...result });
});

router.post("/reconcile", async (request) => {
  assertTriggerAuthentic(request);
  const event = await parseTriggerRequest(request);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", `/reconcile expects a schedule trigger, got ${event.type}`);
  }

  const cfg = config();
  const pool = getPool();
  const storage = StorageClient.fromEnv();

  // Missed deliveries: list the bucket and diff against analysed (key, etag) pairs. Keep keys that
  // look like images by extension AND extensionless keys (their content-type decides in
  // analyzeObject), so an extensionless image upload isn't pre-filtered out here the way a bare
  // key would be. analyzeObject records a skip for anything that turns out not to be an image.
  const listing = await storage.listObjects(cfg.bucket, { prefix: cfg.prefix, maxKeys: 500 });
  const images = listing.objects.filter(
    (o) => detectKind({ key: o.key }) === "image" || extensionOf(o.key) === undefined,
  );

  let analyzed = 0;
  let failed = 0;

  if (images.length > 0) {
    const { rows } = await pool.query<{ object_key: string; etag: string }>(
      `SELECT object_key, etag FROM blocks_vision.analyses
       WHERE bucket_name = $1 AND object_key = ANY($2::text[])
         AND status IN ('ready', 'skipped')`,
      [cfg.bucket, images.map((o) => o.key)],
    );
    const done = new Set(rows.map((r) => `${r.object_key} ${r.etag}`));

    // Bounded per run: each analysis is a model call, so an unbounded backlog sweep could spend
    // real money in one invocation.
    const pending = images.filter((o) => !done.has(`${o.key} ${o.etag}`)).slice(0, 10);

    for (const image of pending) {
      try {
        const result = await analyzeObject(pool, {
          bucket: cfg.bucket,
          objectKey: image.key,
          cfg,
          logger: log.child({ objectKey: image.key, via: "reconcile" }),
        });
        if (result.status === "ready") analyzed++;
      } catch (err) {
        failed++;
        log.error("reconcile analysis failed", {
          objectKey: image.key,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (images.filter((o) => !done.has(`${o.key} ${o.etag}`)).length > pending.length) {
      log.capped("reconcile analysis batch limited to bound model spend", {
        found: images.length - done.size,
        analyzed: pending.length,
      });
    }
  }

  return json({
    ok: true,
    scheduledAt: event.scheduledAt,
    imagesScanned: images.length,
    analyzedNow: analyzed,
    failed,
    listingTruncated: listing.nextContinuationToken !== null,
  });
});

router.get("/search", async (_request, ctx) => {
  const tags = ctx.url.searchParams.get("tags");
  const text = ctx.url.searchParams.get("text");
  if (!tags && !text) throw new ValidationError("Provide ?tags= or ?text=");

  const limit = Math.min(Number(ctx.url.searchParams.get("limit") ?? "25"), 200);

  interface Row {
    [column: string]: unknown;
    object_key: string;
    tags: string[];
    caption: string | null;
    alt_text: string | null;
    confidence: number | null;
  }

  // Tag search uses @> against the GIN index; text search uses the generated tsvector over OCR plus
  // caption, which is what makes text *inside* images findable.
  const { rows } = await getPool().query<Row>(
    `SELECT object_key, tags, caption, alt_text, confidence
     FROM blocks_vision.analyses
     WHERE status = 'ready'
       AND ($1::text[] IS NULL OR tags @> $1::text[])
       AND ($2::text IS NULL OR search_tsv @@ websearch_to_tsquery('english', $2))
     ORDER BY confidence DESC NULLS LAST
     LIMIT $3`,
    [
      tags ? tags.split(",").map((t) => t.trim().toLowerCase()) : null,
      text,
      limit,
    ],
  );

  return json({ count: rows.length, results: rows });
});

router.get("/health", async () => {
  const report = await checkHealth(getPool(), {
    block: "vision",
    schema: "blocks_vision",
    evaluate: (status) => {
      const problems: string[] = [];
      const failed = Number(status["analyses_failed"] ?? 0);
      const missingAlt = Number(status["missing_alt_text"] ?? 0);
      const lowConfidence = Number(status["low_confidence"] ?? 0);

      if (failed > 0) problems.push(`${failed} analysis/analyses failed`);
      if (missingAlt > 0) {
        // The accessibility gap this block exists to close, so it is reported rather than inferred.
        problems.push(
          `${missingAlt} analysed image(s) have no alt text. Note that empty-string alt text is ` +
            `valid (decorative) and is not counted here.`,
        );
      }
      if (lowConfidence > 0) {
        problems.push(
          `${lowConfidence} analysis/analyses reported confidence below 0.5 and are worth human review`,
        );
      }
      return problems;
    },
  });

  return json(report, { status: report.status === "ok" ? 200 : 503 });
});

type Cfg = ReturnType<typeof config>;

interface AnalyzeResult {
  status: "ready" | "skipped" | "failed";
  objectKey: string;
  reason?: string;
  tags?: string[];
}

/**
 * Analyse one object.
 *
 * The image URL is presigned and handed to the model provider rather than downloading the bytes and
 * re-uploading them: that would double the transfer and hold the function open for the whole
 * upload, converting cheap waiting time into more waiting time and more egress.
 */
async function analyzeObject(
  db: Queryable,
  opts: { bucket: string; objectKey: string; cfg: Cfg; logger: Logger },
): Promise<AnalyzeResult> {
  const { bucket, objectKey, cfg, logger } = opts;
  const storage = StorageClient.fromEnv();

  // HEAD first — it confirms the object exists AND gives us the content-type. Classifying on the
  // key alone silently drops the very common case of an extensionless upload (SDKs store a bare
  // id/UUID with `content-type: image/*` and no suffix), which would vanish with no row written.
  let metadata;
  try {
    metadata = await storage.headVerified(bucket, objectKey);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      // The trigger just told us this object was created, so a 404 here almost always means a
      // config mismatch — wrong VISION_BUCKET, a prefix the key does/doesn't carry, or storage
      // creds for a different branch — not a forged event. Log what we actually looked for.
      logger.warn("HEAD 404 for a trigger-delivered object; check bucket/key/prefix config", {
        bucket,
        objectKey,
      });
      return { status: "skipped", objectKey, reason: "object does not exist" };
    }
    throw err;
  }

  // No suffix filter on storage triggers, so non-images arrive here as a matter of course. Use the
  // content-type from the HEAD, falling back to the key extension. Record the skip so a non-image
  // upload is visible in analyses/health with a reason, instead of ending with nothing to show.
  const kind = detectKind({ key: objectKey, contentType: metadata.contentType });
  if (kind !== "image") {
    await record(db, { bucket, objectKey, etag: metadata.etag, status: "skipped" }, {
      error: `not an image (kind=${kind}, content-type=${metadata.contentType || "unknown"})`,
    });
    logger.info("skipped non-image object", { kind, contentType: metadata.contentType });
    return { status: "skipped", objectKey, reason: "not an image" };
  }

  if (metadata.size > cfg.maxBytes) {
    await record(db, { bucket, objectKey, etag: metadata.etag, status: "skipped" }, {
      error: `image is ${metadata.size} bytes, over the ${cfg.maxBytes} limit`,
    });
    logger.capped("image too large to analyse", { size: metadata.size });
    return { status: "skipped", objectKey, reason: "over size limit" };
  }

  // Skip if already analysed at this exact etag — each analysis is a paid model call.
  const { rows: existing } = await db.query<{ status: string }>(
    `SELECT status FROM blocks_vision.analyses
     WHERE bucket_name = $1 AND object_key = $2 AND etag = $3 AND status = 'ready'`,
    [bucket, objectKey, metadata.etag],
  );
  if (existing.length > 0) {
    return { status: "ready", objectKey, reason: "already analysed at this etag" };
  }

  await record(db, { bucket, objectKey, etag: metadata.etag, status: "pending" }, {});

  try {
    const analysis = await analyzeImage(defaultChat({ model: cfg.model }), {
      imageUrl: storage.presignGet(bucket, objectKey, { expiresInSeconds: cfg.urlTtlSeconds }),
      want: cfg.outputs,
      maxTags: cfg.maxTags,
    });

    await db.query(
      `UPDATE blocks_vision.analyses
       SET status = 'ready',
           tags = $4::text[],
           caption = $5,
           alt_text = $6,
           ocr_text = $7,
           dominant_colors = $8::text[],
           confidence = $9,
           model = $10,
           error = NULL,
           analyzed_at = now()
       WHERE bucket_name = $1 AND object_key = $2 AND etag = $3`,
      [
        bucket,
        objectKey,
        metadata.etag,
        analysis.tags,
        analysis.caption,
        analysis.altText,
        analysis.ocrText,
        analysis.dominantColors,
        analysis.confidence,
        analysis.model,
      ],
    );

    logger.info("image analysed", {
      tags: analysis.tags.length,
      hasAltText: analysis.altText !== null,
      hasOcr: analysis.ocrText !== null,
      confidence: analysis.confidence,
    });

    return { status: "ready", objectKey, tags: analysis.tags };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await record(db, { bucket, objectKey, etag: metadata.etag, status: "failed" }, { error: message });
    throw err;
  }
}

async function record(
  db: Queryable,
  key: { bucket: string; objectKey: string; etag: string; status: string },
  fields: { error?: string },
): Promise<void> {
  await db.query(
    `INSERT INTO blocks_vision.analyses (bucket_name, object_key, etag, status, error)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (bucket_name, object_key, etag) DO UPDATE
       SET status = EXCLUDED.status, error = EXCLUDED.error`,
    [key.bucket, key.objectKey, key.etag, key.status, fields.error ?? null],
  );
}

export default autoMigrate({
  block: "vision",
  migrationsUrl: new URL("./migrations/", import.meta.url),
  fetch: (request: Request): Promise<Response> => router.handle(request),
});

export {
  analyzeImage,
  buildPrompt,
  parseAnalysis,
  normalizeTags,
  normalizeColors,
  extractJsonObject,
  type Analysis,
  type AnalysisKind,
} from "./analyze.js";
