# Block 28 — Scheduled Cleanup Job

A cron-triggered Postgres maintenance job: expire trials, abandoned carts, stale sessions, or any
time-bounded record. Runs under an advisory lock with a run log, so overlapping runs are safe and
auditable.

**Block 28 of the catalog.**

> **Status: implemented.** The sweep, run log, advisory lock, and trigger authentication are wired
> for real over the block's own table, with pure, unit-tested validation. Unverified against a live
> Neon project.

## Why this block

Scheduled cleanup is the thing every app eventually needs and every app rebuilds: expire something
on a timer. Now that Neon ships UTC cron triggers, it is a natural flagship example, because the
timer lives outside the compute and fires correctly even when the function has scaled to zero.

The value is in doing it correctly, which this block shows: an advisory lock so two overlapping runs
never process the same rows, a bounded batch so one run cannot run away, and a run log so you can
answer "is the cron actually firing?". The block owns the table it expires, so it is self-contained;
point the `/run` query at your own table to adapt it.

## Install

```bash
neon-blocks migrate scheduled-cleanup
neon function deploy scheduled-cleanup --src blocks/scheduled-cleanup/src
neon triggers create --function-slug scheduled-cleanup --name scheduled-cleanup-run \
  --schedule '*/5 * * * *' --function-path '/run'
```

> Child branches inherit triggers **disabled**. Enable them after promoting, or the sweep silently
> never runs. `/health` reports overdue records precisely so this surprise is visible.

## Design notes

- **Advisory lock, not just a schedule.** Two runs can overlap if one exceeds the interval. The lock
  makes the second exit cleanly instead of double-processing.
- **Bounded batch.** `CLEANUP_BATCH_SIZE` caps rows per run so a large backlog is drained across
  runs rather than in one unbounded, expensive invocation. `FOR UPDATE SKIP LOCKED` keeps concurrent
  runs off each other's rows.
- **A run log, not silence.** Every run records what it scanned and expired, by kind. That is the
  audit trail and the liveness signal.
- **Authenticated trigger.** Trigger delivery is an unauthenticated POST, so `/run` requires the
  shared secret via `assertTriggerAuthentic` rather than trusting the invocation id.

## API

| Route | Purpose |
|---|---|
| `POST /run` | Cron. Expire due records under the lock, then log the run. |
| `GET /preview` | Dry run: how many records would expire now, by kind. |
| `POST /register` | Register a record: `{ "kind": "trial", "reference": "user_1", "ttlSeconds": 3600 }`. |
| `GET /health` | `200` / `503`, backed by `blocks_scheduled_cleanup.v_status`. |

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `CLEANUP_BATCH_SIZE` | `500` | Maximum records expired per run. The remainder waits for the next run. |
| `CLEANUP_DEFAULT_TTL_SECONDS` | `3600` | TTL applied by `/register` when no explicit expiry is given. |
| `NEON_BLOCKS_TRIGGER_SECRET` | `` | Shared secret authenticating the cron POST. |

Injected automatically by Neon: `DATABASE_URL`.

## Limits and honest caveats

- **Expires the block's own table.** To expire your rows, replace the single `UPDATE` in `/run`
  (marked in `src/index.ts`) with one against your table. The lock, batch bound, and run log stay.
- **Fan-out is a seam.** Publishing an event per expired record (so notifications #13 or
  webhooks-outbound #10 can react) is a marked TODO.
- **Unverified against a live Neon project.** Nothing in this repo has been run against real Neon
  infrastructure yet.

## Observability

```sql
SELECT * FROM blocks_scheduled_cleanup.v_status;
```

## Uninstall

```bash
neon-blocks rollback scheduled-cleanup
```
