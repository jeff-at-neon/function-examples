/**
 * Block config. Separated from the handler so it can be unit tested without a pool.
 */

import { loadConfig, type LoadedConfig } from "@neon-blocks/core";

export const SPEC = {
  block: "db-health",
  optional: {
    HEALTH_SLOW_QUERY_MS: "100",
    HEALTH_BLOAT_WARN_PCT: "20",
    HEALTH_MIN_TABLE_BYTES: "10485760",
    HEALTH_SNAPSHOT_RETENTION_DAYS: "90",
    HEALTH_PARENT_DATABASE_URL: "",
  },
} as const;

export interface HealthConfig {
  slowQueryMs: number;
  bloatWarnPct: number;
  minTableBytes: number;
  retentionDays: number;
  /** Direct connection string for the parent branch, enabling schema-drift detection. */
  parentDatabaseUrl: string;
  raw: LoadedConfig;
}

export function loadHealthConfig(env?: NodeJS.ProcessEnv): HealthConfig {
  const raw = loadConfig(SPEC, env);
  return {
    slowQueryMs: raw.int("HEALTH_SLOW_QUERY_MS", { min: 1 }),
    bloatWarnPct: raw.int("HEALTH_BLOAT_WARN_PCT", { min: 1, max: 100 }),
    minTableBytes: raw.int("HEALTH_MIN_TABLE_BYTES", { min: 0 }),
    retentionDays: raw.int("HEALTH_SNAPSHOT_RETENTION_DAYS", { min: 1, max: 3_650 }),
    parentDatabaseUrl: raw.get("HEALTH_PARENT_DATABASE_URL"),
    raw,
  };
}
