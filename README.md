# Neon Blocks

Reusable [Neon Functions](https://neon.com/docs/functions) you drop into your project as
lego blocks. Each one is a small, well-tested backend capability that runs next to your
Postgres data, owns its own schema, and composes with the others.

```bash
npx neon-blocks add queue
npx neon-blocks add rag
```

> **Status: unverified against a live Neon project.** All 25 blocks have real schemas, safety
> checks, and migrations; blocks 1–10 have implemented logic with 240 unit tests. But nothing here
> has been deployed to Neon, and the SQL has not been executed — CI is written to do exactly that
> (apply every migration, roll it back, re-apply it, query every view) and has not yet run.
> Treat the schemas as reviewed, not proven.

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
| 11 | [csv-import](blocks/csv-import) | scaffold | Object Storage | free |
| 12 | [api-edge](blocks/api-edge) | scaffold | Auth | free |
| 13 | [notifications](blocks/notifications) | scaffold | Auth | free |
| 14 | [embedding-freshness](blocks/embedding-freshness) | scaffold | pgvector, AI Gateway | free |
| 15 | [pii-anonymizer](blocks/pii-anonymizer) | scaffold | Object Storage, Branching | meter |
| 16 | [doc-extraction](blocks/doc-extraction) | scaffold | Object Storage, AI Gateway | meter |
| 17 | [compliance](blocks/compliance) | scaffold | — | meter |
| 18 | [moderation](blocks/moderation) | scaffold | Object Storage, AI Gateway | meter |
| 19 | [transcription](blocks/transcription) | scaffold | Object Storage, AI Gateway | meter |
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
packages/     shared runtime — core, events, queue, storage, ai, migrate, cli
blocks/       the 25 blocks, each self-contained
docs/         conventions, platform facts, catalog ranking, row-event migration plan
scripts/      scaffold generator for blocks 11–25, and the CI migration verifier
```

Blocks 11–25 are **generated** from specs in `scripts/specs-*.mjs`. Edit the spec and re-run
`node scripts/scaffold.mjs` — editing a generated file directly gets discarded on the next
regeneration, and CI fails if the two have diverged. That's what keeps the conventions uniform
across fifteen blocks instead of fifteen slightly different interpretations.

## Local development

```bash
npm install
npm run typecheck                                  # all 7 packages + 25 blocks, in dependency order
npm test                                           # 240 unit tests, no database required
node packages/cli/bin/neon-blocks.mjs verify       # enforce docs/CONVENTIONS.md
node packages/cli/bin/neon-blocks.mjs list         # the catalog
```

Unit tests are deliberately pure, so `npm test` works offline and fast. The database-backed
verification lives in CI:

```bash
DATABASE_URL=postgres://... node scripts/ci-migrate.mjs apply
DATABASE_URL=postgres://... node scripts/ci-migrate.mjs verify-rollback
DATABASE_URL=postgres://... node scripts/ci-migrate.mjs check-views
```

`verify-rollback` is the one that matters: it applies every migration, rolls them all back, then
**re-applies them**. A down migration can succeed and still leave residue that makes the up
migration fail the second time, and only the round trip catches that. It's also how the
"every migration is reversible" claim in the conventions becomes an assertion rather than a promise.

## License

Apache-2.0
