# Neon platform facts these blocks are built on

Verified against Neon's blog and API docs on **2026-09-22**. The ecosystem is ~6 weeks old
(Functions GA Aug 12, full backend GA Sep 17, triggers + custom domains Sep 21), so expect
undocumented edges. Where a fact is unverified, it is marked as such and **not** built on.

## Runtime

- **Node.js 24**, deployed per-branch, in the same region as Postgres.
- **Long-running** — sustained operations "lasting minutes", not Lambda-style short caps.
  Supports `upgradeWebSocket` and SSE (`text/event-stream`). This is why realtime fan-out
  is viable without Redis or a separate broker service.
- Always request/response shaped: "a function isn't a background job runner; it's always
  requested and always returns a web response."
- Use a long-lived `pg` **Pool** across requests. Do **not** use
  `@neondatabase/serverless` — that driver targets short-lived edge workloads.
- Credentials are **auto-injected** via `process.env`: `DATABASE_URL`, plus AI Gateway,
  Object Storage, and Auth credentials. No manual secret wiring.
- Child branches get isolated copies of functions, with their own URLs and `DATABASE_URL`.

## Invocation

HTTP, plus declarative **Function Triggers**. Two trigger types have shipped:

### `schedule`
Five-field **UTC** cron. Branch-scoped. The timer lives outside the compute, so it fires
correctly with scale-to-zero. Delivers `data.scheduled_at`.

> **Gotcha:** child branches inherit triggers **disabled**. Every scheduled block must
> document an "enable on promote" step, or users ship preview branches whose jobs silently
> never run.

### `storage_object_created` (Beta)
- Config: `bucket_name` (required, exactly one), `prefix` (optional, ≤1024 UTF-8 bytes,
  case-sensitive, no path normalization), `function_slug`, `function_path`, `enabled`.
- **No suffix or content-type filter.** Filter by file type in-function.
- Fires only after a successful upload. **No delete and no update events.**
- Payload per the API docs is exactly `{ type, data: { bucket_name, object_key } }`.
  Richer fields (size, content_type, etag) appear in some third-party write-ups but are
  **not** in the official docs — treat as unverified. Blocks therefore HEAD the object to
  learn its metadata.
- Delivery is an **unauthenticated HTTP POST**. `X-Neon-Trigger-Invocation-Id` is
  identification, **not** authentication.
- **No documented retry policy, delivery guarantee, or ordering guarantee.**

### Not yet: database and auth events
The Functions GA post described the planned trigger surface as covering "cron schedules,
storage events, and **database/auth events**" — so the two shipped types are 2 of 4
intended. Today there is **no row-level change → function** trigger. Postgres DDL event
triggers work, but not row events; Neon's current guidance for row changes is logical
replication out to an external event system.

**Consequence for this repo:** reactive blocks are built on an outbox drained by cron, and
the event source is an abstraction (`@neon-blocks/events`). When native row triggers land,
the drain is swapped and no block's public interface changes. See
[ROW_EVENTS.md](./ROW_EVENTS.md).

## Billing

Functions run at a **fixed size** — no CPU/memory tier selection — so 1 hour of runtime is
1 Capacity-Hour. Billed from request start until the handler finishes, **including
`waitUntil` background work**.

| | Launch | Scale |
|---|---|---|
| Active Capacity-Hour (CPU in use) | $0.10 | $0.12 |
| Waiting Capacity-Hour (idle on I/O) | $0.025 | $0.03 |
| Per 1M invocations | $0.60 | $0.60 |

Free tier quota: 10 active CH, 400 waiting CH, 1M invocations per project per month.

> **Active is 4× waiting, not 40×.** The free tier's 10:400 split is a *quota* ratio, not a
> price ratio. This matters: it means CPU-bound work is far less penalized than that split
> implies. Image thumbnails pencil out around **$16–26 per million images** — roughly
> 1.3–2× Lambda and ~30× cheaper than Cloudinary/imgix. PDF parsing for RAG ingestion
> likewise does not need to be offloaded.

Design directives that follow: prefer I/O-bound orchestration, but don't contort a design
to avoid CPU. Do bound CPU work with explicit guards, since endpoints are public.

## Packaging

Default build is an **esbuild single-file bundle**, which **cannot load native `.node`
binaries**. `sharp` fails at invoke with "Could not load the 'sharp' module", and
`externalPackages` does not fix it — externalizing leaves the import in place without
making the package resolvable.

Escape hatch: `bundler: "none"` (or `neon function deploy --no-bundle`) ships a zip of a
prebuilt directory including `node_modules`, which must be installed for the runtime's
Linux platform/arch. **TypeScript cannot be shipped unbundled** — pre-compile first.

This is the main obstacle to uniform packaging, and the reason the image block defaults to
WASM libvips (2–4× slower, bundles cleanly, keeps one-command install) with native `sharp`
as an opt-in fast path.

## Sibling primitives these blocks pull in

- **Object Storage** — S3-compatible; branches with your data without duplicating storage
  cost. Unqueryable on its own, which is what makes the file registry block valuable.
- **Managed Better Auth** — users/sessions/orgs live in the `neon_auth` schema. Blocks
  should **build on** `neon_auth`, not mirror a foreign IdP into Neon — a Clerk/Auth0 sync
  block would be building the off-ramp.
- **AI Gateway** — Databricks Foundation Model APIs, branch-scoped credentials
  auto-injected, prepaid credits. Default to it; keep adapters as the escape hatch.
- **Data API** — PostgREST-compatible HTTP.
- **Branching** — the basis of the PII anonymizer, preview environments, and CI tests.
