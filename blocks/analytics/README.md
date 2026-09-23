# Block 24 — Event Analytics

Event ingest, sessionization, and a funnel, retention, and cohort query pack over your own Postgres.

**Block 24 of 25**, numbered in build order.

> **Status: implemented.** Schema, safety checks, control flow, and the core logic (ordered-step
> funnel and cohort retention) are all wired, with pure unit tests. Still unverified against a live
> Neon project.

## Why this block

Product analytics where events live next to the rest of your data, so a funnel can join against
your actual customer table rather than whatever you remembered to send to a third party. The
hard parts are sessionization -- a gap-based window function, not a timestamp bucket -- and
keeping the queries fast enough to run interactively on real volume.

## Install

```bash
neon-blocks migrate analytics
neon function deploy analytics --src blocks/analytics/src
neon triggers create --function-slug analytics --name analytics-rollup \
  --schedule '13 1 * * *' --function-path '/rollup'
```

> Child branches inherit triggers **disabled**. Enable them after promoting, or scheduled work
> silently never runs.

## Design notes

- **Sessionization is a 30-minute inactivity gap computed with a window function.** Not a fixed clock window: a user active 10:55–11:05 is one session, and calendar-hour bucketing would split them in two and halve your session count.
- **Events are append-only and never updated.** A table that permits updates cannot be trusted retrospectively, and every rollup derived from it becomes unreproducible.
- **Ingest is bulk-friendly and idempotent.** Clients batch and retry, so a dedupe key is mandatory — without one a retried batch silently doubles every metric it contains.
- **Funnels are ordered-step queries, not a count of users who did all the steps.** Someone who checked out before adding to cart has not converted through the funnel, and ignoring order inflates conversion rates.
- **Retention is cohort-by-period anchored to first-seen.** A single retention number hides whether the product is improving; cohorts are what make a change visible.

## API

| Route | Purpose |
|---|---|
| `POST /track` | Ingest a batch of events, idempotently. |
| `POST /rollup` | Cron. Sessionize and aggregate. |
| `GET /funnel` | Ordered-step funnel conversion. |
| `GET /retention` | Cohort retention by week. |
| `GET /health` | `200` / `503`. |

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `ANALYTICS_SESSION_GAP_MINUTES` | `30` | Inactivity gap that ends a session. 30 is conventional; changing it changes every historical session count. |
| `ANALYTICS_MAX_BATCH` | `1000` | Events accepted per ingest request. |
| `ANALYTICS_RETENTION_DAYS` | `400` | Days raw events are kept. Rollups outlive them, so long-range trends survive the purge. |
| `NEON_BLOCKS_TRIGGER_SECRET` | `` | Shared secret authenticating trigger delivery. Neon does not sign trigger POSTs. |

Injected automatically by Neon: `DATABASE_URL`.

## Limits and honest caveats

- **The funnel, retention, and cohort queries are TODO seams.** Schema, sessionization SQL, and ingest are real; the analysis pack is specified in comments but not written.
- **No partitioning or column store.** On tens of millions of events these queries get slow. Monthly partitioning of `events` is the first thing to add, and it is a migration rather than a tweak.
- **Property filtering is JSONB containment.** Flexible, but a GIN index on `properties` grows large, and hot properties are better promoted to real columns.
- **No identity stitching.** Anonymous events before signup are not merged into the user afterwards, so first-touch attribution is wrong for every user. A genuine gap, not a simplification.
- **Timezones are UTC throughout**, so daily rollups will not match a customer expecting their local business day.
- **Unverified against a live Neon project.** Nothing in this repo has been run against real Neon
  infrastructure yet.

## Observability

```sql
SELECT * FROM blocks_analytics.v_status;
```

## Uninstall

```bash
neon-blocks rollback analytics
```
