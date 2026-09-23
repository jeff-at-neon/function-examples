/**
 * Block config. Separated from the handler so it can be unit tested without a pool.
 */

import { loadConfig, type LoadedConfig } from "@neon-blocks/core";

export const SPEC = {
  block: "feature-flags",
  optional: {
    FLAGS_EXPOSURE_SAMPLE_RATE: "1",
    FLAGS_DEFAULT_ON_ERROR: "false",
  },
} as const;

export interface FlagsConfig {
  /** Fraction of evaluations to log as exposures, in [0, 1]. */
  sampleRate: number;
  /** What an unknown or errored flag returns. Defaults to off — fail closed. */
  defaultOnError: boolean;
  raw: LoadedConfig;
}

export function loadFlagsConfig(env?: NodeJS.ProcessEnv): FlagsConfig {
  const raw = loadConfig(SPEC, env);
  const sampleRate = Number(raw.get("FLAGS_EXPOSURE_SAMPLE_RATE"));
  if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1) {
    throw new Error(
      `FLAGS_EXPOSURE_SAMPLE_RATE must be a number in [0, 1], got "${raw.get(
        "FLAGS_EXPOSURE_SAMPLE_RATE",
      )}"`,
    );
  }
  return {
    sampleRate,
    defaultOnError: raw.bool("FLAGS_DEFAULT_ON_ERROR"),
    raw,
  };
}
