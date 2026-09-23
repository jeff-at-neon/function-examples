/**
 * Request execution: the impure edge that runs the generated SQL against linked tables and records
 * per-table detail. The SQL and shaping come from the pure builders in subject.ts.
 */

import { withTransaction, type Queryable } from "@neon-blocks/core";
import {
  assembleExportDoc,
  buildAnonymizeSql,
  buildEraseSql,
  buildSubjectSelectSql,
  summarizeCounts,
  type SubjectLink,
} from "./subject.js";

/** Assemble a subject's data across every linked table into one JSON document. */
export async function runExport(
  db: Queryable,
  opts: { subjectRef: string; links: readonly SubjectLink[] },
): Promise<Record<string, unknown[]>> {
  const perTable: { table: string; rows: unknown[] }[] = [];
  for (const link of opts.links) {
    const { rows } = await db.query(buildSubjectSelectSql(link), [opts.subjectRef]);
    perTable.push({ table: `${link.target_schema}.${link.target_table}`, rows });
  }
  return assembleExportDoc(perTable);
}

/** Delete or anonymize a subject's rows per link handling, returning per-table counts. */
export async function runErase(
  db: Queryable,
  opts: { subjectRef: string; links: readonly SubjectLink[] },
): Promise<Record<string, number>> {
  const perTable: { table: string; count: number }[] = [];
  await withTransaction(db as never, async (client) => {
    for (const link of opts.links) {
      if (link.handling === "export") continue; // export-only links are not erased
      const sql = link.handling === "anonymize" ? buildAnonymizeSql(link) : buildEraseSql(link);
      const { rowCount } = await client.query(sql, [opts.subjectRef]);
      perTable.push({ table: `${link.target_schema}.${link.target_table}`, count: rowCount ?? 0 });
    }
  });
  return summarizeCounts(perTable);
}
