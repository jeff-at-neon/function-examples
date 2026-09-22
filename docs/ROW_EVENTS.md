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

**The foundations barely move.** The queue does not become redundant — row events *feed* a
queue, they don't replace one; you still need retries, backoff, DLQ, idempotency,
concurrency caps, and ordering. What changes is the drain's internals (drain-on-event instead
of poll-on-cron, so latency goes ~60s → ~1s) and it gains a new job: absorbing a firehose.
RAG is already storage-triggered. Realtime *strengthens* — fan-out becomes automatic rather
than requiring the app to remember to `NOTIFY`.

**Blocks that get materially better:**

| Block | Why |
|---|---|
| `embedding-freshness` | The one block row events genuinely rescue. Watermark polling becomes true change-driven re-embedding, and stale vectors are pgvector's most common failure mode. |
| `compliance` | Captures writes from *any* client including `psql`, with no app cooperation. That's what auditors actually ask about. |
| `notifications` | "Email when order status changes" stops needing app-side wiring. |
| `webhooks-outbound` | Genuinely declarative: "when `orders` changes, deliver to subscribers." |
| `analytics` | Streaming aggregation instead of batch windows. |

**New blocks that only then become possible:** denormalization/materialized-view maintainer;
cache invalidator; data-quality sentinel; CDC to a warehouse or search index; a workflow
state-machine engine (Postgres as a durable orchestrator, on the strength of your state
already living in the database); auth event handlers for signup, trial provisioning, and org
seeding.

Net effect is concentrated in the middle of the catalog rather than the foundations, which is
why the build order holds either way.

## The firehose caution

Row events on a busy table are a firehose. Whatever ships will need per-table filters,
column-level filters, debouncing, and batching. If Neon's v1 lacks those, the queue block
absorbing that load is the difference between "row events are great" and "row events blew
up my capacity-hours bill." Another argument for building the queue first and building it
well — which is why `blocks_queue` ships with concurrency caps and per-type rate limits
from day one, before anything needs them.
