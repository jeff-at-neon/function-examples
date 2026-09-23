/**
 * SQL builders and shaping for subject export, erasure, and purge. Pure, so identifier quoting and
 * the legal-hold filter are unit tested; every identifier comes from a subject_links row, so quote
 * it and never interpolate.
 */

import { quoteIdent } from "@neon-blocks/core";

export interface SubjectLink {
  target_schema: string;
  target_table: string;
  subject_column: string;
  handling: string;
}

function table(link: SubjectLink): string {
  return `${quoteIdent(link.target_schema)}.${quoteIdent(link.target_table)}`;
}

/** All of a subject's rows in one linked table. */
export function buildSubjectSelectSql(link: SubjectLink): string {
  return `SELECT * FROM ${table(link)} WHERE ${quoteIdent(link.subject_column)} = $1`;
}

/** Hard delete (handling = 'erase'). */
export function buildEraseSql(link: SubjectLink): string {
  return `DELETE FROM ${table(link)} WHERE ${quoteIdent(link.subject_column)} = $1`;
}

/**
 * Anonymize in place (handling = 'anonymize'): break the subject link by redacting the identifier
 * column, for rows that must survive for accounting. Full column-level masking is the pii-anonymizer
 * block's job.
 */
export function buildAnonymizeSql(link: SubjectLink): string {
  const col = quoteIdent(link.subject_column);
  return `UPDATE ${table(link)} SET ${col} = '[erased]' WHERE ${col} = $1`;
}

/** Soft-delete purge: delete rows past retention, assuming a `deleted_at` column convention. */
export function buildSoftDeletePurgeSql(link: SubjectLink): string {
  return `DELETE FROM ${table(link)}
          WHERE deleted_at IS NOT NULL AND deleted_at < now() - make_interval(days => $1::int)`;
}

/** Fold per-table row counts into one object keyed by schema.table. */
export function summarizeCounts(
  perTable: readonly { table: string; count: number }[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of perTable) out[t.table] = (out[t.table] ?? 0) + t.count;
  return out;
}

/** Assemble one export document keyed by schema.table. */
export function assembleExportDoc(
  perTable: readonly { table: string; rows: unknown[] }[],
): Record<string, unknown[]> {
  const doc: Record<string, unknown[]> = {};
  for (const t of perTable) doc[t.table] = t.rows;
  return doc;
}

export interface LegalHold {
  subject_ref: string | null;
}

/**
 * Drop subjects covered by an active legal hold. A hold with a null subject_ref is global (litigation
 * touching everyone), so it suppresses the entire purge — erasing data under litigation destroys
 * evidence.
 */
export function filterHeld(candidates: readonly string[], holds: readonly LegalHold[]): string[] {
  if (holds.some((h) => h.subject_ref == null)) return [];
  const held = new Set(holds.map((h) => h.subject_ref));
  return candidates.filter((c) => !held.has(c));
}
