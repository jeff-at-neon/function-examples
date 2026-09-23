/**
 * Block config. Separated from the handler so it can be unit tested without a pool.
 */

import { loadConfig, type LoadedConfig } from "@neon-blocks/core";

export const SPEC = {
  block: "notifications",
  optional: {
    NOTIFY_EMAIL_PROVIDER: "none",
    NOTIFY_EMAIL_FROM: "",
    NOTIFY_EMAIL_API_KEY: "",
    NOTIFY_SMS_PROVIDER: "none",
    NOTIFY_DEDUPE_WINDOW_MINUTES: "60",
    NOTIFY_QUIET_HOURS_DEFAULT: "22:00-08:00",
    NOTIFY_BATCH_SIZE: "50",
  },
} as const;

export interface NotifyConfig {
  emailProvider: string;
  emailFrom: string;
  emailApiKey: string;
  smsProvider: string;
  dedupeWindowMinutes: number;
  quietHoursDefault: string;
  batchSize: number;
  raw: LoadedConfig;
}

export function loadNotifyConfig(env?: NodeJS.ProcessEnv): NotifyConfig {
  const raw = loadConfig(SPEC, env);
  return {
    emailProvider: raw.get("NOTIFY_EMAIL_PROVIDER"),
    emailFrom: raw.get("NOTIFY_EMAIL_FROM"),
    emailApiKey: raw.get("NOTIFY_EMAIL_API_KEY"),
    smsProvider: raw.get("NOTIFY_SMS_PROVIDER"),
    dedupeWindowMinutes: raw.int("NOTIFY_DEDUPE_WINDOW_MINUTES", { min: 1 }),
    quietHoursDefault: raw.get("NOTIFY_QUIET_HOURS_DEFAULT"),
    batchSize: raw.int("NOTIFY_BATCH_SIZE", { min: 1, max: 500 }),
    raw,
  };
}
