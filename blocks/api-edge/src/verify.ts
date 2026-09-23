/**
 * Key verification and fixed-window rate consumption.
 *
 * The window math and the limit decision are pure and unit tested. The one piece that cannot be
 * tested offline — the atomic INSERT ... ON CONFLICT ... DO UPDATE that increments the counter in a
 * single statement so concurrent requests cannot both read an under-limit count — is isolated in
 * `verifyKey` and kept to exactly one statement.
 */

import type { Queryable } from "@neon-blocks/core";

/** Floor `now` to the start of its fixed window. Stable for every instant within a window. */
export function windowStart(now: Date, windowSeconds: number): Date {
  const ms = windowSeconds * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

export interface RateDecision {
  allowed: boolean;
  remaining: number;
}

/**
 * Decide against the post-increment count. The request that pushes the counter to exactly `limit`
 * is still allowed; the next one is not. `remaining` never goes negative.
 */
export function rateDecision(count: number, limit: number): RateDecision {
  return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
}

/** Seconds until the current window rolls over. At least 1, so a Retry-After is never 0. */
export function retryAfterSeconds(now: Date, windowStartAt: Date, windowSeconds: number): number {
  const windowEnd = windowStartAt.getTime() + windowSeconds * 1000;
  return Math.max(1, Math.ceil((windowEnd - now.getTime()) / 1000));
}

export type VerifyResult =
  | {
      ok: true;
      keyId: string;
      tenant: string;
      scopes: string[];
      limit: number;
      remaining: number;
    }
  | {
      ok: false;
      reason: "unknown" | "revoked" | "expired" | "rate_limited";
      limit?: number;
      retryAfter?: number;
    };

type KeyRow = {
  id: string;
  tenant: string;
  scopes: string[];
  rate_limit: number | null;
  revoked_at: Date | null;
  expires_at: Date | null;
};

/**
 * Verify a key by its hash and consume one unit of rate budget.
 *
 * `now` is injectable for testing but defaults to wall-clock. Unknown / revoked / expired are
 * distinct reasons for the caller, which collapses them to one opaque 401 so a probing client
 * cannot tell a revoked key from a never-issued one.
 */
export async function verifyKey(
  db: Queryable,
  opts: { keyHash: string; windowSeconds: number; defaultRateLimit: number; now?: Date },
): Promise<VerifyResult> {
  const now = opts.now ?? new Date();

  const { rows } = await db.query<KeyRow>(
    `SELECT id, tenant, scopes, rate_limit, revoked_at, expires_at
     FROM blocks_api_edge.api_keys
     WHERE key_hash = $1`,
    [opts.keyHash],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: "unknown" };
  if (row.revoked_at) return { ok: false, reason: "revoked" };
  if (row.expires_at && row.expires_at.getTime() <= now.getTime()) {
    return { ok: false, reason: "expired" };
  }

  const limit = row.rate_limit ?? opts.defaultRateLimit;
  const start = windowStart(now, opts.windowSeconds);

  // One statement, so two concurrent requests cannot both observe an under-limit count.
  const { rows: counted } = await db.query<{ count: number }>(
    `INSERT INTO blocks_api_edge.rate_windows (subject, window_start, count)
     VALUES ($1, $2, 1)
     ON CONFLICT (subject, window_start)
     DO UPDATE SET count = rate_windows.count + 1
     RETURNING count`,
    [row.id, start],
  );
  const count = Number(counted[0]?.count ?? 1);
  const decision = rateDecision(count, limit);

  // Throttle the last_used_at write to once per window (the first request of a window) rather than
  // once per request, which the TODO flagged as write amplification.
  if (count === 1) {
    await db.query(`UPDATE blocks_api_edge.api_keys SET last_used_at = $2 WHERE id = $1`, [
      row.id,
      now,
    ]);
  }

  if (!decision.allowed) {
    return {
      ok: false,
      reason: "rate_limited",
      limit,
      retryAfter: retryAfterSeconds(now, start, opts.windowSeconds),
    };
  }
  return {
    ok: true,
    keyId: row.id,
    tenant: row.tenant,
    scopes: row.scopes,
    limit,
    remaining: decision.remaining,
  };
}
