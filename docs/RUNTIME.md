# Neon platform facts these blocks are built on

Verified against Neon's blog and API docs on **2026-09-22**. The ecosystem is new (Functions GA
Aug 12, full backend GA Sep 17, triggers + custom domains Sep 21), so expect undocumented edges.
Where a fact is unverified it is marked as such and **not** relied on.

This file exists because several conventions only make sense once you know the constraint that
produced them. Each section below is referenced from [CONVENTIONS.md](./CONVENTIONS.md).

## Runtime

- **Node.js 24**, deployed per-branch, in the same region as Postgres.
- **Long-running** — sustained operations "lasting minutes", not Lambda-style short caps. Supports
  `upgradeWebSocket` and SSE (`text/event-stream`). This is why realtime fan-out is viable without
  a separate broker service.
- Always request/response shaped: "a function isn't a background job runner; it's always requested
  and always returns a web response."
- Use a long-lived `pg` **Pool** across requests. Do **not** use `@neondatabase/serverless` — that
  driver targets short-lived edge workloads.
- Credentials are **auto-injected** via `process.env`: `DATABASE_URL`, plus AI Gateway, Object
  Storage, and Auth credentials. No manual secret wiring.
- Child branches get isolated copies of functions, with their own URLs and `DATABASE_URL`.

## Invocation

HTTP, plus declarative **Function Triggers**. Two trigger types have shipped.

### `schedule`

Five-field **UTC** cron. Branch-scoped. The timer lives outside the compute, so it fires correctly
with scale-to-zero. Delivers `data.scheduled_at`.

> **Gotcha:** child branches inherit triggers **disabled**. Every scheduled block must document an
> "enable on promote" step, or users ship preview branches whose jobs silently never run. This is
> the single most common install-time surprise, which is why several blocks' `/health` routes report
> it explicitly.

### `storage_object_created` (Beta)

- Config: `bucket_name` (required, exactly one), `prefix` (optional, ≤1024 UTF-8 bytes,
  case-sensitive, no path normalization), `function_slug`, `function_path`, `enabled`.
- **No suffix or content-type filter.** Filter by file type in-function — this is why the
  ingest-router block exists.
- Fires only after a successful upload. **No delete and no update events.**
- Payload per the API docs is exactly `{ type, data: { bucket_name, object_key } }`. Richer fields
  (size, content_type, etag) appear in some third-party write-ups but are **not** in the official
  docs — treated as unverified, so blocks HEAD the object to learn its metadata.
- Delivery is an **unauthenticated HTTP POST**. `X-Neon-Trigger-Invocation-Id` is identification,
  **not** authentication.
- **No documented retry policy, delivery guarantee, or ordering guarantee.**

Together these produce two conventions: handlers treat object keys as untrusted and HEAD-verify
before acting (§7), and every trigger-driven block ships a cron reconciler because at-most-once-ish
delivery cannot be relied on alone (§5).

### Not yet: database and auth events

The Functions GA post described the planned trigger surface as covering "cron schedules, storage
events, and **database/auth events**" — so the two shipped types are 2 of 4 intended. Today there is
**no row-level change → function** trigger. Postgres DDL event triggers work, but not row events;
current guidance for row changes is logical replication out to an external event system.

**Consequence:** reactive blocks are built on an outbox drained by cron, and the event source is an
abstraction (`@neon-blocks/events`). When native row triggers land, the drain is swapped and no
block's public interface changes. See [ROW_EVENTS.md](./ROW_EVENTS.md).

## Cost model

Functions run at a **fixed size** — no CPU/memory tier selection — so 1 hour of runtime is 1
Capacity-Hour. Billed from request start until the handler finishes, **including `waitUntil`
background work**.

| | Launch | Scale |
|---|---|---|
| Active Capacity-Hour (CPU in use) | $0.10 | $0.12 |
| Waiting Capacity-Hour (idle on I/O) | $0.025 | $0.03 |
| Per 1M invocations | $0.60 | $0.60 |

Free tier quota: 10 active CH, 400 waiting CH, 1M invocations per project per month.

> **Active is 4× waiting, not 40×.** The free tier's 10:400 split is a *quota* ratio, not a price
> ratio, and conflating the two is an easy mistake to make. It matters because it means CPU-bound
> work is far less penalized than that split implies: image thumbnails pencil out around **$16–26
> per million images**, and PDF parsing for RAG ingestion does not need offloading.

Design directives that follow: prefer I/O-bound orchestration where the work allows, but don't
contort a design to avoid CPU. Do bound CPU work with explicit guards, since endpoints are public
and decompression bombs are a real denial-of-service vector (§11).

## Packaging

The default build is an **esbuild single-file bundle**, which **cannot load native `.node`
binaries**. `sharp` fails at invoke with "Could not load the 'sharp' module", and `externalPackages`
does not fix it — externalizing leaves the import in place without making the package resolvable.

Escape hatch: `bundler: "none"` (or `neon function deploy --no-bundle`) ships a zip of a prebuilt
directory including `node_modules`, which must be installed for the runtime's Linux platform/arch.
**TypeScript cannot be shipped unbundled** — pre-compile first.

This is why the image block defaults to WASM libvips (2–4× slower, bundles cleanly, keeps
one-command install) with native `sharp` as an opt-in fast path, and why the repo hand-rolls SigV4
rather than depending on the AWS SDK (§12).

## Sibling primitives these blocks use

- **Object Storage** — S3-compatible; branches with your data without duplicating storage cost.
  Unqueryable on its own, which is what makes the file registry block useful.
- **Managed Better Auth** — users/sessions/orgs live in the `neon_auth` schema. Blocks build *on*
  `neon_auth` rather than mirroring an external identity provider into Neon.
- **AI Gateway** — Databricks Foundation Model APIs, branch-scoped credentials auto-injected.
  Default target, with provider adapters as the escape hatch.
- **Data API** — PostgREST-compatible HTTP.
- **Branching** — the basis of the PII anonymizer, preview environments, and CI tests.
