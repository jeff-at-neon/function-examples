/**
 * Import orchestration: the impure edge that reads the object, writes rows, and stores the error
 * report. Parsing, coercion, validation, and SQL generation are delegated to the pure modules; this
 * file only sequences them and persists status transitions so the reconciler can spot a stuck import.
 */

import { withTransaction, type Queryable } from "@neon-blocks/core";
import type { StorageClient } from "@neon-blocks/storage";
import { parseCsv } from "./parse.js";
import { buildRejectedCsv, mapHeaders, validateRow, type ColumnMap, type RowError } from "./coerce.js";
import { buildInsertSql } from "./merge.js";
import type { CsvConfig } from "./config.js";

export interface ImportEvent {
  bucketName: string;
  objectKey: string;
  etag: string;
}

export interface ImportResult {
  status: "ready" | "failed" | "skipped";
  reason?: string;
  rowsTotal: number;
  rowsImported: number;
  rowsRejected: number;
  reportKey?: string;
}

/**
 * The definition to apply is the first path segment after the configured prefix:
 * `imports/customers/2026-01.csv` -> `customers`.
 */
export function definitionCodeFromKey(objectKey: string, prefix: string): string | null {
  const rest = objectKey.startsWith(prefix) ? objectKey.slice(prefix.length) : objectKey;
  const segment = rest.split("/").filter((s) => s !== "")[0];
  return segment ?? null;
}

type DefinitionRow = {
  target_schema: string;
  target_table: string;
  conflict_keys: string[];
  column_map: ColumnMap;
};

export async function runImport(
  deps: { db: Queryable; storage: StorageClient },
  opts: { event: ImportEvent; cfg: CsvConfig },
): Promise<ImportResult> {
  const { db, storage } = deps;
  const { event, cfg } = opts;

  const code = definitionCodeFromKey(event.objectKey, cfg.prefix);
  if (!code) {
    return { status: "skipped", reason: "no definition code in object key", rowsTotal: 0, rowsImported: 0, rowsRejected: 0 };
  }

  const { rows: defs } = await db.query<DefinitionRow>(
    `SELECT target_schema, target_table, column_map, conflict_keys
     FROM blocks_csv_import.definitions WHERE code = $1`,
    [code],
  );
  const def = defs[0];
  if (!def) {
    return { status: "skipped", reason: `no definition "${code}"`, rowsTotal: 0, rowsImported: 0, rowsRejected: 0 };
  }

  // Record the import (idempotent on the identity key), moving it straight to 'parsing'.
  const { rows: created } = await db.query<{ id: string }>(
    `INSERT INTO blocks_csv_import.imports (bucket_name, object_key, etag, definition_code, status)
     VALUES ($1, $2, $3, $4, 'parsing')
     ON CONFLICT (bucket_name, object_key, etag) DO NOTHING
     RETURNING id`,
    [event.bucketName, event.objectKey, event.etag, code],
  );
  const importId = created[0]?.id;
  if (!importId) {
    return { status: "skipped", reason: "already imported", rowsTotal: 0, rowsImported: 0, rowsRejected: 0 };
  }

  const { body } = await storage.getObject(event.bucketName, event.objectKey, { maxBytes: cfg.maxBytes });
  const rows = parseCsv(new TextDecoder().decode(body));
  const header = rows[0] ?? [];
  const dataRows = rows.slice(1).filter((r) => r.some((cell) => cell !== ""));

  const mapping = mapHeaders(header, def.column_map);
  if (mapping.length === 0) {
    await finish(db, importId, "failed", 0, 0, 0, null, "no CSV headers matched the definition column map");
    return { status: "failed", reason: "no headers matched", rowsTotal: dataRows.length, rowsImported: 0, rowsRejected: 0 };
  }

  const targetColumns = [...new Set(mapping.map((m) => m.spec.column))];
  const validRows: (string | number | boolean | null)[][] = [];
  const rejected: { line: number; cells: readonly string[]; errors: readonly RowError[] }[] = [];
  const allErrors: RowError[] = [];

  dataRows.forEach((cells, idx) => {
    const line = idx + 2; // header is line 1
    const { values, errors } = validateRow(cells, mapping, line);
    if (errors.length > 0) {
      rejected.push({ line, cells, errors });
      allErrors.push(...errors);
    } else {
      validRows.push(targetColumns.map((c) => values[c] ?? null));
    }
  });

  await db.query(`UPDATE blocks_csv_import.imports SET status = 'merging', updated_at = now() WHERE id = $1`, [importId]);

  if (validRows.length > 0) {
    await withTransaction(db as never, async (client) => {
      const sql = buildInsertSql(def, targetColumns, validRows.length);
      await client.query(sql, validRows.flat());
    });
  }

  // Persist the row errors and the rejected-rows report.
  let reportKey: string | null = null;
  if (rejected.length > 0) {
    for (const r of rejected) {
      for (const e of r.errors) {
        await db.query(
          `INSERT INTO blocks_csv_import.row_errors (import_id, line_number, column_name, reason, raw_row)
           VALUES ($1, $2, $3, $4, $5)`,
          [importId, e.line, e.column ?? null, e.reason, r.cells.join(",")],
        );
      }
    }
    reportKey = `${cfg.reportPrefix}${importId}.csv`;
    const report = buildRejectedCsv(header, rejected);
    await deps.storage.putObject(event.bucketName, reportKey, new TextEncoder().encode(report), {
      contentType: "text/csv",
    });
  }

  const status: "ready" | "failed" =
    cfg.abortOnError && rejected.length > 0 ? "failed" : "ready";
  await finish(db, importId, status, dataRows.length, validRows.length, rejected.length, reportKey, null);

  return {
    status,
    rowsTotal: dataRows.length,
    rowsImported: validRows.length,
    rowsRejected: rejected.length,
    ...(reportKey ? { reportKey } : {}),
  };
}

async function finish(
  db: Queryable,
  importId: string,
  status: "ready" | "failed",
  total: number,
  imported: number,
  rejected: number,
  reportKey: string | null,
  error: string | null,
): Promise<void> {
  await db.query(
    `UPDATE blocks_csv_import.imports
     SET status = $2, rows_total = $3, rows_imported = $4, rows_rejected = $5,
         report_key = $6, error = $7, updated_at = now(), finished_at = now()
     WHERE id = $1`,
    [importId, status, total, imported, rejected, reportKey, error],
  );
}
