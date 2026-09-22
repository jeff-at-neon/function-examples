# Neon Blocks

Reusable [Neon Functions](https://neon.com/docs/functions) you drop into your project as
lego blocks. Each one is a small, well-tested backend capability that runs next to your
Postgres data, owns its own schema, and composes with the others.

```bash
npx neon-blocks add queue
npx neon-blocks add rag
```

> **Status: scaffolding.** The repo structure, shared runtime, conventions, and all 25 block
> skeletons are in place. Handler logic completeness varies by block — see
> [Block status](#block-status). Nothing here has been run against a live Neon project yet.

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

Full rules: [docs/CONVENTIONS.md](docs/CONVENTIONS.md). Platform facts and cost model they
derive from: [docs/PLATFORM.md](docs/PLATFORM.md).

## Block status

Ranked per [docs/CATALOG.md](docs/CATALOG.md). Depth reflects build order, not final intent.

| # | Block | Depth | Pulls in | $ |
|---|---|---|---|---|
| 1 | [queue](blocks/queue) | implemented | Functions, cron | free |
| 2 | [rag](blocks/rag) | implemented | Storage, pgvector, AI Gateway | free |
| 3 | [realtime](blocks/realtime) | implemented | Functions, Data API | free |
| 4 | [file-registry](blocks/file-registry) | implemented | Object Storage, RLS | free |
| 5 | [ingest-router](blocks/ingest-router) | implemented | Storage triggers | free |
| 6 | [webhooks-inbound](blocks/webhooks-inbound) | implemented | Custom domains | free |
| 7 | [hybrid-search](blocks/hybrid-search) | implemented | pgvector, FTS | free |
| 8 | [billing](blocks/billing) | implemented | Auth, queue | meter |
| 9 | [vision](blocks/vision) | implemented | AI Gateway, Storage | meter |
| 10 | [webhooks-outbound](blocks/webhooks-outbound) | implemented | queue | meter |
| 11 | [csv-import](blocks/csv-import) | scaffold | Storage | free |
| 12 | [api-edge](blocks/api-edge) | scaffold | Auth | free |
| 13 | [notifications](blocks/notifications) | scaffold | queue | free |
| 14 | [embedding-freshness](blocks/embedding-freshness) | scaffold | pgvector | free |
| 15 | [pii-anonymizer](blocks/pii-anonymizer) | scaffold | Branching, Storage | meter |
| 16 | [doc-extraction](blocks/doc-extraction) | scaffold | AI Gateway | meter |
| 17 | [compliance](blocks/compliance) | scaffold | — | meter |
| 18 | [moderation](blocks/moderation) | scaffold | AI Gateway, Storage | meter |
| 19 | [transcription](blocks/transcription) | scaffold | AI Gateway, Storage | meter |
| 20 | [semantic-cache](blocks/semantic-cache) | scaffold | pgvector, AI Gateway | free |
| 21 | [agent-memory](blocks/agent-memory) | scaffold | pgvector, AI Gateway | free |
| 22 | [feature-flags](blocks/feature-flags) | scaffold | — | free |
| 23 | [image-derivatives](blocks/image-derivatives) | scaffold | Object Storage | meter |
| 24 | [analytics](blocks/analytics) | scaffold | — | free |
| 25 | [db-health](blocks/db-health) | scaffold | Branching | free |

"scaffold" means manifest, migrations, README, and a handler with the real control flow and
explicitly marked `TODO` seams. "implemented" means the core logic is written and unit tested.

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
packages/     shared runtime — core, events, queue, storage, ai, migrate, testing, cli
blocks/       the 25 blocks, each self-contained
docs/         conventions, platform facts, catalog ranking, row-event migration plan
```

## Local development

```bash
npm install
npm run typecheck
npm test              # pure logic; no database required
```

Database-backed tests are opt-in — set `NEON_BLOCKS_TEST_DATABASE_URL` to a throwaway Neon
branch. CI creates one per run, which dogfoods branching and doubles as the test-harness
template users copy.

## License

Apache-2.0
