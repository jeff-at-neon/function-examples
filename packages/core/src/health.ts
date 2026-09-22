/**
 * Convention §10: every block answers "is this healthy right now?" in a machine-readable way.
 *
 * Health is derived from the block's own `v_status` view, so the SQL answer and the HTTP
 * answer can't drift apart.
 */

import type { Queryable } from "./db.js";

export interface HealthReport {
  block: string;
  status: "ok" | "degraded" | "error";
  checks: Record<string, unknown>;
  /** Present when status is not ok. */
  problems?: string[];
}

export interface HealthOptions {
  block: string;
  schema: string;
  /** Extra block-specific checks merged into the report. */
  extra?: (db: Queryable) => Promise<Record<string, unknown>>;
  /** Given the status row, decide whether the block is unhealthy and why. */
  evaluate?: (status: Record<string, unknown>) => string[];
}

/**
 * Query `<schema>.v_status` and turn it into a health report.
 *
 * A missing view is reported as an error rather than swallowed: it almost always means
 * migrations were never applied, which is the single most common install failure.
 */
export async function checkHealth(db: Queryable, opts: HealthOptions): Promise<HealthReport> {
  const problems: string[] = [];
  let checks: Record<string, unknown> = {};

  try {
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT * FROM ${quoteIdent(opts.schema)}.v_status`,
    );
    checks = rows[0] ?? {};
    if (rows.length === 0) problems.push("v_status returned no rows");
    else problems.push(...(opts.evaluate?.(checks) ?? []));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    problems.push(
      /does not exist/i.test(message)
        ? `${opts.schema}.v_status does not exist — migrations for this block have not been applied`
        : `status query failed: ${message}`,
    );
  }

  if (opts.extra) {
    try {
      checks = { ...checks, ...(await opts.extra(db)) };
    } catch (err) {
      problems.push(`extra checks failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const fatal = problems.some((p) => /does not exist|failed/i.test(p));
  return {
    block: opts.block,
    status: problems.length === 0 ? "ok" : fatal ? "error" : "degraded",
    checks,
    ...(problems.length > 0 ? { problems } : {}),
  };
}

/**
 * Quote a SQL identifier.
 *
 * Schema names come from block manifests rather than user input, but interpolating
 * identifiers is exactly the habit that becomes an injection later, so it is never done raw.
 */
export function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_$]*$/.test(name)) {
    throw new Error(`Unsafe SQL identifier: ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}
