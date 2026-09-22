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
import { quoteIdent } from "@neon-blocks/core";

const log: Logger = createLogger({ block: "compliance" });

const SPEC = {
  block: "compliance",
  optional: {
    COMPLIANCE_HASH_CHAIN: "true",
    COMPLIANCE_RETENTION_DAYS: "30",
    COMPLIANCE_AUDIT_RETENTION_DAYS: "2555",
  },
} as const;

function config() {
  return loadConfig(SPEC);
}

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
    `INSERT INTO blocks_compliance.subject_requests (subject_ref, kind)
     VALUES ($1, $2) RETURNING id`,
    [subjectRef, kind],
  );

  // TODO(compliance): execute the request.
  //   * export: SELECT from every subject_links row with handling in (export, erase, anonymize),
  //     assembling one JSON document. Declared links are why adding a table is config, not code.
  //   * erase: DELETE where handling='erase', apply masking where handling='anonymize' (rows that
  //     must survive for accounting), and record per-table counts in detail
  //   * both should run through the queue for subjects with data in large tables; the current shape
  //     does not chunk
  return json(
    {
      id: rows[0]?.id,
      kind,
      status: "pending",
      note:
        "Request recorded. Execution is not yet wired -- see the TODO in src/index.ts. The " +
        "legal-hold check above is enforced.",
    },
    { status: 202 },
  );
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
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", `/purge expects a schedule trigger, got ${event.type}`);
  }

  const cfg = config();
  const auditRetention = cfg.int("COMPLIANCE_AUDIT_RETENTION_DAYS", { min: 1, max: 36_500 });

  // TODO(compliance): soft-delete purge across declared tables, honouring legal_holds. The hold
  // check is the part that makes this a compliance control rather than a cron job.
  //
  // Audit purge is deliberately NOT implemented here either: deleting audit entries breaks the hash
  // chain, so it needs chain re-anchoring rather than a plain DELETE. Doing it naively would make
  // the log unverifiable, which defeats the point of chaining it.
  return json({
    ok: true,
    scheduledAt: event.scheduledAt,
    auditRetentionDays: auditRetention,
    purged: 0,
    note:
      "Purge is not yet wired. Note that audit purge needs hash-chain re-anchoring, not a plain " +
      "DELETE -- otherwise the log becomes unverifiable.",
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

export default {
  fetch: (request: Request): Promise<Response> => router.handle(request),
};
