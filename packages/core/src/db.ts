/**
 * Database access.
 *
 * Per Neon's guidance a Function keeps a long-lived `pg` Pool across requests — the
 * `@neondatabase/serverless` driver targets short-lived edge workloads and is the wrong
 * choice here. DATABASE_URL is auto-injected on the deployed branch.
 */

import { Pool, type PoolClient, type PoolConfig } from "pg";

let shared: Pool | undefined;

export interface PoolOptions extends PoolConfig {
  /** Defaults to DATABASE_URL, which Neon injects automatically. */
  connectionString?: string;
}

/**
 * Process-wide pool, created once and reused across invocations.
 *
 * Functions run at a fixed size, so a modest pool is right: too many connections buys
 * nothing and competes with the user's own application for Postgres slots.
 */
export function getPool(options: PoolOptions = {}): Pool {
  if (shared) return shared;

  const connectionString = options.connectionString ?? process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Neon injects it automatically on a deployed branch; " +
        "set it manually for local development.",
    );
  }

  shared = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Bound every statement so a pathological query can't hold an active Capacity-Hour open.
    statement_timeout: 30_000,
    ...options,
  });

  // An idle-client error must not take down the function.
  shared.on("error", (err) => {
    console.error(JSON.stringify({ level: "error", msg: "idle pool client error", err: err.message }));
  });

  return shared;
}

/** Test-seam: drop the shared pool so a suite can point at a different branch. */
export async function resetPool(): Promise<void> {
  const current = shared;
  shared = undefined;
  await current?.end();
}

export interface Queryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/**
 * Run `fn` inside a transaction, rolling back on any throw.
 *
 * Blocks use this for claim-then-work sequences where a partial write would corrupt state.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      // Surface the rollback failure but preserve the original cause — the first error is
      // the interesting one.
      console.error(
        JSON.stringify({
          level: "error",
          msg: "rollback failed",
          err: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
        }),
      );
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Advisory-lock a named critical section so concurrent invocations don't duplicate work.
 *
 * Returns false immediately if another holder has it — callers should treat that as
 * "someone else is already doing this" and exit successfully, not retry. Essential for
 * cron sweepers, which can overlap when a run exceeds its interval.
 */
export async function withAdvisoryLock<T>(
  pool: Pool,
  key: string,
  fn: () => Promise<T>,
): Promise<T | false> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [key],
    );
    if (!rows[0]?.locked) return false;
    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
    }
  } finally {
    client.release();
  }
}
