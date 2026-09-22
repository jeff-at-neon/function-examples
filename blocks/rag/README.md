# Block 2 — Document → RAG Ingestion

Drop a document in a bucket; it becomes semantically searchable. Extract → chunk → embed →
pgvector, driven by a storage trigger with a cron reconciler behind it.

**Rank #2 of 25.** The catalog's flagship demo: it lights up Object Storage, pgvector, AI
Gateway, and Functions in a single gesture, and it's the thing people most often want to build.

## Install

```bash
neon-blocks migrate rag
neon function deploy rag --src blocks/rag/src

neon triggers create --function-slug rag --name rag-ingest \
  --bucket documents --prefix 'uploads/' --function-path '/ingest'
neon triggers create --function-slug rag --name rag-reconcile \
  --schedule '23 * * * *' --function-path '/reconcile'
```

Then upload something and search it:

```bash
curl -X POST "$RAG_URL/search" -d '{"query":"what is our refund policy"}'
```

> **Child branches inherit triggers DISABLED.** After promoting, enable them or nothing ingests.
> `/health` won't catch this on its own — the reconciler will, by reporting objects in storage
> with no matching document.

## What's implemented vs not

Being explicit, because a RAG pipeline that silently ingests nothing is worse than one that
refuses:

| Format | Status |
|---|---|
| `.txt`, `.md`, `.html`, `.csv`, `.tsv`, `.json`, `.jsonl` | **Implemented**, zero dependencies |
| `.pdf` | **Returns `needsParser`.** Wire in [`unpdf`](https://github.com/unjs/unpdf) — WASM, bundles cleanly |
| `.docx`, `.odt` | **Returns `needsParser`.** Wire in `mammoth` |
| images, audio, video, archives | Skipped by design (see blocks 9, 19) |

A document that can't be parsed lands in `status = 'skipped'` with the reason recorded — never in
`ready` with zero chunks.

On cost: PDF parsing is CPU-bound, but active Capacity-Hours are only **4×** waiting
($0.10 vs $0.025), not the 40× the free tier's 10:400 quota split implies. In-function parsing
is economically fine; the blocker is the dependency, not the compute.

## How it works

```
upload → storage trigger → HEAD-verify → extract → chunk → embed → pgvector
                                ↑
                     cron reconciler (hourly): missed uploads, deletions, stuck docs
```

**HEAD-verify is the security boundary.** Trigger delivery is an unauthenticated POST, so a
forged event naming a nonexistent object must die before anything is written. It's also how the
block learns size, content type, and etag — the documented payload is only
`{bucket_name, object_key}`.

**Identity is `(bucket, key, etag)`.** Overwriting an object re-fires the trigger with new
content; keying on the object alone would serve stale embeddings forever.

**Identical content is embedded once.** Chunks are content-addressed by SHA-256 of the extracted
text, so re-uploading the same document under a new key copies vectors instead of paying to
recompute them. Guarded on embedding model — copying across models would mix incomparable
vectors.

## The reconciler is not optional

Storage triggers are **Beta**: no documented retry, ordering, or delivery guarantee, and **no
delete or update events**. So the hourly cron pass fixes three kinds of drift:

1. **Missed uploads** — object exists, no document row. Ingests up to 25 per run.
2. **Orphaned rows** — object deleted. Without delete events these are otherwise permanent.
3. **Stuck documents** — function died mid-pipeline, leaving `extracting`/`embedding`.

Orphan detection is **skipped when the listing is truncated**, because from a partial view every
unlisted object looks deleted and live documents would be wrongly marked gone. That's reported as
a warning rather than silently narrowing the sweep.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `RAG_BUCKET` | *required* | Bucket to watch. |
| `RAG_PREFIX` | `uploads/` | No suffix filter exists, so non-documents here are recorded as skipped. |
| `RAG_EMBEDDING_MODEL` | `text-embedding-3-small` | **Changing this after ingestion needs a migration**, not a config change. |
| `RAG_EMBEDDING_DIMENSIONS` | `1536` | Must match the model *and* the `vector(1536)` column. |
| `RAG_CHUNK_CHARS` | `1000` | ~250 tokens. |
| `RAG_CHUNK_OVERLAP` | `150` | Keeps a fact spanning two chunks retrievable from either. |
| `RAG_MAX_BYTES` | `26214400` (25 MB) | Mandatory cap: public endpoint, fixed-size function. |

Embeddings default to **Neon AI Gateway** with credentials auto-injected — no signup, no API key.
Point `NEON_AI_GATEWAY_URL` elsewhere for any OpenAI-compatible endpoint.

## Search

`POST /search` with `{query, limit?, maxDistance?}`. Uses pgvector's `<=>` cosine operator so the
HNSW index is actually used. For BM25 + vector fusion with typo tolerance and facets, install
block 7 (`hybrid-search`) — it reads these same tables.

HNSW rather than IVFFlat deliberately: IVFFlat needs a training step, so an index built on an
empty table silently performs terribly, which is exactly what happens when migrations run before
any data exists.

## Observability

```sql
SELECT * FROM blocks_rag.v_status;
```

Watch `chunks_unembedded` (chunks that can't be retrieved) and `embedding_models_in_use` — if
that's above 1, vectors in the table aren't mutually comparable and search quality is silently
degraded.

## Limits and honest caveats

- **PDF and DOCX need a parser wired in.** The seam is `extractText()`; everything else works.
- **HTML stripping is regex-based**, not a real parser. Slightly imperfect text, not a security
  hole — and it keeps the block inside the default esbuild bundle.
- **Re-chunking replaces all chunks** for a document. Deliberate: a different chunk count would
  otherwise leave retrievable orphans pointing at text that no longer exists.
- **Nothing here has been run against a live Neon project.** 18 unit tests cover extraction and
  normalization; the SQL and storage paths are written against documented behaviour but unverified
  end to end.

## Uninstall

```bash
neon-blocks rollback rag
```

Drops `blocks_rag`. The `vector` extension is deliberately left installed — blocks 7, 14, 20, and
21 depend on it.
