/**
 * Block 11 — CSV / Excel Import.
 *
 * Spreadsheet lands in a bucket, validates into a staging table, merges typed, and writes a row-level error report back.
 *
 * Unglamorous and universally needed. "Drop a CSV in a bucket and it lands in Postgres, with a report of the 14 bad rows" sells itself to every enterprise team, and the row-level error report is the part people actually care about — an import that fails wholesale on row 4,000 is worse than useless.
 *
 * Routes:
 *   POST   /import                Storage trigger. Import one spreadsheet.
 *   POST   /reconcile             Cron. Missed uploads and stuck imports.
 *   GET    /imports/:id           Import status plus its row errors.
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
import { autoMigrate } from "@neon-blocks/migrate";
import { StorageClient, detectKind, ObjectNotFoundError } from "@neon-blocks/storage";
import { loadCsvConfig } from "./config.js";
import { runImport } from "./import.js";

const log: Logger = createLogger({ block: "csv-import" });

const router = new Router();

router.post("/import", async (request) => {
  assertTriggerAuthentic(request, { requireSecret: false });
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "storage_object_created") {
    return problem(400, "wrong_trigger", `/import expects a storage trigger, got ${event.type}`);
  }

  const cfg = loadCsvConfig();
  if (event.bucketName !== cfg.bucket) {
    return problem(403, "wrong_bucket", "This importer only handles its configured bucket");
  }

  // §8: reports are written back to storage, so the output prefix must be disjoint from the watched
  // prefix or every report would retrigger an import of itself.
  assertNoLoop({
    inputBucket: cfg.bucket,
    inputPrefix: cfg.prefix,
    outputBucket: cfg.bucket,
    outputPrefix: cfg.reportPrefix,
  });

  const storage = StorageClient.fromEnv();
  const kind = detectKind({ key: event.objectKey });

  if (kind !== "spreadsheet") {
    // No suffix filter on storage triggers, so non-spreadsheets arrive here routinely.
    return json({ ok: true, status: "skipped", reason: `${kind} is not a spreadsheet` });
  }

  // HEAD-verify before acting: trigger delivery is unauthenticated (§7).
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
    log.capped("spreadsheet too large to import", { size: metadata.size, maxBytes: cfg.maxBytes });
    return json({ ok: true, status: "skipped", reason: "over size limit" });
  }

  // Parse (RFC 4180), validate each row against the definition's column map collecting row errors,
  // upsert the valid rows, and write a rejected-rows report back to storage. The parsing, coercion,
  // and SQL generation are pure and unit tested; runImport is the thin orchestration.
  const result = await runImport(
    { db: getPool(), storage },
    { event: { bucketName: event.bucketName, objectKey: event.objectKey, etag: metadata.etag }, cfg },
  );
  return json({ ok: true, ...result });
});

router.post("/reconcile", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", `/reconcile expects a schedule trigger, got ${event.type}`);
  }

  // Reset imports abandoned mid-pipeline. This part works and is useful on its own: without it a
  // function that dies during a merge leaves an import in limbo forever.
  const { rowCount } = await getPool().query(
    `UPDATE blocks_csv_import.imports
     SET status = 'pending',
         error = 'reset by reconciler: stuck in ' || status
     WHERE status IN ('parsing', 'validating', 'merging')
       AND updated_at < now() - interval '1 hour'`,
  );

  return json({ ok: true, scheduledAt: event.scheduledAt, stuckReset: rowCount ?? 0 });
});

router.get("/imports/:id", async (_request, ctx) => {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM blocks_csv_import.imports WHERE id = $1`,
    [ctx.params["id"]],
  );
  if (rows.length === 0) throw new NotFoundError("No such import");

  const { rows: errors } = await pool.query(
    `SELECT line_number, column_name, reason, raw_row
     FROM blocks_csv_import.row_errors WHERE import_id = $1
     ORDER BY line_number LIMIT 1000`,
    [ctx.params["id"]],
  );

  return json({ import: rows[0], rowErrors: errors, rowErrorsTruncated: errors.length === 1000 });
});

router.get("/health", async () => {
  const report = await checkHealth(getPool(), {
    block: "csv-import",
    schema: "blocks_csv_import",
    evaluate: (status) => {
      const problems: string[] = [];

      const stuck = Number(status["imports_stuck"] ?? 0);
      const failed = Number(status["imports_failed"] ?? 0);
      const definitions = Number(status["definitions_count"] ?? 0);

      if (definitions === 0) {
        problems.push(
          "no import definitions are configured; every import will fail with no column map",
        );
      }
      if (stuck > 0) problems.push(`${stuck} import(s) stuck mid-pipeline for over an hour`);
      if (failed > 0) problems.push(`${failed} import(s) failed`);
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
  block: "csv-import",
  migrationsUrl: new URL("./migrations/", import.meta.url),
  fetch: (request: Request): Promise<Response> => router.handle(request),
});

// Re-exported so unit tests can import the pure logic directly.
export { loadCsvConfig, SPEC } from "./config.js";
export { parseCsv, csvEscape, toCsv } from "./parse.js";
export { coerceValue, mapHeaders, validateRow, buildRejectedCsv } from "./coerce.js";
export { buildInsertSql } from "./merge.js";
export { runImport, definitionCodeFromKey } from "./import.js";
