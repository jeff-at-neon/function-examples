# Block 25 — Database Health Pack

Slow-query digest, unused-index and bloat detection, long-transaction alerts, and trend comparison across snapshots.

**Block 25 of 25**, numbered in build order.

> **Status: implemented.** Slow-query, unused-index, bloat, long-transaction, connection-pressure,
> and schema-drift checks are all wired, with pure unit tests over the drift diff and capacity
> assessment. Schema drift runs when `HEALTH_PARENT_DATABASE_URL` is set (a second connection to the
> parent branch); capacity is storage + connections only, since compute-hours need invocation data a
> SQL function cannot read. Still unverified against a live Neon project.

## Why this block

Cheap to build and it makes the platform feel like it is looking after you. Every one of these
questions is answerable from Postgres' own catalogs, but nobody remembers to ask until something
is already slow. The schema-drift check is the Neon-specific one: comparing a branch against its
parent catches the migration applied in dev and forgotten in production, which is a class of
outage that branching makes easier to create.

## Install

```bash
neon-blocks migrate db-health
neon function deploy db-health --src blocks/db-health/src
neon triggers create --function-slug db-health --name db-health-snapshot \
  --schedule '7 6 * * *' --function-path '/snapshot'
```

> Child branches inherit triggers **disabled**. Enable them after promoting, or scheduled work
> silently never runs.

## Design notes

- **Snapshots are stored, not just reported.** One reading of `pg_stat_statements` tells you what is slow now; a series tells you what got *slower*, which is the actionable version.
- **Unused-index findings carry the stats-reset age inline.** `idx_scan = 0` on a database restarted yesterday means nothing — the counters reset. Without that context the advice is actively harmful, so it is embedded in the finding text rather than left to a footnote.
- **Constraint-backing indexes are never suggested for dropping.** Dropping a unique or primary index would drop the constraint with it, so they are excluded from the query outright.
- **Advice is suggested, never applied.** `CREATE INDEX` or `VACUUM` on a large production table is a real operation with real cost, and a block that ran them automatically would eventually do so at the worst moment.
- **Long-transaction detection is the highest-value cheap check here.** One forgotten session holds back vacuum for the entire database, so bloat appears everywhere and the cause is not local to the table that looks bloated.

## API

| Route | Purpose |
|---|---|
| `POST /snapshot` | Cron. Take a snapshot and record findings. |
| `GET /findings` | Findings from the latest snapshot. |
| `GET /trends` | Statements whose mean time is rising. |
| `GET /health` | `200` / `503`. |

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `HEALTH_SLOW_QUERY_MS` | `100` | Mean execution time above which a statement is recorded. |
| `HEALTH_BLOAT_WARN_PCT` | `20` | Dead-tuple percentage that triggers a finding. |
| `HEALTH_MIN_TABLE_BYTES` | `10485760` | Ignore objects smaller than this. Percentages on tiny tables are noise, and reporting them buries the real findings. |
| `HEALTH_SNAPSHOT_RETENTION_DAYS` | `90` | How long snapshots are kept for trend comparison. |
| `NEON_BLOCKS_TRIGGER_SECRET` | `` | Shared secret authenticating trigger delivery. Neon does not sign trigger POSTs. |

Injected automatically by Neon: `DATABASE_URL`.

## Limits and honest caveats

- **`pg_stat_statements` may be unavailable.** It requires `shared_preload_libraries`, which is not settable per-database. The block detects its absence and reports it, rather than returning zero slow queries that read as a healthy database.
- **Schema-drift comparison is a TODO seam.** It needs a second connection to the parent branch, and credentials for that are not something a block can assume it has.
- **The capacity-hours cost monitor is a TODO seam** and can only ever be an estimate: it needs function invocation data this block cannot read.
- **Bloat is inferred from `n_dead_tup`, not measured.** That is the real counter rather than a statistical estimate, but it reflects tuples awaiting vacuum rather than physical file bloat. `pgstattuple` is exact and scans the table.
- **No alerting.** Findings are recorded and exposed; delivering them is block 13's job, and wiring the two together is left to the user.
- **Unverified against a live Neon project.** Nothing in this repo has been run against real Neon
  infrastructure yet.

## Observability

```sql
SELECT * FROM blocks_db_health.v_status;
```

## Uninstall

```bash
neon-blocks rollback db-health
```
