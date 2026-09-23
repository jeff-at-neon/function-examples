/**
 * Block config. Separated from the handler so it can be unit tested without a pool.
 */

import { loadConfig, type LoadedConfig } from "@neon-blocks/core";

export const SPEC = {
  block: "semantic-cache",
  optional: {
    CACHE_SIMILARITY_THRESHOLD: "0.95",
    CACHE_TTL_HOURS: "168",
    CACHE_EMBEDDING_MODEL: "text-embedding-3-small",
    CACHE_EMBEDDING_DIMENSIONS: "1536",
  },
} as const;

export interface CacheConfig {
  /** Cosine similarity a candidate must reach to be served. Strict by default. */
  threshold: number;
  ttlHours: number;
  model: string;
  dimensions: number;
  raw: LoadedConfig;
}

export function loadCacheConfig(env?: NodeJS.ProcessEnv): CacheConfig {
  const raw = loadConfig(SPEC, env);
  // LoadedConfig has no float accessor; a loose or out-of-range threshold silently serves answers
  // to different questions, so validate it here rather than trusting the string.
  const threshold = Number(raw.get("CACHE_SIMILARITY_THRESHOLD"));
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(
      `CACHE_SIMILARITY_THRESHOLD must be a number in [0, 1], got "${raw.get(
        "CACHE_SIMILARITY_THRESHOLD",
      )}"`,
    );
  }
  return {
    threshold,
    ttlHours: raw.int("CACHE_TTL_HOURS", { min: 1, max: 8_760 }),
    model: raw.get("CACHE_EMBEDDING_MODEL"),
    dimensions: raw.int("CACHE_EMBEDDING_DIMENSIONS", { min: 1 }),
    raw,
  };
}
