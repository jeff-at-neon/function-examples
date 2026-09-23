/**
 * Block 18 — Moderation and Quarantine.
 *
 * Classifies uploads and text for abuse, and quarantines by default so unreviewed content is never served.
 *
 * A trust-and-safety requirement for any app with user-generated content, and the one design decision that matters is fail-closed: content is quarantined until it passes, not served until it fails. Fail-open moderation means the window between upload and classification is a window in which anything can be served, and that window is exactly when abuse is posted.
 *
 * Routes:
 *   POST   /scan                  Storage trigger. Classify an upload.
 *   POST   /text                  Classify inline text synchronously.
 *   POST   /reconcile             Cron. Rescan stuck items.
 *   GET    /review                Items awaiting human review.
 *   POST   /decide/:id            Record a human decision.
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
import { defaultChat } from "@neon-blocks/ai";
import { loadModerationConfig } from "./config.js";
import { classifyImageItem, classifyTextItem } from "./run.js";

const log: Logger = createLogger({ block: "moderation" });

const router = new Router();

router.post("/scan", async (request) => {
  assertTriggerAuthentic(request, { requireSecret: false });
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "storage_object_created") {
    return problem(400, "wrong_trigger", `/scan expects a storage trigger, got ${event.type}`);
  }

  const cfg = loadModerationConfig();
  if (event.bucketName !== cfg.bucket) {
    return problem(403, "wrong_bucket", "This function only moderates its configured bucket");
  }

  // §8: quarantined objects are moved within storage, so the quarantine prefix must be disjoint from
  // the watched prefix or moving an object would retrigger moderation of itself, forever.
  assertNoLoop({
    inputBucket: cfg.bucket,
    inputPrefix: cfg.prefix,
    outputBucket: cfg.bucket,
    outputPrefix: cfg.quarantinePrefix,
  });

  const storage = StorageClient.fromEnv();

  let metadata;
  try {
    metadata = await storage.headVerified(event.bucketName, event.objectKey);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      return json({ ok: true, status: "skipped", reason: "object does not exist" });
    }
    throw err;
  }

  const kind = detectKind({ key: event.objectKey, contentType: metadata.contentType });

  // Recorded as quarantined FIRST, before any classification. If this function dies mid-scan the
  // object stays quarantined, which is the safe direction -- the failure mode is a user's upload not
  // appearing, not unmoderated content being served.
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO blocks_moderation.items (bucket_name, object_key, etag, kind, status)
     VALUES ($1, $2, $3, $4, 'quarantined')
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [event.bucketName, event.objectKey, metadata.etag, kind === "unknown" ? "other" : kind],
  );

  const itemId = rows[0]?.id;
  // No row means this (bucket,key,etag) was already recorded — deliberate, not an error.
  if (!itemId) return json({ ok: true, status: "skipped", reason: "already recorded" });

  // Only images are classified by the vision model. Other kinds (video, document) stay quarantined
  // — fail-closed — with malware scanning explicitly out of scope (needs a real engine, not an LLM).
  if (kind !== "image") {
    return json({ ok: true, itemId, status: "quarantined", reason: `${kind} is not model-classifiable here` });
  }

  const decision = await classifyImageItem(
    { db: getPool(), storage, chat: defaultChat({ model: cfg.model }) },
    { itemId, bucket: event.bucketName, key: event.objectKey, cfg },
  );
  return json({ ok: true, itemId, status: decision.status, flagged: decision.flagged });
});

router.post("/text", async (request) => {
  const body = await readJsonObject(request);
  const text = requireString(body, "text");

  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO blocks_moderation.items (content_text, kind, status)
     VALUES ($1, 'text', 'quarantined') RETURNING id`,
    [text.slice(0, 100_000)],
  );
  const itemId = rows[0]?.id;
  if (!itemId) return problem(500, "item_not_created", "Could not record the item");

  const cfg = loadModerationConfig();
  const decision = await classifyTextItem(
    { db: getPool(), chat: defaultChat({ model: cfg.model }) },
    { itemId, text, cfg },
  );
  return json({ itemId, status: decision.status, flagged: decision.flagged }, { status: 202 });
});

router.post("/reconcile", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", `/reconcile expects a schedule trigger, got ${event.type}`);
  }

  // Reset items abandoned mid-scan so they are classified rather than sitting quarantined forever.
  // Load-bearing for this block specifically: because it fails closed, a missed delivery is a user's
  // upload that never appeared.
  const { rowCount } = await getPool().query(
    `UPDATE blocks_moderation.items
     SET status = 'quarantined', error = 'reset by reconciler: stuck in scanning'
     WHERE status = 'scanning' AND updated_at < now() - interval '1 hour'`,
  );

  return json({ ok: true, scheduledAt: event.scheduledAt, stuckReset: rowCount ?? 0 });
});

router.get("/review", async (_request, ctx) => {
  const limit = Math.min(Number(ctx.url.searchParams.get("limit") ?? "50"), 500);
  const { rows } = await getPool().query(
    `SELECT id, bucket_name, object_key, kind, status, scores, flagged, created_at
     FROM blocks_moderation.items
     WHERE status IN ('needs_review', 'quarantined')
     ORDER BY created_at
     LIMIT $1`,
    [limit],
  );
  return json({ count: rows.length, queue: rows });
});

router.post("/decide/:id", async (request, ctx) => {
  const body = await readJsonObject(request);
  const decision = requireString(body, "decision");
  if (!["approve", "block", "escalate"].includes(decision)) {
    throw new ValidationError('"decision" must be one of approve, block, escalate');
  }

  const pool = getPool();

  // A human decision overrides the model score. Recorded with source='human' so the override is
  // visible -- which is what you need when a decision is challenged.
  const { rowCount } = await pool.query(
    `UPDATE blocks_moderation.items
     SET status = CASE $2
                    WHEN 'approve' THEN 'approved'
                    WHEN 'block' THEN 'blocked'
                    ELSE 'needs_review' END,
         decided_at = now()
     WHERE id = $1`,
    [ctx.params["id"], decision],
  );
  if ((rowCount ?? 0) === 0) throw new NotFoundError("No such item");

  await pool.query(
    `INSERT INTO blocks_moderation.decisions (item_id, decision, source, actor, reason)
     VALUES ($1, $2, 'human', $3, $4)`,
    [
      ctx.params["id"],
      decision,
      typeof body["actor"] === "string" ? body["actor"] : null,
      typeof body["reason"] === "string" ? body["reason"] : null,
    ],
  );

  return json({ itemId: ctx.params["id"], decision, source: "human" });
});

router.get("/health", async () => {
  const report = await checkHealth(getPool(), {
    block: "moderation",
    schema: "blocks_moderation",
    evaluate: (status) => {
      const problems: string[] = [];

      const stuck = Number(status["items_stuck"] ?? 0);
      const failed = Number(status["items_failed"] ?? 0);
      const infected = Number(status["items_infected"] ?? 0);
      const review = Number(status["items_needs_review"] ?? 0);

      if (infected > 0) problems.push(`${infected} item(s) are flagged as infected`);
      if (stuck > 0) {
        // Fail-closed means a stuck item is a functional bug, not a safety gap.
        problems.push(
          `${stuck} item(s) stuck in quarantine for over an hour. Because this block fails closed, ` +
            `those are uploads that never became visible to their owners.`,
        );
      }
      if (failed > 0) problems.push(`${failed} item(s) failed classification and remain quarantined`);
      if (review > 50) problems.push(`${review} item(s) awaiting human review`);
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
export { loadModerationConfig, SPEC } from "./config.js";
export { parseThresholds, buildImagePrompt, buildTextPrompt, extractScores, decide } from "./classify.js";
export { classifyImageItem, classifyTextItem, moveToQuarantine } from "./run.js";
