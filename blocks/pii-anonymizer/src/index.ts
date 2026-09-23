/**
 * Block 15 — PII Anonymizer for Branches.
 *
 * Deterministically masks personal data in a branch — database and Object Storage — so a prod copy is safe to hand to a contractor or an AI agent.
 *
 * The flagship branching demo. Neon branches give you a full production copy in seconds, and Object Storage branches with it — which is exactly why handing one to a contractor or pointing an AI agent at it is a data-protection problem. This turns 'a copy of prod' into 'a safe copy of prod', which is what makes the branching feature usable for the thing people most want to do with it.
 *
 * Routes:
 *   POST   /rules                 Declare a masking rule for a column.
 *   POST   /run                   Mask this branch. Refuses unless the branch name matches the allow pattern.
 *   GET    /runs                  Masking history for this branch.
 */

import {
  checkHealth,
  createLogger,
  getPool,
  json,
  problem,
  Router,
  ValidationError,
  type Logger,
} from "@neon-blocks/core";
import { autoMigrate } from "@neon-blocks/migrate";
import { quoteIdent } from "@neon-blocks/core";
import { loadAnonymizeConfig } from "./config.js";
import { isBranchAllowed, runMasking, type Rule } from "./run.js";

const log: Logger = createLogger({ block: "pii-anonymizer" });

const router = new Router();

router.post("/rules", async (request) => {
  const body = await readJsonObject(request);

  // These identifiers are interpolated into generated UPDATE statements, so validate now.
  for (const identifier of [
    requireString(body, "schema"),
    requireString(body, "table"),
    requireString(body, "column"),
  ]) {
    quoteIdent(identifier);
  }

  await getPool().query(
    `INSERT INTO blocks_pii_anonymizer.rules
       (target_schema, target_table, target_column, strategy, options)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (target_schema, target_table, target_column) DO UPDATE
       SET strategy = EXCLUDED.strategy, options = EXCLUDED.options, is_active = true`,
    [
      requireString(body, "schema"),
      requireString(body, "table"),
      requireString(body, "column"),
      requireString(body, "strategy"),
      JSON.stringify(body["options"] ?? {}),
    ],
  );

  return json({ declared: `${body["schema"]}.${body["table"]}.${body["column"]}` }, { status: 201 });
});

router.post("/run", async (request) => {
  const body = await readJsonObject(request);
  const cfg = loadAnonymizeConfig();
  const pool = getPool();

  // The safety interlock, checked before anything else. Masking is destructive and irreversible, and
  // the failure mode is destroying real customer data.
  const branchName = typeof body["branchName"] === "string" ? body["branchName"] : null;

  if (!isBranchAllowed(branchName, cfg.allowBranchPattern)) {
    await pool.query(
      `INSERT INTO blocks_pii_anonymizer.runs (branch_name, status, error, finished_at)
       VALUES ($1, 'refused', $2, now())`,
      [branchName, `branch name does not match ${cfg.allowBranchPattern}`],
    );

    return problem(
      403,
      "refused",
      `Refusing to mask: branch name ${JSON.stringify(branchName)} does not match ` +
        `ANONYMIZE_ALLOW_BRANCH_PATTERN (${cfg.allowBranchPattern}). Masking is irreversible, so ` +
        `this block will not run anywhere it cannot confirm is non-production.`,
    );
  }

  const { rows: rules } = await pool.query<Rule>(
    `SELECT id, target_schema, target_table, target_column, strategy
     FROM blocks_pii_anonymizer.rules WHERE is_active`,
  );
  if (rules.length === 0) {
    return problem(400, "no_rules", "No active masking rules are declared; there is nothing to mask.");
  }

  // Record the run, then execute. Progress is written to runs.detail after every batch so a run
  // that dies partway is resumable rather than a mystery — a partially masked branch looks masked
  // but is not. Object Storage is out of scope (see README): it branches with the data too.
  const { rows: created } = await pool.query<{ id: string }>(
    `INSERT INTO blocks_pii_anonymizer.runs (branch_name, status) VALUES ($1, 'running') RETURNING id`,
    [branchName],
  );
  const runId = created[0]?.id;
  if (!runId) return problem(500, "run_not_created", "Could not create a run row");

  try {
    const { rulesApplied, rowsMasked } = await runMasking(pool, {
      runId,
      rules,
      salt: cfg.salt,
      batchRows: cfg.batchRows,
    });
    await pool.query(
      `UPDATE blocks_pii_anonymizer.runs
       SET status = 'complete', rules_applied = $2, rows_masked = $3, finished_at = now()
       WHERE id = $1`,
      [runId, rulesApplied, rowsMasked],
    );
    return json({ ok: true, runId, branchName, rulesApplied, rowsMasked });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await pool.query(
      `UPDATE blocks_pii_anonymizer.runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
      [runId, message],
    );
    log.error("masking run failed", { runId, error: message });
    throw err;
  }
});

router.get("/runs", async () => {
  const { rows } = await getPool().query(
    `SELECT id, branch_name, status, rules_applied, rows_masked, error, started_at, finished_at
     FROM blocks_pii_anonymizer.runs ORDER BY started_at DESC LIMIT 50`,
  );
  return json({ runs: rows });
});

router.get("/health", async () => {
  const report = await checkHealth(getPool(), {
    block: "pii-anonymizer",
    schema: "blocks_pii_anonymizer",
    evaluate: (status) => {
      const problems: string[] = [];

      const rules = Number(status["rules_active"] ?? 0);
      const stuck = Number(status["runs_stuck"] ?? 0);
      const failed = Number(status["runs_failed"] ?? 0);

      if (rules === 0) problems.push("no active masking rules; a run would mask nothing");
      if (stuck > 0) {
        // The most dangerous state: it looks masked but is not.
        problems.push(
          `${stuck} masking run(s) have been running for over an hour. A run that died partway ` +
            `leaves the branch PARTIALLY masked, which looks masked but is not -- do not share ` +
            `access until a run completes.`,
        );
      }
      if (failed > 0) problems.push(`${failed} masking run(s) failed`);
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
  block: "pii-anonymizer",
  migrationsUrl: new URL("./migrations/", import.meta.url),
  fetch: (request: Request): Promise<Response> => router.handle(request),
});

// Re-exported so unit tests can import the pure logic directly.
export { loadAnonymizeConfig, SPEC } from "./config.js";
export { maskValue } from "./mask.js";
export { isBranchAllowed, buildUpdateSql, buildSelectBatchSql, mergeProgress, ruleKey } from "./run.js";
