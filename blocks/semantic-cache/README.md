# Block 20 — LLM cache

Reuse an answer for a rephrased question by embedding similarity

**Block 20 of 25**, numbered in build order.

> **Status: implemented.** Schema, safety checks, control flow, and the core logic (exact + vector
> similarity lookup) are all wired, with pure unit tests. Still unverified against a live Neon project.

## Why this block

Cuts AI spend on repeated questions. An exact-match cache misses almost everything, because nobody asks the same question the same way twice -- similarity matching is what makes a cache hit at all.

## Install

```bash
neon-blocks migrate semantic-cache
neon function deploy semantic-cache --src blocks/semantic-cache/src
neon triggers create --function-slug semantic-cache --name semantic-cache-sweep \
  --schedule '37 3 * * *' --function-path '/sweep'
```

> Child branches inherit triggers **disabled**. Enable them after promoting, or scheduled work
> silently never runs.

## Design notes

- **Similarity threshold is the entire design.** Too low and you return an answer to a different question, which is worse than a cache miss because it is silently wrong. Default is deliberately strict.
- **Namespaces keep prompts separate.** A cached answer for one system prompt or one tenant must never serve another; conflating them is a cross-tenant data leak wearing a performance improvement.
- **The model identity is part of the key.** A cached response from a weaker model must not be served as if it came from a stronger one, so entries are scoped by model rather than shared.
- **Cost saved is tracked explicitly.** A cache nobody can measure gets removed during the next cleanup, and the token counts are what justify keeping it.

## API

| Route | Purpose |
|---|---|
| `POST /lookup` | Find a cached response for a prompt. |
| `POST /store` | Cache a response. |
| `POST /sweep` | Cron. Expire entries and report hit rate. |
| `GET /stats` | Hit rate and tokens saved by namespace. |
| `GET /health` | `200` / `503`. |

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `CACHE_SIMILARITY_THRESHOLD` | `0.95` | Cosine similarity required for a hit, 0..1. Strict by default: a loose threshold returns answers to different questions, which is worse than a miss because it is silently wrong. |
| `CACHE_TTL_HOURS` | `168` | How long an entry is servable. The only defence against staleness, and a blunt one. |
| `CACHE_EMBEDDING_MODEL` | `text-embedding-3-small` | Must be consistent across the cache, or similarity is meaningless. |
| `CACHE_EMBEDDING_DIMENSIONS` | `1536` | Must match the model and the vector column. |
| `NEON_BLOCKS_TRIGGER_SECRET` | `` | Shared secret authenticating trigger delivery. Neon does not sign trigger POSTs. |

Injected automatically by Neon: `DATABASE_URL`, `NEON_AI_GATEWAY_API_KEY`.

## Limits and honest caveats

- **The lookup and store path is a TODO seam.** Schema, indexes, and the threshold policy are specified; the embed-then-search call is not written.
- **A cache hit still costs one embedding call.** Cheaper than the completion it replaces, but not free — so for very short prompts the saving is thin, and the README says so rather than implying it is free.
- **No invalidation on knowledge change.** If your underlying data changes, cached answers go stale with nothing to detect it. TTL is the only defence, and it is blunt.
- **Similarity is not equivalence.** Two prompts can be semantically close and still require different answers ('delete my account' versus 'do not delete my account'). Negation is the known weak spot of embedding similarity, and no threshold fixes it.
- **Unverified against a live Neon project.** Nothing in this repo has been run against real Neon
  infrastructure yet.

## Observability

```sql
SELECT * FROM blocks_semantic_cache.v_status;
```

## Uninstall

```bash
neon-blocks rollback semantic-cache
```
