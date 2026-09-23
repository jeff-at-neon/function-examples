# Block 7 — Hybrid search

Combine keyword and semantic search with typo tolerance

**Rank #7 of 25.** Completes block 2 — ingestion without good retrieval is half a product.

## Why RRF and not score blending

pgvector cosine distance (0–2, *lower* is better) and `ts_rank_cd` (unbounded, *higher* is better)
are not comparable. You cannot add them, average them, or min-max normalize them without one
silently dominating — and the domination is data-dependent, so it looks fine until your corpus grows.

RRF discards scores entirely and uses only **rank position**:

```
score(d) = Σ over retrievers r of  weight_r / (k + rank_r(d))
```

Three properties earn its place:

- **Scale-free.** A retriever can't win by having bigger numbers.
- **Agreement wins.** A document found by two retrievers outranks one found strongly by a single
  retriever — precisely the behaviour hybrid search exists for.
- **`k` damps top positions.** `k=60` is the value from the original Cormack et al. paper. It's a
  sane documented default, not a tuned one.

## Install

```bash
neon-blocks migrate rag            # this block searches rag's corpus
neon-blocks migrate hybrid-search
neon function deploy hybrid-search --src blocks/hybrid-search/src
```

No triggers — this block only reads, so nothing drifts and there's nothing to reconcile.

```bash
curl -X POST "$URL/search" -d '{"query":"refund policy","limit":10}'
```

## It reads another block's schema, deliberately

This is the catalog's one sanctioned exception to "never touch another block's schema" (§1). Hybrid
search indexes and queries `blocks_rag.chunks`, declared via `dependsOn: ["rag"]`. The alternative —
its own copy of every chunk and embedding — would double storage and guarantee drift. The convention
checker permits foreign schemas only when the dependency is declared, so the coupling stays visible
and installs order correctly.

It adds the **retrieval-only** indexes (trigram GIN) rather than putting them in the RAG block, so a
user who only ingests doesn't pay to maintain them.

## Three retrievers, three separate queries

Not one clever `UNION` with a hand-rolled score. Three reasons:

1. **Each index is actually used.** Mixing `<=>` ordering with a `tsquery` filter in one statement
   defeats both the HNSW and the GIN index.
2. **Weight 0 disables a retriever** without rewriting SQL — and skips the embedding network call
   entirely when the vector retriever is off.
3. **Fusion stays pure**, so it carries 23 unit tests.

| Retriever | Mechanism | Notes |
|---|---|---|
| vector | `embedding <=> query` (HNSW) | Semantic. Needs one embedding call. |
| fulltext | `content_tsv @@ websearch_to_tsquery` | **`websearch_` never raises on user input.** `to_tsquery('a & & b')` throws — a search box that 500s on a stray ampersand is a bad search box. |
| trigram | `content % query` (GIN trigram) | Typo tolerance. Short queries only. |

**Trigram runs only for queries of ≤4 words.** It's expensive over large tables and adds little to
long queries, where full-text already has enough signal. `%` is used rather than bare `similarity()`
because only the operator uses the index — `similarity()` alone forces a sequential scan over every
chunk, which is the difference between fast and a timeout.

**Candidate depth defaults to 4× the limit.** Fusion can only reorder what the retrievers returned,
so depth == limit means a document ranked 11th by vector and 1st by full-text is never seen — exactly
the case hybrid search is for.

## Relevance tuning is the point of the query log

```sql
SELECT * FROM blocks_hybrid_search.v_zero_result_queries;
```

Zero-result queries are the most actionable signal a search system produces: each row is either
missing content or a retrieval gap. `/health` reports a zero-result **ratio** above 25% (over ≥20
queries) as degraded — the ratio matters, not the count.

Weights can be overridden per request, so relevance can be A/B tested without a redeploy:

```json
{"query":"refund", "weights":{"vector":2,"fulltext":1,"trigram":0}}
```

Every response includes `retrievers` (how many candidates each returned) and per-hit `matchedBy`,
which is what makes a surprising ranking debuggable rather than mysterious.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `SEARCH_EMBEDDING_MODEL` | `text-embedding-3-small` | **Must match ingestion**, or query and document vectors aren't comparable. |
| `SEARCH_EMBEDDING_DIMENSIONS` | `1536` | Must match the model and column. |
| `SEARCH_WEIGHT_VECTOR` | `1` | 0 disables and skips the embedding call. |
| `SEARCH_WEIGHT_FULLTEXT` | `1` | |
| `SEARCH_WEIGHT_TRIGRAM` | `0.5` | Lower: it's a fallback, not a primary signal. |
| `SEARCH_RRF_K` | `60` | From the original paper. |
| `SEARCH_LOG_QUERIES` | `true` | Logging failures never fail a search. |

## API

| Route | Purpose |
|---|---|
| `POST /search` | `{query, limit?, documentId?, weights?, tenant?}` |
| `POST /click` | `{queryId, chunkId, rank}` — for measuring whether a ranking change helped. |
| `GET /health` | Reports empty corpus and zero-result ratio. |

## Limits and honest caveats

- **No reranker.** A cross-encoder rerank over the fused top-N is the single biggest quality win
  available and is not implemented. RRF is the cheap 80%.
- **English only.** `to_tsvector('english', …)` is hardcoded in the RAG block's generated column.
  Other languages need a different configuration, which is a migration.
- **No faceting or filtering beyond `documentId`.** Tenant-scoped search needs a predicate on a
  column the RAG block doesn't currently carry.
- **No pagination.** `limit` only. Deep paging through fused results needs a stable cursor, and
  fusion scores shift as the corpus changes.
- **Click-through has position bias.** Rank 1 gets clicked far more than rank 10 regardless of
  quality. The `rank` column is recorded so analysis *can* correct for it; nothing here does.
- **23 unit tests cover fusion exhaustively.** The SQL is written against documented Postgres
  behaviour but unverified against a live Neon project.

## Uninstall

```bash
neon-blocks rollback hybrid-search
```

Drops the query log and the trigram index it added. Leaves `blocks_rag` and the `pg_trgm` /
`unaccent` extensions alone — other blocks may use them.
