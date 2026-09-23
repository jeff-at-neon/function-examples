/**
 * SQL generation for the staged upsert. Pure so the conflict-key handling and identifier quoting
 * are unit tested; every identifier comes from a definition row, so quote it and never interpolate.
 */

import { quoteIdent } from "@neon-blocks/core";

export interface Definition {
  target_schema: string;
  target_table: string;
  conflict_keys: string[];
}

/**
 * Build a multi-row INSERT for `rowCount` rows over `columns`. When the definition declares
 * conflict keys it upserts (ON CONFLICT DO UPDATE on the non-key columns); with none it is a plain
 * insert. Placeholders are `$1..$N` in row-major order, so the caller flattens rows the same way.
 */
export function buildInsertSql(
  def: Definition,
  columns: readonly string[],
  rowCount: number,
): string {
  if (columns.length === 0) throw new Error("no target columns to insert");
  if (rowCount < 1) throw new Error("no rows to insert");

  const table = `${quoteIdent(def.target_schema)}.${quoteIdent(def.target_table)}`;
  const cols = columns.map((c) => quoteIdent(c));
  const colList = cols.join(", ");

  const tuples: string[] = [];
  let p = 1;
  for (let r = 0; r < rowCount; r++) {
    tuples.push(`(${columns.map(() => `$${p++}`).join(", ")})`);
  }

  let conflict = "";
  if (def.conflict_keys.length > 0) {
    const keys = def.conflict_keys.map((k) => quoteIdent(k)).join(", ");
    const updates = columns
      .filter((c) => !def.conflict_keys.includes(c))
      .map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`);
    conflict = updates.length
      ? ` ON CONFLICT (${keys}) DO UPDATE SET ${updates.join(", ")}`
      : ` ON CONFLICT (${keys}) DO NOTHING`;
  }

  return `INSERT INTO ${table} (${colList}) VALUES ${tuples.join(", ")}${conflict}`;
}
