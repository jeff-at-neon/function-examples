/**
 * Block config. Separated from the handler so it can be unit tested without a pool.
 */

import { loadConfig, type LoadedConfig } from "@neon-blocks/core";

export const SPEC = {
  block: "api-edge",
  optional: {
    API_KEY_PREFIX: "nb_live",
    API_RATE_WINDOW_SECONDS: "60",
    API_DEFAULT_RATE_LIMIT: "1000",
    API_IDEMPOTENCY_TTL_HOURS: "24",
  },
} as const;

export interface ApiEdgeConfig {
  keyPrefix: string;
  windowSeconds: number;
  defaultRateLimit: number;
  idempotencyTtlHours: number;
  raw: LoadedConfig;
}

export function loadApiEdgeConfig(env?: NodeJS.ProcessEnv): ApiEdgeConfig {
  const raw = loadConfig(SPEC, env);
  return {
    keyPrefix: raw.get("API_KEY_PREFIX"),
    windowSeconds: raw.int("API_RATE_WINDOW_SECONDS", { min: 1 }),
    defaultRateLimit: raw.int("API_DEFAULT_RATE_LIMIT", { min: 1 }),
    idempotencyTtlHours: raw.int("API_IDEMPOTENCY_TTL_HOURS", { min: 1 }),
    raw,
  };
}
