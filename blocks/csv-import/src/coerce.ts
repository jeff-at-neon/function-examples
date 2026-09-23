/**
 * Type coercion and row validation against a definition's column map. Pure so the coercion rules
 * (declared types, never inferred — a leading-zero zip stays text) and multi-error collection are
 * unit tested without a database.
 */

import { toCsv } from "./parse.js";

export interface ColumnSpec {
  /** Target table column. */
  column: string;
  /** Declared type: text | int | numeric | bool | date. */
  type: string;
  required?: boolean;
  default?: string;
}

/** CSV header name -> how it maps and coerces into the target table. */
export type ColumnMap = Record<string, ColumnSpec>;

export interface CoerceOk {
  value: string | number | boolean | null;
}
export interface CoerceErr {
  error: string;
}

/**
 * Coerce a raw cell to its declared type. Types are declared, never inferred: a zip code declared
 * `text` stays "02134" rather than becoming the integer 2134.
 */
export function coerceValue(raw: string, type: string): CoerceOk | CoerceErr {
  const t = type.toLowerCase();
  switch (t) {
    case "text":
    case "string":
      return { value: raw };
    case "int":
    case "integer":
    case "bigint": {
      if (!/^-?\d+$/.test(raw.trim())) return { error: `"${raw}" is not an integer` };
      return { value: Number.parseInt(raw.trim(), 10) };
    }
    case "numeric":
    case "number":
    case "float":
    case "double": {
      const n = Number(raw.trim());
      if (raw.trim() === "" || !Number.isFinite(n)) return { error: `"${raw}" is not a number` };
      return { value: n };
    }
    case "bool":
    case "boolean": {
      const v = raw.trim().toLowerCase();
      if (["true", "t", "1", "yes", "y"].includes(v)) return { value: true };
      if (["false", "f", "0", "no", "n"].includes(v)) return { value: false };
      return { error: `"${raw}" is not a boolean` };
    }
    case "date":
    case "timestamp":
    case "timestamptz": {
      const ms = Date.parse(raw.trim());
      if (Number.isNaN(ms)) return { error: `"${raw}" is not a valid date` };
      return { value: raw.trim() }; // hand the original string to Postgres to cast
    }
    default:
      return { error: `unknown column type "${type}"` };
  }
}

export interface HeaderMapping {
  /** Index into the CSV row. */
  index: number;
  header: string;
  spec: ColumnSpec;
}

/** Resolve which CSV columns map to target columns. Unknown headers are ignored (not an error). */
export function mapHeaders(headerRow: readonly string[], columnMap: ColumnMap): HeaderMapping[] {
  const mapping: HeaderMapping[] = [];
  headerRow.forEach((header, index) => {
    const spec = columnMap[header];
    if (spec) mapping.push({ index, header, spec });
  });
  return mapping;
}

export interface RowError {
  line: number;
  column?: string;
  reason: string;
}

export interface ValidatedRow {
  values: Record<string, string | number | boolean | null>;
  errors: RowError[];
}

/**
 * Validate one CSV row against the header mapping, collecting every error rather than throwing on
 * the first — an import that fails wholesale on row 4,000 is worse than useless. Applies defaults
 * for empty optional cells; a missing required cell is an error.
 */
export function validateRow(
  cells: readonly string[],
  mapping: readonly HeaderMapping[],
  lineNumber: number,
): ValidatedRow {
  const values: Record<string, string | number | boolean | null> = {};
  const errors: RowError[] = [];

  for (const { index, header, spec } of mapping) {
    const raw = cells[index] ?? "";
    if (raw === "") {
      if (spec.default !== undefined) {
        values[spec.column] = spec.default;
      } else if (spec.required) {
        errors.push({ line: lineNumber, column: header, reason: "required value is missing" });
      } else {
        values[spec.column] = null;
      }
      continue;
    }
    const coerced = coerceValue(raw, spec.type);
    if ("error" in coerced) {
      errors.push({ line: lineNumber, column: header, reason: coerced.error });
    } else {
      values[spec.column] = coerced.value;
    }
  }

  return { values, errors };
}

/**
 * Build the rejected-rows report as CSV: the original header plus `_line` and `_errors`, with every
 * field re-escaped so the report itself re-parses cleanly (the round trip is the feature).
 */
export function buildRejectedCsv(
  header: readonly string[],
  rejected: readonly { line: number; cells: readonly string[]; errors: readonly RowError[] }[],
): string {
  const rows: string[][] = [[...header, "_line", "_errors"]];
  for (const r of rejected) {
    const reasons = r.errors
      .map((e) => (e.column ? `${e.column}: ${e.reason}` : e.reason))
      .join("; ");
    rows.push([...r.cells, String(r.line), reasons]);
  }
  return toCsv(rows);
}
