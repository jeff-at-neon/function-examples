# Block 11 — CSV / Excel Import

Spreadsheet lands in a bucket, validates into a staging table, merges typed, and writes a row-level error report back.

**Block 11 of 25**, numbered in build order.

> **Status: implemented.** Schema, safety checks, control flow, and the core logic (RFC 4180 parse,
> typed coercion with a row-level error report, and upsert) are all wired, with pure unit tests.
> Still unverified against a live Neon project.

## Why this block

Unglamorous and universally needed. "Drop a CSV in a bucket and it lands in Postgres, with a report of the 14 bad rows" sells itself to every enterprise team, and the row-level error report is the part people actually care about — an import that fails wholesale on row 4,000 is worse than useless.

## Install

```bash
neon-blocks migrate csv-import
neon function deploy csv-import --src blocks/csv-import/src
neon triggers create --function-slug csv-import --name csv-import-import \
  --bucket "$CSV_BUCKET" --function-path '/import'
neon triggers create --function-slug csv-import --name csv-import-reconcile \
  --schedule '29 * * * *' --function-path '/reconcile'
```

> Child branches inherit triggers **disabled**. Enable them after promoting, or scheduled work
> silently never runs.

## Design notes

- **Staging first, always.** Rows land in a staging table, are validated there, then merge into the target. A direct COPY into the real table means a bad row on line 4,000 either aborts the whole import or leaves it half-applied.
- **Errors are data, not exceptions.** Every rejected row is recorded with its line number, the offending column, and the reason — then written back to storage as a CSV the user can fix and re-upload. That round trip is the feature.
- **Partial success is the default.** An import with 9,986 good rows and 14 bad ones applies the 9,986. Configurable via `CSV_ABORT_ON_ERROR` for callers who genuinely need all-or-nothing.
- **Type coercion is explicit and per-column**, declared in an import definition. Inferring types from the data means column 'zip' becomes an integer and 02134 becomes 2134.

## API

| Route | Purpose |
|---|---|
| `POST /import` | Storage trigger. Import one spreadsheet. |
| `POST /reconcile` | Cron. Missed uploads and stuck imports. |
| `GET /imports/:id` | Import status plus its row errors. |
| `GET /health` | `200` / `503`. |

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `CSV_BUCKET` | *required* | Bucket to watch for spreadsheets. |
| `CSV_PREFIX` | `imports/` | Watched key prefix. |
| `CSV_REPORT_PREFIX` | `import-reports/` | Where error reports are written. Must be disjoint from CSV_PREFIX, or reports retrigger the importer. |
| `CSV_MAX_BYTES` | `52428800` | Largest file to import. Read whole, so this bounds memory. |
| `CSV_MAX_ROWS` | `100000` | Row ceiling per import. |
| `CSV_ABORT_ON_ERROR` | `false` | Abort the whole import on the first bad row instead of applying the good ones. |
| `NEON_BLOCKS_TRIGGER_SECRET` | `` | Shared secret authenticating trigger delivery. Neon does not sign trigger POSTs. |

Injected automatically by Neon: `DATABASE_URL`, `NEON_STORAGE_ENDPOINT`, `NEON_STORAGE_ACCESS_KEY_ID`, `NEON_STORAGE_SECRET_ACCESS_KEY`.

## Limits and honest caveats

- **Parsing is delegated to a TODO seam.** RFC 4180 CSV (quoted fields, embedded newlines, CRLF) needs a real parser; `parseCsv` is the marked insertion point. Naive `split(',')` corrupts any file containing a quoted comma, which is most real files.
- **Excel is not implemented.** `.xlsx` is a zip of XML and needs a library. The kind is detected and recorded as needing a parser rather than silently skipped.
- **No streaming.** Files are read whole, bounded by `CSV_MAX_BYTES`. Genuinely large imports need a streaming parser and chunked staging inserts.
- **The merge is generated from a column map**, so a definition referencing a dropped column fails at import time rather than at definition time.
- **Unverified against a live Neon project.** Nothing in this repo has been run against real Neon
  infrastructure yet.

## Observability

```sql
SELECT * FROM blocks_csv_import.v_status;
```

## Uninstall

```bash
neon-blocks rollback csv-import
```
