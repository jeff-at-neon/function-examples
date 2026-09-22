/**
 * Block config. Separated from the handler so it can be unit tested without a pool.
 */

import { loadConfig, type LoadedConfig } from "@neon-blocks/core";

export const SPEC = {
  block: "queue",
  optional: {
    QUEUE_BATCH_SIZE: "25",
    QUEUE_LEASE_SECONDS: "300",
    QUEUE_BUDGET_MS: "45000",
    QUEUE_OUTBOX_BATCH_SIZE: "100",
    QUEUE_RETENTION_DAYS: "7",
    QUEUE_CONCURRENCY: "{}",
  },
} as const;

export interface QueueConfig {
  batchSize: number;
  leaseSeconds: number;
  budgetMs: number;
  outboxBatchSize: number;
  retentionDays: number;
  concurrency: Record<string, number>;
  raw: LoadedConfig;
}

/**
 * Parse per-type concurrency caps.
 *
 * Validated strictly: a typo here silently removes a cap, and the symptom shows up as an
 * unexplained capacity-hours bill rather than an error.
 */
export function parseConcurrency(raw: string): Record<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `QUEUE_CONCURRENCY is not valid JSON: ${err instanceof Error ? err.message : String(err)}. ` +
        `Expected an object like {"rag.embed": 4}.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`QUEUE_CONCURRENCY must be a JSON object, e.g. {"rag.embed": 4}.`);
  }

  const caps: Record<string, number> = {};
  for (const [type, value] of Object.entries(parsed)) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw new Error(
        `QUEUE_CONCURRENCY["${type}"] must be a positive integer, got ${JSON.stringify(value)}.`,
      );
    }
    caps[type] = value;
  }
  return caps;
}

export function loadQueueConfig(env?: NodeJS.ProcessEnv): QueueConfig {
  const raw = loadConfig(SPEC, env);
  return {
    batchSize: raw.int("QUEUE_BATCH_SIZE", { min: 1, max: 1_000 }),
    leaseSeconds: raw.int("QUEUE_LEASE_SECONDS", { min: 10, max: 3_600 }),
    budgetMs: raw.int("QUEUE_BUDGET_MS", { min: 1_000, max: 600_000 }),
    outboxBatchSize: raw.int("QUEUE_OUTBOX_BATCH_SIZE", { min: 1, max: 5_000 }),
    retentionDays: raw.int("QUEUE_RETENTION_DAYS", { min: 1, max: 3_650 }),
    concurrency: parseConcurrency(raw.get("QUEUE_CONCURRENCY")),
    raw,
  };
}
