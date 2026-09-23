/**
 * Block 25 — Database Health Pack.
 *
 * Slow-query digest, unused-index and bloat detection, long-transaction alerts, and trend comparison across snapshots.
 *
 * Cheap to build and it makes the platform feel like it is looking after you. Every one of these
 * questions is answerable from Postgres' own catalogs, but nobody remembers to ask until something
 * is already slow. The schema-drift check is the Neon-specific one: comparing a branch against its
 * parent catches the migration applied in dev and forgotten in production, which is a class of
 * outage that branching makes easier to create.
 *
 * Routes:
 *   POST   /snapshot              Cron. Take a snapshot and record findings.
 *   GET    /findings              Findings from the latest snapshot.
 *   GET    /trends                Statements whose mean time is rising.
 *
 * STATUS: scaffold. The schema, safety checks, and control flow are real; the marked TODO seams are
 * the remaining work. Endpoints that are not implemented return 501 with a specific explanation
 * rather than failing in a way that looks like a bug.
 */

import {
  assertTriggerAuthentic,
  checkHealth,
  createLogger,
  getPool,
  json,
  parseTriggerEvent,
  problem,
  Router,
  ValidationError,
  type Logger,
} from "@neon-blocks/core";
import { autoMigrate } from "@neon-blocks/migrate";
import { loadHealthConfig } from "./config.js";
import { assessConnectionPressure, capacityCostNote } from "./capacity.js";
import { runSchemaDrift } from "./drift-run.js";

const log: Logger = createLogger({ block: "db-health" });

const router = new Router();

router.post("/snapshot", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", `/snapshot expects a schedule trigger, got ${event.type}`);
  }

  const cfg = loadHealthConfig();
  const pool = getPool();

  // Check availability before querying. pg_stat_statements needs shared_preload_libraries, which is
  // not settable per-database, so its absence is a platform fact rather than a misconfiguration --
  // and reporting zero slow queries because the extension is missing would be a lie.
  const { rows: ext } = await pool.query<{ available: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS available`,
  );
  const hasStatements = ext[0]?.available === true;

  const { rows: snap } = await pool.query<{ id: string }>(
    `INSERT INTO blocks_db_health.snapshots
       (stats_age_seconds, database_bytes, connection_count, has_statements_ext)
     VALUES (
       (SELECT EXTRACT(EPOCH FROM (now() - stats_reset))::bigint
          FROM pg_stat_database WHERE datname = current_database()),
       pg_database_size(current_database()),
       (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()),
       $1
     )
     RETURNING id`,
    [hasStatements],
  );

  const snapshotId = snap[0]?.id;
  if (!snapshotId) throw new Error("Failed to record snapshot");

  let findingsRecorded = 0;

  // Unused indexes. The stats-reset age is embedded in the finding text, because idx_scan = 0 on a
  // recently-restarted database means nothing and the advice would be actively harmful without it.
  const { rowCount: unused } = await pool.query(
    `INSERT INTO blocks_db_health.findings
       (snapshot_id, kind, severity, object_name, detail, metrics, suggested_sql)
     SELECT $1,
            'unused_index',
            'info',
            s.schemaname || '.' || s.indexrelname,
            format(
              'Index has %s scans and occupies %s. Statistics were reset %s ago -- if that is ' ||
              'recent, this finding is not yet meaningful.',
              s.idx_scan,
              pg_size_pretty(pg_relation_size(s.indexrelid)),
              (SELECT COALESCE(age(now(), stats_reset)::text, 'unknown')
                 FROM pg_stat_database WHERE datname = current_database())
            ),
            jsonb_build_object('idx_scan', s.idx_scan,
                               'size_bytes', pg_relation_size(s.indexrelid)),
            format('DROP INDEX %I.%I;', s.schemaname, s.indexrelname)
     FROM pg_stat_user_indexes s
     JOIN pg_index i ON i.indexrelid = s.indexrelid
     WHERE s.idx_scan = 0
       -- Never suggest dropping a constraint-backing index: it would drop the constraint with it.
       AND NOT i.indisunique
       AND NOT i.indisprimary
       AND pg_relation_size(s.indexrelid) > $2
       AND s.schemaname NOT LIKE 'blocks_%'`,
    [snapshotId, cfg.minTableBytes],
  );
  findingsRecorded += unused ?? 0;

  // Tables likely needing a vacuum. Uses the real dead-tuple counter rather than a statistical bloat
  // estimate -- simpler and more trustworthy, though it reflects tuples awaiting vacuum rather than
  // physical file bloat.
  const { rowCount: bloat } = await pool.query(
    `INSERT INTO blocks_db_health.findings
       (snapshot_id, kind, severity, object_name, detail, metrics, suggested_sql)
     SELECT $1,
            'table_bloat',
            CASE WHEN 100.0 * n_dead_tup / GREATEST(n_live_tup + n_dead_tup, 1) > 40
                 THEN 'warn' ELSE 'info' END,
            schemaname || '.' || relname,
            format('%s dead tuples versus %s live (%s%%). Last autovacuum: %s.',
                   n_dead_tup, n_live_tup,
                   round(100.0 * n_dead_tup / GREATEST(n_live_tup + n_dead_tup, 1), 1),
                   COALESCE(last_autovacuum::text, 'never')),
            jsonb_build_object('dead_tuples', n_dead_tup, 'live_tuples', n_live_tup),
            format('VACUUM ANALYZE %I.%I;', schemaname, relname)
     FROM pg_stat_user_tables
     WHERE n_dead_tup > 1000
       AND 100.0 * n_dead_tup / GREATEST(n_live_tup + n_dead_tup, 1) > $2
       AND pg_relation_size(relid) > $3`,
    [
      snapshotId,
      cfg.bloatWarnPct,
      cfg.minTableBytes,
    ],
  );
  findingsRecorded += bloat ?? 0;

  // Long-running transactions. The highest-value cheap check here: one forgotten session holds back
  // vacuum for the ENTIRE database, so bloat appears everywhere and the cause is not local to the
  // table that looks bloated.
  const { rowCount: longTx } = await pool.query(
    `INSERT INTO blocks_db_health.findings
       (snapshot_id, kind, severity, object_name, detail, metrics)
     SELECT $1,
            'long_transaction',
            'warn',
            'pid ' || pid,
            format('Transaction open for %s in state %s. Long transactions hold back vacuum for ' ||
                   'the entire database, so one forgotten session causes bloat everywhere.',
                   age(now(), xact_start), state),
            jsonb_build_object('pid', pid, 'state', state,
                               'seconds', EXTRACT(EPOCH FROM (now() - xact_start))::bigint)
     FROM pg_stat_activity
     WHERE xact_start IS NOT NULL
       AND now() - xact_start > interval '10 minutes'
       AND datname = current_database()
       AND pid <> pg_backend_pid()`,
    [snapshotId],
  );
  findingsRecorded += longTx ?? 0;

  // Slow statements, only when the extension exists.
  let slowQueries = 0;
  if (hasStatements) {
    const { rowCount } = await pool.query(
      `INSERT INTO blocks_db_health.query_stats
         (snapshot_id, query_id, query_text, calls, total_ms, mean_ms, rows_returned)
       SELECT $1, queryid, left(query, 2000), calls, total_exec_time, mean_exec_time, rows
       FROM pg_stat_statements
       WHERE mean_exec_time > $2
         AND query NOT LIKE '%pg_stat_statements%'
       ORDER BY mean_exec_time DESC
       LIMIT 100`,
      [snapshotId, cfg.slowQueryMs],
    );
    slowQueries = rowCount ?? 0;
  }

  // Capacity signals. Connection pressure is directly observable; capacity-hours (active vs. idle
  // CU) needs invocation data a SQL function cannot read, so that finding reports size and says so
  // rather than faking a compute estimate.
  const { rows: caps } = await pool.query<{ conns: number; max_conns: number; db_bytes: string }>(
    `SELECT (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS conns,
            current_setting('max_connections')::int AS max_conns,
            pg_database_size(current_database())::bigint AS db_bytes`,
  );
  const cap = caps[0];
  if (cap) {
    const pressure = assessConnectionPressure(cap.conns, cap.max_conns);
    const capacityFindings = [capacityCostNote(Number(cap.db_bytes)), ...(pressure ? [pressure] : [])];
    for (const f of capacityFindings) {
      await pool.query(
        `INSERT INTO blocks_db_health.findings (snapshot_id, kind, severity, object_name, detail, metrics)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [snapshotId, f.kind, f.severity, f.objectName, f.detail, JSON.stringify(f.metrics)],
      );
      findingsRecorded++;
    }
  }

  // Schema drift against the parent branch — the Neon-specific check. Only runs when a parent
  // connection is configured; a block cannot assume it has one.
  let driftChecked = false;
  if (cfg.parentDatabaseUrl) {
    driftChecked = true;
    findingsRecorded += await runSchemaDrift(pool, {
      snapshotId,
      parentDatabaseUrl: cfg.parentDatabaseUrl,
    });
  }

  // Prune old snapshots. Findings and query_stats cascade with them.
  await pool.query(
    `DELETE FROM blocks_db_health.snapshots
     WHERE taken_at < now() - make_interval(days => $1::int)`,
    [cfg.retentionDays],
  );

  const result = {
    snapshotId,
    findingsRecorded,
    slowQueriesRecorded: slowQueries,
    statementsExtAvailable: hasStatements,
    schemaDriftChecked: driftChecked,
  };
  log.info("health snapshot complete", result);

  return json({
    ok: true,
    scheduledAt: event.scheduledAt,
    ...result,
    note: hasStatements
      ? undefined
      : "pg_stat_statements is not installed, so no query analysis was possible. It must be in " +
        "shared_preload_libraries, which is not settable per-database.",
  });
});

router.get("/findings", async (_request, ctx) => {
  const kind = ctx.url.searchParams.get("kind");

  // Latest snapshot only: older findings are kept for trends, but showing them all at once would mix
  // resolved issues with live ones.
  const { rows } = await getPool().query(
    `SELECT f.kind, f.severity, f.object_name, f.detail, f.metrics, f.suggested_sql, s.taken_at
     FROM blocks_db_health.findings f
     JOIN blocks_db_health.snapshots s ON s.id = f.snapshot_id
     WHERE s.id = (SELECT id FROM blocks_db_health.snapshots ORDER BY taken_at DESC LIMIT 1)
       AND ($1::text IS NULL OR f.kind = $1)
     ORDER BY CASE f.severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END,
              f.kind, f.object_name`,
    [kind],
  );

  return json({
    count: rows.length,
    findings: rows,
    // Repeated on every response: CREATE INDEX and VACUUM on a large production table are real
    // operations, and this block deliberately never runs them.
    note: "suggested_sql is a suggestion, never executed automatically. Review before applying.",
  });
});

router.get("/trends", async (_request, ctx) => {
  const limit = Math.min(Number(ctx.url.searchParams.get("limit") ?? "20"), 100);

  // What got slower, which is the actionable version of "what is slow". Compares each statement's
  // most recent mean against its oldest retained one.
  const { rows } = await getPool().query(
    `WITH ranked AS (
       SELECT q.query_id,
              q.query_text,
              first_value(q.mean_ms) OVER (PARTITION BY q.query_id ORDER BY s.taken_at DESC) AS latest_ms,
              first_value(q.mean_ms) OVER (PARTITION BY q.query_id ORDER BY s.taken_at ASC)  AS earliest_ms
       FROM blocks_db_health.query_stats q
       JOIN blocks_db_health.snapshots s ON s.id = q.snapshot_id
     )
     SELECT DISTINCT query_id,
            left(query_text, 200) AS query_text,
            round(earliest_ms::numeric, 2) AS earliest_mean_ms,
            round(latest_ms::numeric, 2)   AS latest_mean_ms,
            round((latest_ms - earliest_ms)::numeric, 2) AS delta_ms
     FROM ranked
     WHERE latest_ms > earliest_ms * 1.5
       AND latest_ms > 10
     ORDER BY delta_ms DESC
     LIMIT $1`,
    [limit],
  );

  return json({ count: rows.length, regressions: rows });
});

router.get("/health", async () => {
  const report = await checkHealth(getPool(), {
    block: "db-health",
    schema: "blocks_db_health",
    evaluate: (status) => {
      const problems: string[] = [];

      const recent = Number(status["snapshots_recent"] ?? 0);
      const critical = Number(status["findings_critical"] ?? 0);
      const warn = Number(status["findings_warn"] ?? 0);
      const hasExt = status["statements_ext_available"] === true;

      if (recent === 0) {
        problems.push(
          "no snapshot in the last two days; the /snapshot trigger may be disabled, so every " +
            "finding is out of date",
        );
      }
      if (critical > 0) problems.push(`${critical} critical finding(s) in the latest snapshot`);
      if (warn > 0) problems.push(`${warn} warning(s) in the latest snapshot`);
      if (recent > 0 && !hasExt) {
        // Absence of query findings must not read as a healthy database.
        problems.push(
          "pg_stat_statements is unavailable, so no query analysis is possible. Absent slow-query " +
            "findings do not mean there are none.",
        );
      }
      return problems;
    },
  });

  return json(report, { status: report.status === "ok" ? 200 : 503 });
});

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new ValidationError("Request body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value === "") {
    throw new ValidationError(`"${key}" is required and must be a non-empty string`);
  }
  return value;
}

export default autoMigrate({
  block: "db-health",
  migrationsUrl: new URL("./migrations/", import.meta.url),
  fetch: (request: Request): Promise<Response> => router.handle(request),
});

// Re-exported so unit tests can import the pure logic directly.
export { loadHealthConfig, SPEC } from "./config.js";
export { buildCatalogSql, diffCatalogs } from "./drift.js";
export { assessConnectionPressure, capacityCostNote } from "./capacity.js";
