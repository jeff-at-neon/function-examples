/**
 * Block config. Separated from the handler so it can be unit tested without a pool.
 */

import { loadConfig, type LoadedConfig } from "@neon-blocks/core";

export const SPEC = {
  block: "analytics",
  optional: {
    ANALYTICS_SESSION_GAP_MINUTES: "30",
    ANALYTICS_MAX_BATCH: "1000",
    ANALYTICS_RETENTION_DAYS: "400",
  },
} as const;

export interface AnalyticsConfig {
  sessionGapMinutes: number;
  maxBatch: number;
  retentionDays: number;
  raw: LoadedConfig;
}

export function loadAnalyticsConfig(env?: NodeJS.ProcessEnv): AnalyticsConfig {
  const raw = loadConfig(SPEC, env);
  return {
    sessionGapMinutes: raw.int("ANALYTICS_SESSION_GAP_MINUTES", { min: 1, max: 1_440 }),
    maxBatch: raw.int("ANALYTICS_MAX_BATCH", { min: 1, max: 10_000 }),
    retentionDays: raw.int("ANALYTICS_RETENTION_DAYS", { min: 1 }),
    raw,
  };
}
