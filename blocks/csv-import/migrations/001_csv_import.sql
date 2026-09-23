-- Block 11: csv / excel import.
--
-- Unglamorous and universally needed. "Drop a CSV in a bucket and it lands in Postgres, with a report of the 14 bad rows" sells itself to every enterprise team, and the row-level error report is the part people actually care about — an import that fails wholesale on row 4,000 is worse than useless.

CREATE SCHEMA IF NOT EXISTS blocks_csv_import;

-- An import definition: which target table, and how columns map and coerce. Declared rather than
-- inferred, because inferring types makes column 'zip' an integer and turns 02134 into 2134.
CREATE TABLE IF NOT EXISTS blocks_csv_import.definitions (
  code            text        PRIMARY KEY,
  target_schema   text        NOT NULL,
  target_table    text        NOT NULL,
  -- csv header -> {column, type, required, default}
  column_map      jsonb       NOT NULL,
  -- Target columns forming the natural key for upsert. Empty means insert-only.
  conflict_keys   text[]      NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS blocks_csv_import.imports (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_name     text        NOT NULL,
  object_key      text        NOT NULL,
  etag            text        NOT NULL,
  definition_code text        REFERENCES blocks_csv_import.definitions(code),

  status          text        NOT NULL DEFAULT 'pending',
  rows_total      integer     NOT NULL DEFAULT 0,
  rows_imported   integer     NOT NULL DEFAULT 0,
  rows_rejected   integer     NOT NULL DEFAULT 0,

  -- Key of the error report written back to storage. The round trip -- fix the report, re-upload --
  -- is the feature users actually want.
  report_key      text,
  error           text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,

  CONSTRAINT imports_status_valid
    CHECK (status IN ('pending', 'parsing', 'validating', 'merging', 'ready', 'failed', 'skipped')),
  CONSTRAINT imports_identity UNIQUE (bucket_name, object_key, etag)
);

CREATE INDEX IF NOT EXISTS imports_status_idx ON blocks_csv_import.imports (status, created_at);

-- One row per rejected input row. A line number and a reason, which is what makes an error report
-- actionable rather than just a failure count.
CREATE TABLE IF NOT EXISTS blocks_csv_import.row_errors (
  id          bigserial   PRIMARY KEY,
  import_id   uuid        NOT NULL REFERENCES blocks_csv_import.imports(id) ON DELETE CASCADE,
  line_number integer     NOT NULL,
  column_name text,
  reason      text        NOT NULL,
  raw_row     text,

  CONSTRAINT row_errors_line_sane CHECK (line_number >= 1)
);

CREATE INDEX IF NOT EXISTS row_errors_import_idx ON blocks_csv_import.row_errors (import_id, line_number);

-- ---------------------------------------------------------------------------
-- Observability (§10)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW blocks_csv_import.v_status AS
SELECT
  count(*)                                              AS imports_total,
  count(*) FILTER (WHERE status = 'ready')               AS imports_ready,
  count(*) FILTER (WHERE status = 'failed')              AS imports_failed,
  count(*) FILTER (WHERE status = 'skipped')             AS imports_skipped,
  -- Stuck mid-pipeline: a function died between parsing and merging. The reconciler resets these.
  count(*) FILTER (WHERE status IN ('parsing', 'validating', 'merging')
                     AND updated_at < now() - interval '1 hour') AS imports_stuck,
  COALESCE(sum(rows_imported), 0)                        AS rows_imported_total,
  COALESCE(sum(rows_rejected), 0)                        AS rows_rejected_total,
  (SELECT count(*) FROM blocks_csv_import.definitions)   AS definitions_count
FROM blocks_csv_import.imports
;
