/**
 * Pure helpers for the cleanup job.
 *
 * Kept out of the handler so the rules (what a valid registration is, how a run is summarized) are
 * unit-testable without a database or a live cron trigger.
 */

import { ValidationError } from "@neon-blocks/core";

export interface Registration {
  kind: string;
  reference: string;
  expiresAt: Date;
}

/**
 * Validate a POST /register body into a registration.
 *
 * Accepts either an explicit `expiresAt` (ISO 8601) or a `ttlSeconds`; when neither is given, the
 * caller's default TTL applies. An expiry in the past is allowed on purpose: it means "expire on
 * the next run", which is a legitimate way to schedule an immediate cleanup.
 */
export function parseRegister(body: unknown, defaultTtlSeconds: number, now: Date = new Date()): Registration {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  const o = body as Record<string, unknown>;

  const kind = requireString(o["kind"], "kind");
  if (kind.length > 64) throw new ValidationError('"kind" must be at most 64 characters');
  const reference = requireString(o["reference"], "reference");

  let expiresAt: Date;
  if (o["expiresAt"] !== undefined) {
    if (typeof o["expiresAt"] !== "string") throw new ValidationError('"expiresAt" must be an ISO 8601 string');
    const parsed = new Date(o["expiresAt"]);
    if (Number.isNaN(parsed.getTime())) throw new ValidationError('"expiresAt" is not a valid date');
    expiresAt = parsed;
  } else {
    const ttl = o["ttlSeconds"] === undefined ? defaultTtlSeconds : requirePositiveInt(o["ttlSeconds"], "ttlSeconds");
    expiresAt = new Date(now.getTime() + ttl * 1000);
  }

  return { kind, reference, expiresAt };
}

function requireString(value: unknown, key: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`"${key}" is required and must be a non-empty string`);
  }
  return value.trim();
}

function requirePositiveInt(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`"${key}" must be a positive integer`);
  }
  return value;
}

/** Fold `{ kind, n }` rows into a `{ kind: count }` object for a run's breakdown. */
export function toByKind(rows: readonly { kind: string; n: number | string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) out[row.kind] = Number(row.n);
  return out;
}

/** Sum a by-kind breakdown. The total a run reports as expired. */
export function totalExpired(byKind: Record<string, number>): number {
  return Object.values(byKind).reduce((sum, n) => sum + n, 0);
}
