/**
 * Block config. Separated from the handler so it can be unit tested without a pool.
 */

import { loadConfig, type LoadedConfig } from "@neon-blocks/core";

export const SPEC = {
  block: "doc-extraction",
  required: ["EXTRACT_BUCKET"],
  optional: {
    EXTRACT_PREFIX: "documents/",
    EXTRACT_MODEL: "gpt-5-mini",
    EXTRACT_CONFIDENCE_THRESHOLD: "0.8",
    EXTRACT_MAX_BYTES: "20971520",
  },
} as const;

export interface ExtractConfig {
  bucket: string;
  prefix: string;
  model: string;
  confidenceThreshold: number;
  maxBytes: number;
  raw: LoadedConfig;
}

export function loadExtractConfig(env?: NodeJS.ProcessEnv): ExtractConfig {
  const raw = loadConfig(SPEC, env);
  const threshold = Number(raw.get("EXTRACT_CONFIDENCE_THRESHOLD"));
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(
      `EXTRACT_CONFIDENCE_THRESHOLD must be a number in [0, 1], got "${raw.get("EXTRACT_CONFIDENCE_THRESHOLD")}"`,
    );
  }
  return {
    bucket: raw.get("EXTRACT_BUCKET"),
    prefix: raw.get("EXTRACT_PREFIX"),
    model: raw.get("EXTRACT_MODEL"),
    confidenceThreshold: threshold,
    maxBytes: raw.int("EXTRACT_MAX_BYTES", { min: 1024 }),
    raw,
  };
}
