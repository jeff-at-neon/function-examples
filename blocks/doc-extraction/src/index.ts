/**
 * Block 16 — Structured Document Extraction.
 *
 * Invoices, receipts, and forms become typed rows with per-field confidence and a human-review queue.
 *
 * High willingness to pay, because the alternative is someone typing invoice totals into a form. The part that makes it usable in production is not the extraction -- it is the confidence scoring and the review queue. An extraction system with no review step either needs a human to check everything, which defeats the purpose, or silently books wrong numbers.
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
  loadConfig,
  NotFoundError,
  parseTriggerEvent,
  problem,
  Router,
  ValidationError,
  type Logger,
} from "@neon-blocks/core";
import { StorageClient, detectKind, ObjectNotFoundError } from "@neon-blocks/storage";

const log: Logger = createLogger({ block: "doc-extraction" });

const SPEC = {
  block: "doc-extraction",
  required: ["EXTRACT_BUCKET"],
  optional: {
    EXTRACT_PREFIX: "documents/",
    EXTRACT_MODEL: "gpt-4o-mini",
    EXTRACT_CONFIDENCE_THRESHOLD: "0.8",
    EXTRACT_MAX_BYTES: "20971520",
  },
} as const;

function config() {
  return loadConfig(SPEC);
}

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
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "storage_object_created") {
    return problem(400, "wrong_trigger", `/extract expects a storage trigger, got ${event.type}`);
  }

  const cfg = config();
  if (event.bucketName !== cfg.get("EXTRACT_BUCKET")) {
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

  const maxBytes = cfg.int("EXTRACT_MAX_BYTES", { min: 1024 });
  if (metadata.size > maxBytes) {
    log.capped("document too large to extract", { size: metadata.size, maxBytes });
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

  // TODO(doc-extraction): the extraction call.
  //   1. load the schema for this document type and generate a prompt from schemas.fields --
  //      including each field's description, which is prompt text as much as documentation
  //   2. request a per-field confidence alongside each value, not one document-level score
  //   3. parse tolerantly, mirroring block 9's extractJsonObject (fences, prose, nested braces)
  //   4. fields below EXTRACT_CONFIDENCE_THRESHOLD go to review_queue; the rest apply.
  //      That split is what makes this save labour rather than relocate it.
  //   5. set status to 'needs_review' when any field queued, else 'ready'
  return problem(
    501,
    "not_implemented",
    "Extraction is not yet wired. See the TODO in src/index.ts. The confidence-per-field split and " +
      "the review queue are the design decisions that matter and are already in the schema.",
  );
});

router.post("/reconcile", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
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

export default {
  fetch: (request: Request): Promise<Response> => router.handle(request),
};
