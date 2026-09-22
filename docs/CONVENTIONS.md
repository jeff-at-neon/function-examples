# Block conventions

These rules are the actual product. A catalog of 25 functions that each invent their own
config, table naming, and migration story is worse than 8 that share one shape.

Every block in `blocks/` MUST obey all of the following. CI enforces the mechanical parts.

## 1. One namespaced schema per block

A block owns exactly one Postgres schema, named `blocks_<slug>` (underscores, not dashes).

- It **never** creates, alters, or drops objects outside its own schema.
- It **never** requires the user to modify their own tables. If a block wants to observe a
  user table, it attaches an outbox trigger (see §4) rather than adding columns.
- Cross-block references go through the shared contracts in `@neon-blocks/events` and
  `@neon-blocks/queue`, never by reaching into `blocks_other.*` directly.

Rationale: a user must be able to install 25 blocks into one database with zero name
collisions, and `DROP SCHEMA blocks_foo CASCADE` must be a complete uninstall.

## 2. Reversible, versioned migrations

Migrations live in `blocks/<slug>/migrations/NNN_name.sql` and are applied by
`@neon-blocks/migrate`, which records them in `blocks_core.migrations`.

- Numbered, append-only. Never edit a shipped migration; add a new one.
- Every migration has a matching `NNN_name.down.sql`. These run in real production
  databases; "just restore a backup" is not an uninstall story.
- Idempotent DDL (`IF NOT EXISTS`) so a partially-applied migration can be retried.
- No `DROP TABLE` in an upgrade path without an explicit, documented data migration.

## 3. Declared, validated config

Each block ships a `block.json` manifest declaring its slug, schema, env vars (required
and optional), triggers it needs, capabilities it depends on, and its billing posture.
Handlers read config through `loadConfig()` from `@neon-blocks/core`, which fails fast at
startup with a single actionable message listing every missing variable — not a
`TypeError: undefined` on the first request three days later.

## 4. One event contract: the outbox

Neon has **no row-event triggers today** (see [PLATFORM.md](./PLATFORM.md)), but has
pre-announced them. So blocks never subscribe to database changes directly. They consume
a logical event stream from `@neon-blocks/events`, backed today by an outbox table drained
by cron, and tomorrow by native row triggers — without any block's interface changing.

Producers either `publish()` explicitly from app code, or attach the provided DB-side
trigger function to their own tables. Consumers register a handler by event type. That
indirection is the single most important design decision in this repo: it is what stops a
platform change from becoming a 14-block rewrite.

## 5. Trigger for latency, cron for correctness

Storage triggers are Beta with no documented retry, ordering, or delivery guarantee, and
there are **no delete or update events**. Therefore every trigger-driven block also ships
a cron reconciliation sweeper that lists the source of truth and heals missed work.

This is not belt-and-braces paranoia; it is the only way to get correctness out of an
at-most-once-ish delivery channel. The sweeper also gives you deletion detection for free.

## 6. Handlers are idempotent, and prove it

- Storage handlers key on `(object_key, etag)`, never `object_key` alone — overwriting a
  key re-fires the trigger with new content, and keying on the object alone serves stale
  derivatives.
- Queue consumers key on an explicit `idempotency_key`.
- Webhook receivers key on the provider's event id.

## 7. Untrusted input at every trigger boundary

Trigger delivery is an **unauthenticated HTTP POST**. `X-Neon-Trigger-Invocation-Id` is
identification, not authentication — anyone who learns a function URL can forge an event
for any object key. So:

- Verify the object actually exists (HEAD) before acting on it.
- Treat `object_key` as hostile: reject traversal, enforce tenant prefix boundaries.
- Where a shared secret is available, require it via `assertTriggerAuthentic()`.

## 8. No write-amplification loops

A storage block that writes its output into the bucket it watches retriggers itself,
forever, burning capacity-hours. There is no suffix filter and no negative prefix filter
to save you, so the only safe shape is **separate output bucket, or a prefix the trigger
provably excludes** — and the scaffolding enforces it rather than documenting it.
`assertNoLoop()` throws at startup if input and output are the same bucket and the output
prefix is not provably disjoint from the watched prefix.

## 9. Provider adapters, not provider lock-in

AI defaults to Neon's AI Gateway (credentials auto-injected, zero config). Email is Resend
*or* SES. Every provider sits behind a small interface in the block's `providers/`
directory. A block that only works with one vendor's API key is not reusable.

## 10. Observability by default

Every block exposes:

- `blocks_<slug>.v_status` — a SQL view answering "is this healthy right now?"
- a `GET /health` route on its function, returning a machine-readable JSON summary.

No silent caps: if a block bounds its work (batch size, max retries, sampling), it logs
what it dropped. Silent truncation reads as "covered everything" when it didn't.

## 11. Cost-aware by construction

Billing distinguishes active from waiting Capacity-Hours at roughly 4:1, and functions run
at a **fixed size**. Blocks should be I/O-bound orchestrators where possible. CPU-heavy
work is allowed (4× is not fatal) but must be bounded by explicit guards — max bytes, max
pixels, max rows, timeout — because the endpoint is public and decompression bombs are a
real denial-of-service vector.

## 12. Bundler-safe dependencies

The default build is an esbuild single-file bundle that **cannot load native `.node`
binaries**. Any block needing native code must either use a WASM alternative (preferred —
preserves one-command install) or declare `"bundler": "none"` in its manifest and own a
prebuilt, platform-matched `node_modules`. A block that breaks `neon-blocks add` is not a
lego block.

## Layout

```
blocks/<slug>/
  block.json          manifest: env, triggers, capabilities, billing posture
  README.md           what it does, install, config, cost notes, limits
  migrations/         NNN_name.sql + NNN_name.down.sql
  src/
    index.ts          the function handler (HTTP entry)
    <logic>.ts        pure, unit-testable logic
    providers/        vendor adapters behind one interface
  test/               vitest; pure logic only, no DB required
```
