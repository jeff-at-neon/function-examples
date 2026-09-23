/**
 * Change detection. All pure so the two things most likely to be subtly wrong — the content hash
 * that decides whether a row actually changed, and the watermark advance — are unit tested without
 * a database.
 *
 * The watermark rule is the one to protect: advance to the highest row actually examined, never to
 * `now()`. Advancing to `now()` skips rows modified during the scan forever.
 */

import { createHash } from "node:crypto";
import { quoteIdent } from "@neon-blocks/core";

export interface FreshnessSource {
  code: string;
  source_schema: string;
  source_table: string;
  key_column: string;
  text_columns: string[];
  updated_column: string | null;
  vector_schema: string;
  vector_table: string;
  vector_column: string;
  watermark: string | Date;
}

/**
 * Canonical text for a row: only the declared text columns, in their declared order, so an edit to
 * an unrelated column produces the same hash and does not pay for a re-embed. Null/undefined
 * columns contribute an empty string.
 */
export function buildRowText(row: Record<string, unknown>, textColumns: readonly string[]): string {
  return textColumns.map((c) => (row[c] == null ? "" : String(row[c]))).join("\n");
}

export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Epoch ms for a timestamptz that may arrive as a Date, an ISO string, or ±infinity. */
function toMs(value: string | Date | number): number {
  if (value === -Infinity || value === "-infinity") return -Infinity;
  if (value === Infinity || value === "infinity") return Infinity;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : -Infinity;
}

/**
 * The new watermark after a scan: the maximum `updated_column` among the rows actually examined,
 * never `now()` and never earlier than the current watermark. With no rows examined it stays put.
 * Returned as an ISO string (callers should only persist it when at least one row was examined).
 */
export function nextWatermark(
  examined: readonly (string | Date)[],
  current: string | Date,
): string {
  let maxMs = -Infinity;
  for (const e of examined) {
    const ms = toMs(e);
    if (ms > maxMs) maxMs = ms;
  }
  const currentMs = toMs(current);
  if (!Number.isFinite(maxMs)) {
    // Nothing examined: keep the current watermark unchanged when it is a real timestamp.
    return Number.isFinite(currentMs) ? new Date(currentMs).toISOString() : "-infinity";
  }
  return new Date(Math.max(maxMs, Number.isFinite(currentMs) ? currentMs : maxMs)).toISOString();
}

export interface Candidate {
  rowKey: string;
  contentHash: string;
}

/**
 * Split candidates into those needing a re-embed (no stored hash, or a different one) and those
 * already current. This is what stops an unrelated column change from paying for a re-embed.
 */
export function diffRows(
  candidates: readonly Candidate[],
  embeddedByKey: ReadonlyMap<string, string>,
): { toReembed: Candidate[]; unchanged: string[] } {
  const toReembed: Candidate[] = [];
  const unchanged: string[] = [];
  for (const c of candidates) {
    if (embeddedByKey.get(c.rowKey) === c.contentHash) unchanged.push(c.rowKey);
    else toReembed.push(c);
  }
  return { toReembed, unchanged };
}

/** Query for rows changed past the watermark. Every identifier comes from the caller, so quote it. */
export function buildCandidateSql(source: FreshnessSource): string {
  if (!source.updated_column) {
    throw new Error(`source "${source.code}" has no updated_column; it is outbox-driven only`);
  }
  const table = `${quoteIdent(source.source_schema)}.${quoteIdent(source.source_table)}`;
  const key = quoteIdent(source.key_column);
  const updated = quoteIdent(source.updated_column);
  const cols = source.text_columns.map((c) => quoteIdent(c)).join(", ");
  return `SELECT ${key} AS row_key, ${updated} AS updated_at, ${cols}
          FROM ${table}
          WHERE ${updated} > $1
          ORDER BY ${updated}
          LIMIT $2`;
}
