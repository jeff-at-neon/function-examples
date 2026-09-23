/**
 * Schema-drift execution: the impure edge that opens a second connection to the parent branch,
 * fetches both catalogs, and records the diff. The comparison itself is the pure diffCatalogs in
 * drift.ts. Needs a parent connection string; a block cannot assume it has one, so the caller only
 * invokes this when HEALTH_PARENT_DATABASE_URL is set.
 */

import { Client } from "pg";
import type { Queryable } from "@neon-blocks/core";
import { buildCatalogSql, diffCatalogs, type Column } from "./drift.js";

export async function runSchemaDrift(
  db: Queryable,
  opts: { snapshotId: string; parentDatabaseUrl: string },
): Promise<number> {
  const { rows: current } = await db.query<Column>(buildCatalogSql());

  const client = new Client({ connectionString: opts.parentDatabaseUrl });
  let parent: Column[];
  try {
    await client.connect();
    const result = await client.query(buildCatalogSql());
    parent = result.rows as Column[];
  } finally {
    await client.end().catch(() => {});
  }

  const findings = diffCatalogs(current, parent);
  for (const f of findings) {
    await db.query(
      `INSERT INTO blocks_db_health.findings (snapshot_id, kind, severity, object_name, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [opts.snapshotId, f.kind, f.severity, f.objectName, f.detail],
    );
  }
  return findings.length;
}
