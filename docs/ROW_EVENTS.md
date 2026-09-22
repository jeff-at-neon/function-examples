# Row events: the migration this repo is designed to absorb

Neon pre-announced database/auth event triggers. They have not shipped. This document
records how the repo is positioned so their arrival is a performance upgrade rather than a
rewrite.

## The abstraction

Blocks never touch a trigger payload for row changes. They call:

```ts
import { publish, consume } from "@neon-blocks/events";
```

`@neon-blocks/events` defines a stable `BlockEvent` envelope and two swappable transports:

| Transport | Status | Mechanism | Latency |
|---|---|---|---|
| `outbox` | **active today** | `blocks_core.outbox_events` + cron drain | ~cron interval (60s floor) |
| `native_row_trigger` | stub, unreachable | Neon row-event trigger → HTTP POST | ~1s |

`resolveTransport()` picks based on `NEON_BLOCKS_EVENT_TRANSPORT`, defaulting to `outbox`.
The `native` transport intentionally throws a clear "not yet available on this platform"
error rather than pretending to work.

## What producers do today

Either explicitly from app code:

```ts
await publish(pool, { type: "order.status_changed", subject: orderId, payload: {...} });
```

Or declaratively, by attaching the shipped DB-side trigger to their own table — the closest
available approximation of a native row event, with the same at-least-once semantics:

```sql
SELECT blocks_core.attach_outbox_trigger('public', 'orders', 'order.changed');
```

That function is what gets **retired** when native triggers land. Consumers do not change.

## What changes when row events ship

Ranked by impact, from the analysis that produced the catalog ordering:

**The top 3 barely move.** The queue stays #1 — row events *feed* a queue, they don't
replace one; you still need retries, backoff, DLQ, idempotency, concurrency caps, and
ordering. What changes is the drain's internals (drain-on-event instead of poll-on-cron, so
latency goes ~60s → ~1s) and it gains a new job: absorbing a firehose. RAG is already
storage-triggered. Realtime *strengthens* — fan-out becomes automatic rather than requiring
the app to remember to `NOTIFY`.

**Biggest promotions:**

| Block | Now | Would be | Why |
|---|---|---|---|
| Embedding freshness | 14 | ~6 | The one block row events genuinely rescue. Watermark polling becomes true change-driven re-embedding. Stale vectors are pgvector's #1 failure mode. |
| Compliance / audit log | 17 | ~11 | Captures writes from *any* client including `psql`, with no app cooperation. That's what auditors actually ask about. |
| Notification engine | 13 | ~9 | "Email when order status changes" stops needing app-side wiring. |
| Outbound webhooks | 10 | ~8 | Genuinely declarative: "when `orders` changes, deliver to subscribers." |
| Analytics | 24 | ~18 | Streaming aggregation instead of batch windows. |

**New blocks that only then become possible:** denormalization/materialized-view
maintainer; cache invalidator; data-quality sentinel; CDC to warehouse/search; workflow
state-machine engine (the big one — Postgres as durable orchestrator, competing with
Inngest/Temporal on "your state is already in the DB"); auth event handlers (welcome email,
trial provisioning, org seeding — the honest replacement for the Clerk-sync block that was
deliberately cut).

Net: ~6 existing blocks get better, 5 get promoted, 6 become possible — concentrated in the
8–20 band, not the top. Which is why the build order below is correct either way.

## The firehose caution

Row events on a busy table are a firehose. Whatever ships will need per-table filters,
column-level filters, debouncing, and batching. If Neon's v1 lacks those, the queue block
absorbing that load is the difference between "row events are great" and "row events blew
up my capacity-hours bill." Another argument for building the queue first and building it
well — which is why `blocks_queue` ships with concurrency caps and per-type rate limits
from day one, before anything needs them.
