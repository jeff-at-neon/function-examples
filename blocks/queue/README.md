# Block 1 — Background jobs

Queue work and run it reliably with retries, backoff, and a dead-letter queue

**Rank #1 of 25.** Twelve other blocks depend on this one's contract, and it is the reference
implementation for every rule in [docs/CONVENTIONS.md](../../docs/CONVENTIONS.md).

## Why this is first

It is the substrate — but more importantly, it is where the platform's biggest gap gets solved
**once**, behind an interface that survives the gap being closed.

Neon has **not** shipped database row-event triggers. Only `schedule` and
`storage_object_created` exist; row and auth events were pre-announced but are not available.
So there is no way to react to a row change directly. This block provides the answer everything
else builds on:

```
your app / a DB trigger  →  blocks_core.outbox_events  →  cron drain  →  blocks_queue.jobs  →  handler
```

Consumers subscribe to a `BlockEvent` stream, never to a platform payload. When native row
triggers ship, the drain is replaced and **no block's public interface changes** — latency goes
from ~60s to ~1s and that's the whole diff. See [docs/ROW_EVENTS.md](../../docs/ROW_EVENTS.md).

## Install

```bash
neon-blocks migrate queue
neon function deploy queue --src blocks/queue/src

neon triggers create --function-slug queue --name queue-work \
  --schedule '* * * * *' --function-path '/work'
neon triggers create --function-slug queue --name queue-sweep \
  --schedule '17 3 * * *' --function-path '/sweep'
```

> **Child branches inherit triggers DISABLED.** After promoting a branch, run
> `neon triggers list` and enable them, or background work silently never runs. `/health`
> reports this as a stale `oldest_due_seconds`, which is the fastest way to notice.

Cron is **five-field UTC**. `17 3 * * *` rather than `0 3 * * *` deliberately — off-the-hour
scheduling avoids the thundering herd of every project on the platform sweeping at once.

## Producing events

Explicitly, from app code:

```ts
import { publish } from "@neon-blocks/events";

await publish(pool, {
  type: "order.status_changed",
  subject: orderId,
  payload: { from: "pending", to: "shipped" },
  idempotencyKey: `order:${orderId}:shipped`,  // makes a retried request a no-op
});
```

Or declaratively, by attaching the shipped trigger to your own table:

```sql
SELECT blocks_core.attach_outbox_trigger('public', 'orders', 'order.changed');
```

That trigger includes both `old` and `new` on updates, so a consumer can diff and skip no-op
writes — which is how the embedding-freshness block avoids re-embedding when an unrelated column
changed. It is also the function that gets **retired** when Neon ships row events.

## Consuming

```ts
import { queueWorker, eventConsumer } from "@neon-blocks/block-queue";

eventConsumer.on("order.*", "notify_on_order_change", async (event) => {
  await enqueue(pool, { type: "notifications.send", payload: event.payload });
});

queueWorker.register("notifications.send", async (payload, ctx) => {
  if (ctx.signal.aborted) return;   // lease is about to expire; checkpoint instead of dying
  await sendEmail(payload);
});
```

Handlers must be **idempotent** — delivery is at-least-once. Throw `PermanentJobError` to skip
retries and dead-letter immediately; retrying a malformed payload forever is how a poison
message burns a month of capacity-hours.

## HTTP API

| Route | Purpose |
|---|---|
| `POST /work` | Cron. Drains outbox, then runs due jobs. |
| `POST /sweep` | Cron. Reclaims expired leases, purges, reports DLQ depth. |
| `POST /enqueue` | `{type, payload, idempotencyKey?, priority?, runAt?}` → `201`, or `200` when deduplicated. |
| `POST /publish` | `{type, subject, payload, idempotencyKey?}` → `201`. |
| `POST /replay` | `{type?, limit?}` — move dead jobs back to pending after a fix. |
| `GET /health` | `200` healthy, `503` degraded. |

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `QUEUE_BATCH_SIZE` | `25` | Jobs per invocation. |
| `QUEUE_LEASE_SECONDS` | `300` | Must exceed your slowest handler, or jobs get stolen mid-run. |
| `QUEUE_BUDGET_MS` | `45000` | Stop claiming after this long. Bounds per-invocation cost. |
| `QUEUE_OUTBOX_BATCH_SIZE` | `100` | Events drained per invocation. |
| `QUEUE_RETENTION_DAYS` | `7` | Succeeded jobs and delivered events purged after this. |
| `QUEUE_CONCURRENCY` | `{}` | Per-type caps, e.g. `{"rag.embed":4}`. |
| `NEON_BLOCKS_TRIGGER_SECRET` | — | Strongly recommended; see below. |

## Security

Trigger delivery is an **unauthenticated HTTP POST**. `X-Neon-Trigger-Invocation-Id` is
identification, *not* authentication — anyone who learns the function URL can invoke `/work`.
For this block the blast radius is limited (it only does work you already queued), but set
`NEON_BLOCKS_TRIGGER_SECRET` and append `?secret=…` to the trigger path anyway. Blocks that
mutate external state require it.

## Cost

Both cron routes are I/O-bound — they wait on Postgres. At the Launch rate of $0.025 per waiting
Capacity-Hour, a per-minute `/work` trigger doing ~2s of work costs roughly **$0.02/month** in
compute plus ~$0.03/month in invocations. Raise `QUEUE_BATCH_SIZE` before shortening the cron
interval: invocations are billed per million, so fewer, fuller runs are cheaper than more,
emptier ones.

The 4:1 active-to-waiting ratio means handler CPU time is the variable that matters, not the
polling itself.

## Observability

```sql
SELECT * FROM blocks_queue.v_status;        -- health summary
SELECT * FROM blocks_queue.v_job_stats;     -- per-type counts
SELECT * FROM blocks_queue.v_dead_letters;  -- failures awaiting replay
```

`oldest_due_seconds` is the number to alert on. If it climbs past a few minutes on a per-minute
cron, the trigger isn't firing — nine times out of ten because this is a promoted child branch
with inherited-disabled triggers.

## Limits and honest caveats

- **Cron floor is one minute.** Sub-second reactivity is not achievable with cron-driven drain;
  that needs native row events. For user-facing latency now, publish *and* call `/work` directly.
- **No cross-job ordering.** Jobs are priority-then-age; strict per-subject ordering is not
  implemented. Encode ordering in your payload or chain jobs explicitly.
- **At-least-once, not exactly-once.** Deliberate. Exactly-once across a network boundary isn't
  achievable; idempotent handlers are the real answer.
- **Nothing here has been run against a live Neon project yet.** Unit tests cover config
  parsing and pure logic; the SQL is written against documented Postgres behaviour but is
  unverified end-to-end.

## Uninstall

```bash
neon-blocks rollback queue
```

Drops `blocks_queue` entirely and this migration's objects in `blocks_core`. Triggers you
attached to your own tables are dropped with `CASCADE` — leaving orphaned triggers that error on
every write would be worse than removing them.
