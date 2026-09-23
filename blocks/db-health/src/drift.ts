/**
 * Schema-drift detection: compare this branch's catalog against its parent's, catching the migration
 * applied in dev and forgotten in prod (or vice versa). The diff is pure and unit tested; fetching
 * the parent's catalog needs a second connection and is the thin edge in the handler.
 */

export type Column = {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
};

export interface DriftFinding {
  kind: "schema_drift";
  severity: "info" | "warn";
  objectName: string;
  detail: string;
}

/** Catalog query: user columns only, excluding system schemas and the blocks' own schemas. */
export function buildCatalogSql(): string {
  return `SELECT table_schema, table_name, column_name, data_type
          FROM information_schema.columns
          WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
            AND table_schema NOT LIKE 'blocks_%'
          ORDER BY table_schema, table_name, column_name`;
}

function key(c: Column): string {
  return `${c.table_schema}.${c.table_name}.${c.column_name}`;
}

/**
 * Diff the current branch against the parent. A column present in the parent but not here is
 * "missing in this branch" (warn — likely a migration not applied here); present here but not in the
 * parent is "extra in this branch" (info — likely a migration not promoted); a differing data_type
 * is a type drift (warn).
 */
export function diffCatalogs(current: readonly Column[], parent: readonly Column[]): DriftFinding[] {
  const currentByKey = new Map(current.map((c) => [key(c), c]));
  const parentByKey = new Map(parent.map((c) => [key(c), c]));
  const findings: DriftFinding[] = [];

  for (const [k, p] of parentByKey) {
    const c = currentByKey.get(k);
    if (!c) {
      findings.push({
        kind: "schema_drift",
        severity: "warn",
        objectName: k,
        detail: `Column exists in the parent branch but is missing here (type ${p.data_type}). A migration applied to the parent may not have been applied to this branch.`,
      });
    } else if (c.data_type !== p.data_type) {
      findings.push({
        kind: "schema_drift",
        severity: "warn",
        objectName: k,
        detail: `Type differs from the parent: here ${c.data_type}, parent ${p.data_type}.`,
      });
    }
  }
  for (const [k, c] of currentByKey) {
    if (!parentByKey.has(k)) {
      findings.push({
        kind: "schema_drift",
        severity: "info",
        objectName: k,
        detail: `Column exists in this branch but not in the parent (type ${c.data_type}). A migration here may not have been promoted to the parent.`,
      });
    }
  }
  return findings;
}
