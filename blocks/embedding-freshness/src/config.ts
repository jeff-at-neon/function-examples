/**
 * Block config. Separated from the handler so it can be unit tested without a pool.
 */

import { loadConfig, type LoadedConfig } from "@neon-blocks/core";

export const SPEC = {
  block: "embedding-freshness",
  optional: {
    FRESHNESS_BATCH_SIZE: "200",
    FRESHNESS_EMBEDDING_MODEL: "text-embedding-3-small",
    FRESHNESS_EMBEDDING_DIMENSIONS: "1536",
  },
} as const;

export interface FreshnessConfig {
  batchSize: number;
  model: string;
  dimensions: number;
  raw: LoadedConfig;
}

export function loadFreshnessConfig(env?: NodeJS.ProcessEnv): FreshnessConfig {
  const raw = loadConfig(SPEC, env);
  return {
    batchSize: raw.int("FRESHNESS_BATCH_SIZE", { min: 1, max: 10_000 }),
    model: raw.get("FRESHNESS_EMBEDDING_MODEL"),
    dimensions: raw.int("FRESHNESS_EMBEDDING_DIMENSIONS", { min: 1 }),
    raw,
  };
}
