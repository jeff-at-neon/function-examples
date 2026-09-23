/**
 * Deterministic bucketing. Pure and dependency-light so the stickiness and rollout guarantees can
 * be unit tested without a database.
 */

import { createHash } from "node:crypto";

/**
 * Hash of (flagKey, subjectRef) mapped to 0..9999, so the same subject always lands in the same
 * variant without storing an assignment row per user — which is what makes it sticky across
 * processes and restarts.
 *
 * The flag key must be part of the hash. Hashing the subject alone correlates every experiment: a
 * user in treatment for one test would be in treatment for all of them, silently confounding every
 * result you ever read.
 */
export function bucketOf(flagKey: string, subjectRef: string): number {
  const digest = createHash("sha256").update(`${flagKey}:${subjectRef}`).digest();
  // First 4 bytes as an unsigned int, modulo 10000 for basis-point resolution.
  return digest.readUInt32BE(0) % 10_000;
}

/** Pick a variant from normalized weights using a precomputed bucket. */
export function variantFor(
  bucket: number,
  variants: Record<string, number>,
  rolloutPct: number,
): string | null {
  // Rollout gate first, using the same bucket: a subject outside the rollout is consistently
  // outside it, rather than flickering in and out between requests.
  if (bucket >= rolloutPct * 100) return null;

  const entries = Object.entries(variants).filter(([, w]) => w > 0);
  if (entries.length === 0) return null;

  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  // Rescale the bucket into the rollout range, so weights apply across included subjects rather
  // than across all traffic.
  const scaled = (bucket / (rolloutPct * 100)) * total;

  let cumulative = 0;
  for (const [name, weight] of entries) {
    cumulative += weight;
    if (scaled < cumulative) return name;
  }
  return entries[entries.length - 1]?.[0] ?? null;
}
