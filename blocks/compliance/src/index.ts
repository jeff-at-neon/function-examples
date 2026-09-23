/**
 * Block 17 — Compliance Pack.
 *
 * Hash-chained audit log, soft delete with TTL purge, and GDPR export and hard-delete.
 *
 * The audit log is the part that is hard to retrofit, which is the reason to have it early. An audit trail added after the fact covers only what the application remembers to log; a trigger-based one captures writes from any client including psql, which is what auditors actually ask about. Row-event triggers would make this considerably better -- see docs/ROW_EVENTS.md.
 *
 * Routes:
 *   POST   /subject-links         Declare where a data subject's rows live.
 *   POST   /requests              Open an export or erasure request.
 *   GET    /requests/:id          Request status and per-table detail.
 *   POST   /purge                 Cron. TTL purge of soft-deleted rows.
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
import { quoteIdent } from "@neon-blocks/core";
import { loadComplianceConfig } from "./config.js";
import { runErase, runExport } from "./requests.js";
import type { SubjectLink } from "./subject.js";

const log: Logger = createLogger({ block: "compliance" });

const router = new Router();

router.post("/subject-links", async (request) => {
  const body = await readJsonObject(request);

  // These identifiers reach generated SQL during export and erasure, so validate them at declaration
  // time rather than when a regulator is waiting.
  for (const identifier of [
    requireString(body, "schema"),
    requireString(body, "table"),
    requireString(body, "subjectColumn"),
  ]) {
    quoteIdent(identifier);
  }

  const handling = typeof body["handling"] === "string" ? body["handling"] : "export";
  if (!["export", "erase", "anonymize"].includes(handling)) {
    throw new ValidationError('"handling" must be one of export, erase, anonymize');
  }

  await getPool().query(
    `INSERT INTO blocks_compliance.subject_links
       (target_schema, target_table, subject_column, handling)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (target_schema, target_table, subject_column) DO UPDATE
       SET handling = EXCLUDED.handling`,
    [
      requireString(body, "schema"),
      requireString(body, "table"),
      requireString(body, "subjectColumn"),
      handling,
    ],
  );

  return json({ declared: `${body["schema"]}.${body["table"]}`, handling }, { status: 201 });
});

router.post("/requests", async (request) => {
  const body = await readJsonObject(request);
  const kind = requireString(body, "kind");
  if (kind !== "export" && kind !== "erase") {
    throw new ValidationError('"kind" must be "export" or "erase"');
  }

  const pool = getPool();
  const subjectRef = requireString(body, "subjectRef");

  // A hold means data is under litigation. Erasing it would destroy evidence, so the request is
  // refused rather than queued -- the conflict needs a human decision.
  const { rows: holds } = await pool.query<{ reason: string }>(
    `SELECT reason FROM blocks_compliance.legal_holds
     WHERE released_at IS NULL AND (subject_ref = $1 OR subject_ref IS NULL)`,
    [subjectRef],
  );

  if (kind === "erase" && holds.length > 0) {
    return problem(
      409,
      "legal_hold",
      `Refusing to queue erasure: ${holds.length} active legal hold(s) cover this subject ` +
        `(${holds[0]?.reason}). Erasing data under litigation destroys evidence, so this needs a ` +
        `human decision and an explicit hold release.`,
    );
  }

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO blocks_compliance.subject_requests (subject_ref, kind, status)
     VALUES ($1, $2, 'running') RETURNING id`,
    [subjectRef, kind],
  );
  const requestId = rows[0]?.id;
  if (!requestId) return problem(500, "request_not_created", "Could not create the request");

  // Declared links are why adding a table to an export is configuration, not code. Export reads
  // every link; erase/anonymize acts only on erase/anonymize links. Large tables should be chunked
  // through the queue — not done here; documented as a limitation.
  const { rows: links } = await pool.query<SubjectLink>(
    `SELECT target_schema, target_table, subject_column, handling FROM blocks_compliance.subject_links`,
  );

  try {
    if (kind === "export") {
      const doc = await runExport(pool, { subjectRef, links });
      await pool.query(
        `UPDATE blocks_compliance.subject_requests
         SET status = 'complete', detail = $2::jsonb, completed_at = now() WHERE id = $1`,
        [requestId, JSON.stringify({ export: doc })],
      );
      return json({ id: requestId, kind, status: "complete", export: doc });
    }

    const counts = await runErase(pool, { subjectRef, links });
    await pool.query(
      `UPDATE blocks_compliance.subject_requests
       SET status = 'complete', detail = $2::jsonb, completed_at = now() WHERE id = $1`,
      [requestId, JSON.stringify({ erased: counts })],
    );
    return json({ id: requestId, kind, status: "complete", erased: counts });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await pool.query(
      `UPDATE blocks_compliance.subject_requests SET status = 'failed', error = $2 WHERE id = $1`,
      [requestId, message],
    );
    log.error("subject request failed", { requestId, error: message });
    throw err;
  }
});

router.get("/requests/:id", async (_request, ctx) => {
  const { rows } = await getPool().query(
    `SELECT id, subject_ref, kind, status, detail, error, requested_at, completed_at
     FROM blocks_compliance.subject_requests WHERE id = $1`,
    [ctx.params["id"]],
  );
  if (rows.length === 0) throw new NotFoundError("No such request");
  return json({ request: rows[0] });
});

router.post("/purge", async (request) => {
  assertTriggerAuthentic(request);
  const event = await parseTriggerRequest(request);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", `/purge expects a schedule trigger, got ${event.type}`);
  }

  const cfg = loadComplianceConfig();
  const pool = getPool();

  // Audit purge goes through reanchor_audit_chain (migration 002): it deletes entries past retention
  // and then recomputes the chain from the new anchor, so the log stays verifiable. A plain DELETE
  // would leave the chain broken and the log unverifiable.
  const { rows } = await pool.query<{ reanchor_audit_chain: string }>(
    `SELECT blocks_compliance.reanchor_audit_chain(now() - make_interval(days => $1::int)) AS reanchor_audit_chain`,
    [cfg.auditRetentionDays],
  );
  const auditPurged = Number(rows[0]?.reanchor_audit_chain ?? 0);

  return json({
    ok: true,
    scheduledAt: event.scheduledAt,
    auditRetentionDays: cfg.auditRetentionDays,
    auditEntriesPurged: auditPurged,
    note:
      "Audit entries were purged with hash-chain re-anchoring. Soft-delete purge across declared " +
      "subject tables requires a deleted_at convention on those tables and honours legal_holds; " +
      "see buildSoftDeletePurgeSql/filterHeld.",
  });
});

router.get("/health", async () => {
  const report = await checkHealth(getPool(), {
    block: "compliance",
    schema: "blocks_compliance",
    evaluate: (status) => {
      const problems: string[] = [];

      const unchained = Number(status["audit_unchained"] ?? 0);
      const overdue = Number(status["requests_overdue"] ?? 0);
      const failed = Number(status["requests_failed"] ?? 0);
      const links = Number(status["subject_links"] ?? 0);

      if (links === 0) {
        problems.push(
          "no subject links declared; an export would return nothing and appear to succeed",
        );
      }
      if (unchained > 0) {
        problems.push(
          `${unchained} audit entry/entries have no hash. The chain cannot be verified across a ` +
            `gap, so tampering before that point would not be detectable.`,
        );
      }
      if (overdue > 0) {
        // GDPR's deadline is one month. This is regulatory exposure, not a backlog item.
        problems.push(
          `${overdue} subject request(s) have been open for over 30 days, past the GDPR deadline`,
        );
      }
      if (failed > 0) problems.push(`${failed} subject request(s) failed`);
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
  block: "compliance",
  migrationsUrl: new URL("./migrations/", import.meta.url),
  fetch: (request: Request): Promise<Response> => router.handle(request),
});

// Re-exported so unit tests can import the pure logic directly.
export { loadComplianceConfig, SPEC } from "./config.js";
export { verifyLinkage } from "./chain.js";
export {
  buildSubjectSelectSql,
  buildEraseSql,
  buildAnonymizeSql,
  buildSoftDeletePurgeSql,
  summarizeCounts,
  assembleExportDoc,
  filterHeld,
} from "./subject.js";
