# Block 14 — Embedding Freshness Worker

Re-embeds rows whose source text changed, driven by a watermark or the outbox. Fixes pgvector's most common failure mode.

**Block 14 of 25**, numbered in build order.

> **Status: implemented.** Schema, safety checks, control flow, and the core logic (change
> detection with content hashing and a max-examined watermark) are all wired, with pure unit tests.
> Still unverified against a live Neon project.

## Why this block

Stale vectors are pgvector's number one failure mode: text is edited, the embedding is not regenerated, and search silently returns the old meaning. Nothing errors, so nobody notices until a user reports that search is 'wrong'. This is also the block that row-event triggers would most improve — see docs/ROW_EVENTS.md, where it moves from rank 14 to about 6.

## Install

```bash
neon-blocks migrate embedding-freshness
neon function deploy embedding-freshness --src blocks/embedding-freshness/src
neon triggers create --function-slug embedding-freshness --name embedding-freshness-scan \
  --schedule '*/5 * * * *' --function-path '/scan'
```

> Child branches inherit triggers **disabled**. Enable them after promoting, or scheduled work
> silently never runs.

## Design notes

- **Two drive modes, one interface.** Watermark polling (compare `updated_at` against a stored high-water mark) works on any table today. Outbox-driven re-embedding is more precise and arrives when the producer attaches `blocks_core.attach_outbox_trigger`. Neither requires the consumer to change.
- **Content hashing prevents pointless spend.** An `updated_at` bump from an unrelated column change must not trigger a re-embed. Comparing a hash of the *embedded text* is what makes the difference between a cheap no-op and paying to re-embed a corpus.
- **The outbox trigger carries both `old` and `new`**, specifically so a consumer can diff and skip no-op writes. That's why block 1's trigger function includes the old row.
- **Re-embedding is queued, never inline.** A bulk update touching 50,000 rows must not attempt 50,000 model calls in one invocation.

## API

| Route | Purpose |
|---|---|
| `POST /sources` | Register a table whose text should stay embedded. |
| `POST /scan` | Cron. Detect changed rows and queue re-embeds. |
| `GET /pending` | Rows currently known to be stale. |
| `GET /health` | `200` / `503`. |

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `FRESHNESS_BATCH_SIZE` | `200` | Rows examined per invocation. Each stale row becomes one queued re-embed job. |
| `FRESHNESS_EMBEDDING_MODEL` | `text-embedding-3-small` | Must match the model used originally, or re-embedded vectors are not comparable with the rest of the index. |
| `FRESHNESS_EMBEDDING_DIMENSIONS` | `1536` | Must match the model and the vector column width. |
| `NEON_BLOCKS_TRIGGER_SECRET` | `` | Shared secret authenticating trigger delivery. Neon does not sign trigger POSTs. |

Injected automatically by Neon: `DATABASE_URL`, `NEON_AI_GATEWAY_API_KEY`.

## Limits and honest caveats

- **The re-embed worker is a TODO seam.** Change detection and the watermark are specified in the schema; the embed-and-update step is not written. It is a small amount of code that mirrors block 2's ingestion path.
- **Watermark polling has a floor of one minute** (cron), and it cannot detect deletes. Outbox mode handles deletes; watermark mode needs a periodic full reconciliation.
- **Registering a source table requires the table to have an `updated_at`-equivalent column.** Tables without one can only use outbox mode.
- **No backfill throttling beyond batch size.** Registering a large existing table queues the whole thing; a token budget would be a sensible addition.
- **Unverified against a live Neon project.** Nothing in this repo has been run against real Neon
  infrastructure yet.

## Observability

```sql
SELECT * FROM blocks_embedding_freshness.v_status;
```

## Uninstall

```bash
neon-blocks rollback embedding-freshness
```
