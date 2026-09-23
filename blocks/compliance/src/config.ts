/**
 * Block config. Separated from the handler so it can be unit tested without a pool.
 */

import { loadConfig, type LoadedConfig } from "@neon-blocks/core";

export const SPEC = {
  block: "compliance",
  optional: {
    COMPLIANCE_HASH_CHAIN: "true",
    COMPLIANCE_RETENTION_DAYS: "30",
    COMPLIANCE_AUDIT_RETENTION_DAYS: "2555",
  },
} as const;

export interface ComplianceConfig {
  hashChain: boolean;
  retentionDays: number;
  auditRetentionDays: number;
  raw: LoadedConfig;
}

export function loadComplianceConfig(env?: NodeJS.ProcessEnv): ComplianceConfig {
  const raw = loadConfig(SPEC, env);
  return {
    hashChain: raw.bool("COMPLIANCE_HASH_CHAIN"),
    retentionDays: raw.int("COMPLIANCE_RETENTION_DAYS", { min: 1, max: 36_500 }),
    auditRetentionDays: raw.int("COMPLIANCE_AUDIT_RETENTION_DAYS", { min: 1, max: 36_500 }),
    raw,
  };
}
