/**
 * Block config. Separated from the handler so it can be unit tested without a pool.
 */

import { loadConfig, type LoadedConfig } from "@neon-blocks/core";
import { parseThresholds } from "./classify.js";

export const SPEC = {
  block: "moderation",
  required: ["MODERATION_BUCKET"],
  optional: {
    MODERATION_PREFIX: "uploads/",
    MODERATION_QUARANTINE_PREFIX: "quarantine/",
    MODERATION_MODEL: "gpt-5-mini",
    MODERATION_THRESHOLDS: '{"adult":0.5,"violence":0.6,"self_harm":0.4,"hate":0.4,"harassment":0.6}',
  },
} as const;

export interface ModerationConfig {
  bucket: string;
  prefix: string;
  quarantinePrefix: string;
  model: string;
  thresholds: Record<string, number>;
  raw: LoadedConfig;
}

export function loadModerationConfig(env?: NodeJS.ProcessEnv): ModerationConfig {
  const raw = loadConfig(SPEC, env);
  return {
    bucket: raw.get("MODERATION_BUCKET"),
    prefix: raw.get("MODERATION_PREFIX"),
    quarantinePrefix: raw.get("MODERATION_QUARANTINE_PREFIX"),
    model: raw.get("MODERATION_MODEL"),
    thresholds: parseThresholds(raw.get("MODERATION_THRESHOLDS")),
    raw,
  };
}
