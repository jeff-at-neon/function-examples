/**
 * Block config. Separated from the handler so it can be unit tested without a pool.
 */

import { loadConfig, type LoadedConfig } from "@neon-blocks/core";

export const SPEC = {
  block: "pii-anonymizer",
  required: ["ANONYMIZE_SALT"],
  optional: {
    ANONYMIZE_ALLOW_BRANCH_PATTERN: "^(dev|preview|staging|test)",
    ANONYMIZE_BATCH_ROWS: "5000",
  },
} as const;

export interface AnonymizeConfig {
  salt: string;
  allowBranchPattern: string;
  batchRows: number;
  raw: LoadedConfig;
}

export function loadAnonymizeConfig(env?: NodeJS.ProcessEnv): AnonymizeConfig {
  const raw = loadConfig(SPEC, env);
  return {
    salt: raw.get("ANONYMIZE_SALT"),
    allowBranchPattern: raw.get("ANONYMIZE_ALLOW_BRANCH_PATTERN"),
    batchRows: raw.int("ANONYMIZE_BATCH_ROWS", { min: 1, max: 100_000 }),
    raw,
  };
}
