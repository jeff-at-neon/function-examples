-- Block 25: database health pack.
--
-- Cheap to build and it makes the platform feel like it is looking after you. Every one of these
-- questions is answerable from Postgres' own catalogs, but nobody remembers to ask until something
-- is already slow. The schema-drift check is the Neon-specific one: comparing a branch against its
-- parent catches the migration applied in dev and forgotten in production, which is a class of
-- outage that branching makes easier to create.

CREATE SCHEMA IF NOT EXISTS blocks_db_health;

-- A point-in-time reading of the catalogs. Stored rather than only reported, because one reading
-- tells you what is slow now and a series tells you what got slower.
CREATE TABLE IF NOT EXISTS blocks_db_health.snapshots (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  taken_at        timestamptz NOT NULL DEFAULT now(),

  -- How long since stats were reset. Essential context: idx_scan = 0 on a database restarted
  -- yesterday means nothing, because the counters reset.
  stats_age_seconds bigint,
  database_bytes   bigint,
  connection_count integer,

  -- False when pg_stat_statements is unavailable, so absent query findings are distinguishable from
  -- a genuinely healthy database.
  has_statements_ext boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS snapshots_taken_idx ON blocks_db_health.snapshots (taken_at DESC);

-- Findings, one row per issue per snapshot. Trended rather than replaced, so "this index has been
-- unused for three months" is answerable.
CREATE TABLE IF NOT EXISTS blocks_db_health.findings (
  id              bigserial   PRIMARY KEY,
  snapshot_id     uuid        NOT NULL REFERENCES blocks_db_health.snapshots(id) ON DELETE CASCADE,

  kind            text        NOT NULL,
  severity        text        NOT NULL DEFAULT 'info',
  object_name     text,
  detail          text        NOT NULL,
  metrics         jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- SQL that would address it. SUGGESTED, never executed: CREATE INDEX or VACUUM on a large
  -- production table is a real operation, and a block that ran it automatically would eventually do
  -- so at the worst possible moment.
  suggested_sql   text,

  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT findings_kind_valid CHECK (kind IN (
    'slow_query', 'missing_index', 'unused_index', 'duplicate_index',
    'table_bloat', 'schema_drift', 'capacity_cost', 'long_transaction', 'connection_pressure'
  )),
  CONSTRAINT findings_severity_valid CHECK (severity IN ('info', 'warn', 'critical'))
);

CREATE INDEX IF NOT EXISTS findings_snapshot_idx ON blocks_db_health.findings (snapshot_id, kind);
CREATE INDEX IF NOT EXISTS findings_kind_idx ON blocks_db_health.findings (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS findings_severity_idx
  ON blocks_db_health.findings (severity, created_at DESC)
  WHERE severity IN ('warn', 'critical');

-- Per-statement timing across snapshots, for trend detection.
CREATE TABLE IF NOT EXISTS blocks_db_health.query_stats (
  snapshot_id     uuid        NOT NULL REFERENCES blocks_db_health.snapshots(id) ON DELETE CASCADE,
  -- pg_stat_statements queryid, stable across restarts for the same normalized statement.
  query_id        bigint      NOT NULL,
  query_text      text,
  calls           bigint      NOT NULL DEFAULT 0,
  total_ms        double precision NOT NULL DEFAULT 0,
  mean_ms         double precision NOT NULL DEFAULT 0,
  rows_returned   bigint      NOT NULL DEFAULT 0,

  PRIMARY KEY (snapshot_id, query_id)
);

CREATE INDEX IF NOT EXISTS query_stats_mean_idx ON blocks_db_health.query_stats (mean_ms DESC);

-- ---------------------------------------------------------------------------
-- Observability (§10)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW blocks_db_health.v_status AS
SELECT
  (SELECT count(*) FROM blocks_db_health.snapshots)                     AS snapshots_total,
  (SELECT COALESCE(max(taken_at)::text, 'never') FROM blocks_db_health.snapshots)
                                                                        AS latest_snapshot,
  -- Stale snapshots mean the cron is not running, so every finding below is out of date.
  (SELECT count(*) FROM blocks_db_health.snapshots
     WHERE taken_at > now() - interval '2 days')                         AS snapshots_recent,

  (SELECT count(*) FROM blocks_db_health.findings f
     WHERE f.severity = 'critical'
       AND f.snapshot_id = (SELECT id FROM blocks_db_health.snapshots
                            ORDER BY taken_at DESC LIMIT 1))             AS findings_critical,
  (SELECT count(*) FROM blocks_db_health.findings f
     WHERE f.severity = 'warn'
       AND f.snapshot_id = (SELECT id FROM blocks_db_health.snapshots
                            ORDER BY taken_at DESC LIMIT 1))             AS findings_warn,

  -- Whether query analysis is possible at all. False means findings are absent because the extension
  -- is missing, not because the database is healthy.
  (SELECT COALESCE(bool_or(has_statements_ext), false) FROM blocks_db_health.snapshots
     WHERE taken_at > now() - interval '2 days')                         AS statements_ext_available,
  (SELECT count(*) FROM blocks_db_health.query_stats)                    AS query_stat_rows
;
