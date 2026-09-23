/**
 * Block config. Separated from the handler so it can be unit tested without a pool.
 */

import { loadConfig, type LoadedConfig } from "@neon-blocks/core";

export const SPEC = {
  block: "csv-import",
  required: ["CSV_BUCKET"],
  optional: {
    CSV_PREFIX: "imports/",
    CSV_REPORT_PREFIX: "import-reports/",
    CSV_MAX_BYTES: "52428800",
    CSV_MAX_ROWS: "100000",
    CSV_ABORT_ON_ERROR: "false",
  },
} as const;

export interface CsvConfig {
  bucket: string;
  prefix: string;
  reportPrefix: string;
  maxBytes: number;
  maxRows: number;
  abortOnError: boolean;
  raw: LoadedConfig;
}

export function loadCsvConfig(env?: NodeJS.ProcessEnv): CsvConfig {
  const raw = loadConfig(SPEC, env);
  return {
    bucket: raw.get("CSV_BUCKET"),
    prefix: raw.get("CSV_PREFIX"),
    reportPrefix: raw.get("CSV_REPORT_PREFIX"),
    maxBytes: raw.int("CSV_MAX_BYTES", { min: 1024 }),
    maxRows: raw.int("CSV_MAX_ROWS", { min: 1 }),
    abortOnError: raw.bool("CSV_ABORT_ON_ERROR"),
    raw,
  };
}
