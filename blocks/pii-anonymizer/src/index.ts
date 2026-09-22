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
 *
 * STATUS: scaffold. The schema, safety checks, and control flow are real; the marked TODO seams are
 * the remaining work. Endpoints that are not implemented return 501 with a specific explanation
 * rather than failing in a way that looks like a bug.
 */

import {
  checkHealth,
  createLogger,
  getPool,
  json,
  loadConfig,
  problem,
  Router,
  ValidationError,
  type Logger,
} from "@neon-blocks/core";
import { createHmac } from "node:crypto";
import { quoteIdent } from "@neon-blocks/core";

const log: Logger = createLogger({ block: "pii-anonymizer" });

const SPEC = {
  block: "pii-anonymizer",
  required: ["ANONYMIZE_SALT"],
  optional: {
    ANONYMIZE_ALLOW_BRANCH_PATTERN: "^(dev|preview|staging|test)",
    ANONYMIZE_BATCH_ROWS: "5000",
  },
} as const;

function config() {
  return loadConfig(SPEC);
}

const router = new Router();

/**
 * Deterministic masking primitive.
 *
 * HMAC rather than a plain hash: hashing an email is trivially reversible with a dictionary, because
 * there are only so many plausible email addresses. Determinism is deliberate — the same input must
 * always produce the same output, or joins break and a bug that only reproduces for one customer
 * stops reproducing at all.
 */
export function maskValue(value: string, salt: string, strategy: string): string {
  const digest = createHmac("sha256", salt).update(value).digest("hex");

  switch (strategy) {
    case "email":
      // Format-preserving: a masked email that is not a valid email fails validation and makes the
      // branch unusable for testing.
      return `user_${digest.slice(0, 12)}@example.test`;
    case "phone":
      // Keeps the +1 555 prefix so number parsers still accept it.
      return `+1555${parseInt(digest.slice(0, 7), 16) % 10_000_000}`.slice(0, 12);
    case "name":
      return `Person ${digest.slice(0, 8)}`;
    case "address":
      return `${parseInt(digest.slice(0, 4), 16) % 9999} Test Street`;
    case "ip":
      // 203.0.113.0/24 is the reserved documentation range, so a masked IP cannot be a real host.
      return `203.0.113.${parseInt(digest.slice(0, 2), 16) % 256}`;
    case "uuid":
      return [digest.slice(0, 8), digest.slice(8, 12), `4${digest.slice(13, 16)}`,
              `8${digest.slice(17, 20)}`, digest.slice(20, 32)].join("-");
    case "redact":
      return "[REDACTED]";
    case "null_out":
      return "";
    default:
      return `masked_${digest.slice(0, 16)}`;
  }
}

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
  const cfg = config();
  const pool = getPool();

  // The safety interlock, checked before anything else. Masking is destructive and irreversible, and
  // the failure mode is destroying real customer data.
  const branchName = typeof body["branchName"] === "string" ? body["branchName"] : null;
  const pattern = new RegExp(cfg.get("ANONYMIZE_ALLOW_BRANCH_PATTERN"));

  if (!branchName || !pattern.test(branchName)) {
    await pool.query(
      `INSERT INTO blocks_pii_anonymizer.runs (branch_name, status, error, finished_at)
       VALUES ($1, 'refused', $2, now())`,
      [branchName, `branch name does not match ${pattern.source}`],
    );

    return problem(
      403,
      "refused",
      `Refusing to mask: branch name ${JSON.stringify(branchName)} does not match ` +
        `ANONYMIZE_ALLOW_BRANCH_PATTERN (${pattern.source}). Masking is irreversible, so this ` +
        `block will not run anywhere it cannot confirm is non-production.`,
    );
  }

  const { rows: rules } = await pool.query<{ id: string }>(
    `SELECT id FROM blocks_pii_anonymizer.rules WHERE is_active`,
  );
  if (rules.length === 0) {
    return problem(400, "no_rules", "No active masking rules are declared; there is nothing to mask.");
  }

  // TODO(pii-anonymizer): the masking executor.
  //   * per rule, UPDATE in batches of ANONYMIZE_BATCH_ROWS so a large table does not hold one
  //     transaction open for its whole duration
  //   * apply maskValue() above, which is already deterministic and format-preserving
  //   * handle composite primary keys when batching
  //   * record per-rule progress in runs.detail, so a run that dies partway can be resumed --
  //     a partially masked branch is the most dangerous state, because it looks masked
  //   * Object Storage is NOT handled: it branches with your data, so documents and images
  //     containing PII are copied too. That needs the vision and extraction blocks.
  return problem(
    501,
    "not_implemented",
    `The masking executor is not yet wired (${rules.length} rule(s) are declared). See the TODO ` +
      `in src/index.ts. maskValue() is implemented and deterministic; the batched UPDATE ` +
      `generation is the remaining work.`,
  );
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

export default {
  fetch: (request: Request): Promise<Response> => router.handle(request),
};
