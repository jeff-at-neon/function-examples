/**
 * Block config. Separated from the handler so it can be unit tested without a pool.
 */

import { loadConfig, type LoadedConfig } from "@neon-blocks/core";

export const SPEC = {
  block: "agent-memory",
  optional: {
    MEMORY_COMPACT_AT_TOKENS: "24000",
    MEMORY_KEEP_RECENT_TURNS: "10",
    MEMORY_SUMMARY_MODEL: "gpt-5-mini",
    MEMORY_EMBEDDING_MODEL: "text-embedding-3-small",
    MEMORY_EMBEDDING_DIMENSIONS: "1536",
  },
} as const;

export interface MemoryConfig {
  compactAtTokens: number;
  keepRecentTurns: number;
  summaryModel: string;
  embeddingModel: string;
  dimensions: number;
  raw: LoadedConfig;
}

export function loadMemoryConfig(env?: NodeJS.ProcessEnv): MemoryConfig {
  const raw = loadConfig(SPEC, env);
  return {
    compactAtTokens: raw.int("MEMORY_COMPACT_AT_TOKENS", { min: 1_000, max: 1_000_000 }),
    keepRecentTurns: raw.int("MEMORY_KEEP_RECENT_TURNS", { min: 1, max: 200 }),
    summaryModel: raw.get("MEMORY_SUMMARY_MODEL"),
    embeddingModel: raw.get("MEMORY_EMBEDDING_MODEL"),
    dimensions: raw.int("MEMORY_EMBEDDING_DIMENSIONS", { min: 1 }),
    raw,
  };
}
