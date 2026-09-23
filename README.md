# Neon Blocks

Reusable [Neon Functions](https://neon.com/docs/functions) you drop into your project as
lego blocks. Each one is a small, well-tested backend capability that runs next to your
Postgres data, owns its own schema, and composes with the others.

```bash
npx neon-blocks add queue
npx neon-blocks add rag
```

> **Status: all 24 blocks implemented, with 423 unit tests.** Every block has real schemas, safety
> checks, migrations, and implemented logic. Migrations have been applied, rolled back, re-applied,
> and every `v_status` view queried against a live Neon branch. The handler logic that calls
> external services (AI Gateway, Object Storage, an image codec) is unit-tested at its pure seams;
> those live round-trips are not yet exercised end to end.

## Why

Neon shipped Functions, Object Storage, Managed Auth, AI Gateway, and a Data API — but every
app still rebuilds the same dozen things on top of them: a job queue, webhook verification,
a file index, RAG ingestion, billing sync. Each of those is a week of fiddly work that has
nothing to do with the product being built.

A block is that week, already done, in your own database.

## Design in one page

- **One schema per block** — `blocks_<slug>`. Never touches your tables. `DROP SCHEMA ... CASCADE` is a complete uninstall.
- **Reversible migrations** — every `NNN_x.sql` has an `NNN_x.down.sql`. These run in production.
- **One event contract** — blocks consume a logical event stream, not a platform trigger
  payload. Today it's an outbox drained by cron; when Neon ships row-event triggers it
  becomes a transport swap with no block interface change. This is the most important
  decision in the repo — see [docs/ROW_EVENTS.md](docs/ROW_EVENTS.md).
- **Trigger for latency, cron for correctness** — storage triggers are Beta with no delivery
  guarantee and no delete events, so every trigger-driven block ships a reconciliation sweeper.
- **Untrusted triggers** — delivery is an unauthenticated POST; `X-Neon-Trigger-Invocation-Id`
  is identification, not auth. Handlers HEAD-verify and treat keys as hostile.
- **No write-amplification loops** — enforced at startup, not documented in a footnote.
- **Provider adapters** — AI Gateway by default, adapters as the escape hatch.
- **Observability by default** — every block ships `v_status` and `GET /health`.

Full rules: [docs/CONVENTIONS.md](docs/CONVENTIONS.md). The platform facts and cost model those
rules derive from: [docs/RUNTIME.md](docs/RUNTIME.md).

## Block status

Numbered in build order — foundations first, then the blocks that depend on them. Depth reflects
how far each has been taken, not final intent.

| # | Block | Depth | Pulls in | $ |
|---|---|---|---|---|
| 1 | [queue](blocks/queue) | implemented | — | free |
| 2 | [rag](blocks/rag) | implemented | pgvector, Object Storage, AI Gateway | free |
| 3 | [realtime](blocks/realtime) | implemented | Data API | free |
| 4 | [file-registry](blocks/file-registry) | implemented | Object Storage | free |
| 5 | [ingest-router](blocks/ingest-router) | implemented | Object Storage | free |
| 6 | [webhooks-inbound](blocks/webhooks-inbound) | implemented | Custom domains | free |
| 7 | [hybrid-search](blocks/hybrid-search) | implemented | pgvector, AI Gateway | free |
| 8 | [billing](blocks/billing) | implemented | Auth | meter |
| 9 | [vision](blocks/vision) | implemented | Object Storage, AI Gateway | meter |
| 10 | [webhooks-outbound](blocks/webhooks-outbound) | implemented | Custom domains | meter |
| 11 | [csv-import](blocks/csv-import) | implemented | Object Storage | free |
| 12 | [api-edge](blocks/api-edge) | implemented | Auth | free |
| 13 | [notifications](blocks/notifications) | implemented | Auth | free |
| 14 | [embedding-freshness](blocks/embedding-freshness) | implemented | pgvector, AI Gateway | free |
| 15 | [pii-anonymizer](blocks/pii-anonymizer) | implemented | Object Storage, Branching | meter |
| 16 | [doc-extraction](blocks/doc-extraction) | implemented | Object Storage, AI Gateway | meter |
| 17 | [compliance](blocks/compliance) | implemented | — | meter |
| 18 | [moderation](blocks/moderation) | implemented | Object Storage, AI Gateway | meter |
| 20 | [semantic-cache](blocks/semantic-cache) | implemented | pgvector, AI Gateway | free |
| 21 | [agent-memory](blocks/agent-memory) | implemented | pgvector, AI Gateway | free |
| 22 | [feature-flags](blocks/feature-flags) | implemented | — | free |
| 23 | [image-derivatives](blocks/image-derivatives) | implemented | Object Storage | meter |
| 24 | [analytics](blocks/analytics) | implemented | — | free |
| 25 | [db-health](blocks/db-health) | implemented | Branching | free |

"implemented" means the core logic is written and unit tested. Blocks whose logic calls an
external service (AI Gateway, Object Storage, an image codec, a parent-branch connection) keep
that one call as a thin adapter; the surrounding logic is pure and tested.

## The composite demo

One upload lights up six primitives:

```
upload → file-registry  (Object Storage + SQL index)
       → ingest-router  (one trigger, dispatch by type)
         ├→ image-derivatives  (thumbnails, EXIF strip)
         ├→ rag                (extract → chunk → embed → pgvector)
         ├→ vision             (tags, caption, alt text)
         └→ moderation         (quarantine)
       → hybrid-search  (BM25 + vector + RRF)
       → realtime       ("processing complete" over SSE/WS)
```

## Repo layout

```
packages/     shared runtime — core, events, queue, storage, ai, migrate, cli
blocks/       the 24 blocks, each self-contained
docs/         conventions, verified platform facts, row-event migration plan
scripts/      doctor (env preflight), scaffold generator, CI migration verifier
```

All blocks are now hand-written and implemented. Earlier in the repo's life blocks 11–25 were
**generated** from specs in `scripts/specs-*.mjs` (via `node scripts/scaffold.mjs`) to keep the
conventions uniform; as each was implemented it was promoted out of the generator, so the spec
arrays are now empty and the generator is dormant. `node packages/cli/bin/neon-blocks.mjs verify`
enforces the conventions across every block regardless.

## Local development

```bash
npm install
npm run typecheck                                  # all 7 packages + 24 blocks, in dependency order
npm test                                           # 240 unit tests, no database required
node packages/cli/bin/neon-blocks.mjs verify       # enforce docs/CONVENTIONS.md
node packages/cli/bin/neon-blocks.mjs list         # the catalog
```

Unit tests are deliberately pure, so `npm test` works offline and fast.

## Testing against a real Neon database

The SQL has never been executed, so this is the highest-value thing to run. Only `DATABASE_URL` is
needed to exercise all 24 blocks' migrations.

```bash
cp .env.example .env         # then fill in DATABASE_URL
node scripts/doctor.mjs      # validates config and connectivity
```

`doctor.mjs` is written so its **output is safe to paste anywhere** — every credential is reduced to
a shape assertion (`set, 40 chars, prefix "sk_"`) and no value is ever printed, not even the
database password or username. If you need help diagnosing a connection, paste the doctor output
rather than your config.

It also refuses two configurations that would cost you real money or data:

- **a pooled connection string** — migrations use advisory locks and session state, which
  transaction-mode pooling does not preserve. Use the direct string.
- **a database or host whose name contains `prod`/`main`** — `verify-rollback` drops every block
  schema by design. Use a throwaway branch:

```bash
neon branches create --name blocks-test
neon connection-string blocks-test
```

Then run the verification:

```bash
node scripts/ci-migrate.mjs apply             # apply all 24 blocks in dependency order
node scripts/ci-migrate.mjs verify-rollback   # prove every migration reverses
node scripts/ci-migrate.mjs check-views       # query every v_status
```

Each additional credential unlocks more: **AI Gateway** enables RAG, hybrid search, vision, and
embedding freshness; **Object Storage** enables the whole storage family; **`NEON_API_KEY`** enables
function deployment and live trigger delivery. `doctor.mjs` reports which tier you've reached.

`verify-rollback` is the one that matters: it applies every migration, rolls them all back, then
**re-applies them**. A down migration can succeed and still leave residue that makes the up
migration fail the second time, and only the round trip catches that. It's also how the
"every migration is reversible" claim in the conventions becomes an assertion rather than a promise.

## License

Apache-2.0
