/**
 * Block 16 — Structured Document Extraction.
 *
 * Invoices, receipts, and forms become typed rows with per-field confidence and a human-review queue.
 *
 * The alternative is someone typing invoice totals into a form, so the bar is low -- but the part that makes it usable in production is not the extraction, it is the confidence scoring and the review queue. An extraction system with no review step either needs a human to check everything, which defeats the purpose, or silently books wrong numbers.
 *
 * Routes:
 *   POST   /schemas               Declare what to extract for a document type.
 *   POST   /extract               Storage trigger. Extract one document.
 *   POST   /reconcile             Cron. Retries and missed deliveries.
 *   GET    /review                Fields awaiting review, least confident first.
 *   POST   /review/:id            Submit a correction.
 *
 * STATUS: scaffold. The schema, safety checks, and control flow are real; the marked TODO seams are
 * the remaining work. Endpoints that are not implemented return 501 with a specific explanation
 * rather than failing in a way that looks like a bug.
 */

import {
  assertTriggerAuthentic,
  checkHealth,
  createLogger,
  getPool,
  json,
  NotFoundError,
  parseTriggerRequest,
  problem,
  Router,
  ValidationError,
  type Logger,
} from "@neon-blocks/core";
import { autoMigrate } from "@neon-blocks/migrate";
import { StorageClient, detectKind, ObjectNotFoundError } from "@neon-blocks/storage";
import { defaultChat } from "@neon-blocks/ai";
import { loadExtractConfig } from "./config.js";
import { runExtraction } from "./run.js";

const log: Logger = createLogger({ block: "doc-extraction" });

const router = new Router();

router.post("/schemas", async (request) => {
  const body = await readJsonObject(request);
  const fields = body["fields"];
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    throw new ValidationError('"fields" must be an object mapping field name to {type, required}');
  }

  await getPool().query(
    `INSERT INTO blocks_doc_extraction.schemas (code, description, fields)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description, fields = EXCLUDED.fields`,
    [requireString(body, "code"), body["description"] ?? null, JSON.stringify(fields)],
  );

  return json({ declared: body["code"], fieldCount: Object.keys(fields).length }, { status: 201 });
});

router.post("/extract", async (request) => {
  assertTriggerAuthentic(request, { requireSecret: false });
  const event = await parseTriggerRequest(request);
  if (event.type !== "storage_object_created") {
    return problem(400, "wrong_trigger", `/extract expects a storage trigger, got ${event.type}`);
  }

  const cfg = loadExtractConfig();
  if (event.bucketName !== cfg.bucket) {
    return problem(403, "wrong_bucket", "This function only handles its configured bucket");
  }

  const storage = StorageClient.fromEnv();
  const kind = detectKind({ key: event.objectKey });

  // No suffix filter on storage triggers, so everything under the prefix arrives here.
  if (kind !== "image" && kind !== "pdf") {
    return json({ ok: true, status: "skipped", reason: `${kind} is not an extractable document` });
  }

  // HEAD-verify: trigger delivery is unauthenticated (§7), and each extraction costs a model call,
  // so a forged event would cost real money.
  let metadata;
  try {
    metadata = await storage.headVerified(event.bucketName, event.objectKey);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      return json({ ok: true, status: "skipped", reason: "object does not exist" });
    }
    throw err;
  }

  if (metadata.size > cfg.maxBytes) {
    log.capped("document too large to extract", { size: metadata.size, maxBytes: cfg.maxBytes });
    return json({ ok: true, status: "skipped", reason: "over size limit" });
  }

  if (kind === "pdf") {
    // Stated rather than silently attempted: a born-digital PDF is not an image, and sending its
    // bytes to a vision model produces nothing useful.
    return json({
      ok: true,
      status: "skipped",
      reason:
        "PDF rendering is not wired. Scanned images work; born-digital PDFs need text extraction " +
        "(see block 2's parser seam) or rasterisation.",
    });
  }

  // Generate a prompt from the schema's fields, call the vision model through the Neon AI Gateway,
  // parse tolerantly, and split by per-field confidence — fields below the threshold go to the
  // review queue, the rest apply. The prompt/parse/split are pure and tested; the model call is the
  // thin edge.
  const result = await runExtraction(
    { db: getPool(), storage, chat: defaultChat({ model: cfg.model }) },
    { event: { bucketName: event.bucketName, objectKey: event.objectKey, etag: metadata.etag }, cfg },
  );
  return json({ ok: true, ...result });
});

router.post("/reconcile", async (request) => {
  assertTriggerAuthentic(request);
  const event = await parseTriggerRequest(request);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", `/reconcile expects a schedule trigger, got ${event.type}`);
  }

  // Reset extractions abandoned mid-run. Complete and useful on its own: without it, a function that
  // dies mid-extraction leaves the document in limbo forever.
  const { rowCount } = await getPool().query(
    `UPDATE blocks_doc_extraction.extractions
     SET status = 'pending', error = 'reset by reconciler: stuck in ' || status
     WHERE status IN ('pending', 'extracting') AND updated_at < now() - interval '1 hour'`,
  );

  return json({ ok: true, scheduledAt: event.scheduledAt, stuckReset: rowCount ?? 0 });
});

router.get("/review", async (_request, ctx) => {
  const limit = Math.min(Number(ctx.url.searchParams.get("limit") ?? "50"), 500);

  // Least confident first: that ordering is what makes a review queue efficient to work.
  const { rows } = await getPool().query(
    `SELECT r.id, r.extraction_id, r.field_name, r.extracted_value, r.confidence,
            e.object_key, e.schema_code
     FROM blocks_doc_extraction.review_queue r
     JOIN blocks_doc_extraction.extractions e ON e.id = r.extraction_id
     WHERE r.reviewed_at IS NULL
     ORDER BY r.confidence ASC NULLS FIRST, r.created_at
     LIMIT $1`,
    [limit],
  );

  return json({ count: rows.length, queue: rows });
});

router.post("/review/:id", async (request, ctx) => {
  const body = await readJsonObject(request);
  const corrected = body["correctedValue"];
  if (typeof corrected !== "string") {
    throw new ValidationError('"correctedValue" is required and must be a string');
  }

  // The correction is stored alongside the extraction, never overwriting it. The pair is the audit
  // trail: "the model said 1,240.00 and a human changed it to 1,204.00".
  const { rowCount } = await getPool().query(
    `UPDATE blocks_doc_extraction.review_queue
     SET corrected_value = $2, reviewed_by = $3, reviewed_at = now()
     WHERE id = $1 AND reviewed_at IS NULL`,
    [ctx.params["id"], corrected, typeof body["reviewedBy"] === "string" ? body["reviewedBy"] : null],
  );

  if ((rowCount ?? 0) === 0) throw new NotFoundError("No such unreviewed queue item");
  return json({ reviewed: ctx.params["id"] });
});

router.get("/health", async () => {
  const report = await checkHealth(getPool(), {
    block: "doc-extraction",
    schema: "blocks_doc_extraction",
    evaluate: (status) => {
      const problems: string[] = [];

      const stuck = Number(status["extractions_stuck"] ?? 0);
      const failed = Number(status["extractions_failed"] ?? 0);
      const reviewStale = Number(status["review_stale"] ?? 0);
      const schemas = Number(status["schemas_count"] ?? 0);

      if (schemas === 0) {
        problems.push("no extraction schemas declared; there is nothing to extract");
      }
      if (stuck > 0) problems.push(`${stuck} extraction(s) stuck mid-run for over an hour`);
      if (failed > 0) problems.push(`${failed} extraction(s) failed`);
      if (reviewStale > 0) {
        // An extraction pipeline whose review queue is never worked is just a slower manual process.
        problems.push(
          `${reviewStale} review item(s) have been waiting over 7 days; an unworked review queue ` +
            `means this pipeline is not saving labour`,
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

export default autoMigrate({
  block: "doc-extraction",
  migrationsUrl: new URL("./migrations/", import.meta.url),
  fetch: (request: Request): Promise<Response> => router.handle(request),
});

// Re-exported so unit tests can import the pure logic directly.
export { loadExtractConfig, SPEC } from "./config.js";
export { schemaCodeFromKey, buildExtractionPrompt, extractJsonObject, splitByConfidence } from "./extract.js";
export { runExtraction } from "./run.js";
