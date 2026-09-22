# Block 5 — Ingest Router

One storage trigger per bucket, dispatched in-function by detected file type. Centralizes the
three things every storage block would otherwise rediscover the hard way.

**Rank #5 of 25.** Ranked above the pipelines it feeds, because those pipelines are safe only if
this exists.

## Why a router at all

Storage triggers have **no suffix and no content-type filter**. You get every object written under
the watched prefix. Without a router you'd create twelve triggers on one bucket and each handler
would still receive all twelve kinds of file and have to filter anyway.

Worse, each of those handlers would independently need to get three things right:

| Problem | Why it bites | Solved here |
|---|---|---|
| **Write-amplification loop** | A derivative written into the watched bucket retriggers the pipeline. **Forever.** There is no negative prefix filter. | `assertNoLoop()` at startup + `isDerivative()` at dispatch |
| **Forged events** | Delivery is an unauthenticated POST; `X-Neon-Trigger-Invocation-Id` is identification, not auth. Anyone with the URL can name any key. | HEAD-verify before acting, prefix re-check |
| **Overwrites** | Overwriting a key re-fires the trigger with new content. Keying on the object alone serves stale results. | idempotency on `(key, etag)` |

Getting any of these wrong once per block is five chances to burn a month of capacity-hours.

## Install

```bash
neon-blocks migrate ingest-router
neon function deploy ingest-router --src blocks/ingest-router/src

neon triggers create --function-slug ingest-router --name router \
  --bucket uploads --prefix 'uploads/' --function-path '/route'
neon triggers create --function-slug ingest-router --name router-reconcile \
  --schedule '37 * * * *' --function-path '/reconcile'
```

Configure the route table:

```bash
ROUTER_ROUTES='{
  "pdf":         ["rag.ingest"],
  "document":    ["rag.ingest"],
  "text":        ["rag.ingest"],
  "spreadsheet": ["csv.import"],
  "image":       ["vision.tag", "image.derive", "moderation.scan"],
  "audio":       ["transcription.run"],
  "video":       ["transcription.run"]
}'
```

Kinds absent from the table are recorded as `unrouted` — **visible, not dropped**. A silent drop is
indistinguishable from a bug.

## The loop hazard, concretely

This is the expensive mistake, so the block refuses to start rather than warning:

```
BAD:   watch uploads/           write uploads/thumbs/    → infinite loop
       A write under uploads/thumbs/ still matches a trigger watching uploads/.

GOOD:  watch uploads/           write derived/           → disjoint prefixes
BEST:  watch bucket "uploads"   write bucket "derived"   → separate buckets
```

`assertNoLoop()` throws `LoopHazardError` at startup if input and output share a bucket and the
prefixes overlap in either direction. `isDerivative()` is the runtime backstop, and it checks for
the output prefix **anywhere** in the key — because `uploads/tenant/derived/thumb.jpg` begins with
the watched prefix, so a naive `startsWith` check against the output prefix would miss it and the
loop would run anyway.

## Dispatch order is deliberate

Cheap rejections come first, so a forged event or a derivative costs nothing but an invocation:

1. **Derivative?** → skip. No I/O.
2. **Outside watched prefix?** → skip. No I/O. (Belt and braces against a forged key.)
3. **HEAD-verify** → establishes existence, supplies size/type/etag the payload lacks.
4. **Over `ROUTER_MAX_BYTES`?** → record as `rejected`.
5. **Claim `(key, etag)`** atomically → concurrent deliveries produce one set of jobs.
6. **Classify and enqueue**, with per-job idempotency keys.

Jobs land in block 1's queue with the object's metadata in the payload, so downstream handlers
don't repeat the HEAD.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `ROUTER_BUCKET` | *required* | Triggers watch exactly one bucket each. |
| `ROUTER_PREFIX` | `uploads/` | Case-sensitive, no path normalization. |
| `ROUTER_OUTPUT_BUCKET` | `""` → same as input | A separate bucket is the safest shape. |
| `ROUTER_OUTPUT_PREFIX` | `derived/` | Must be provably disjoint from `ROUTER_PREFIX`. |
| `ROUTER_ROUTES` | `{}` | Unknown kind names are rejected at startup. |
| `ROUTER_MAX_BYTES` | `524288000` (500 MB) | Larger objects recorded and skipped. |

Valid kinds: `image` `pdf` `document` `spreadsheet` `text` `audio` `video` `archive` `data`
`unknown`.

## Observability

```sql
SELECT * FROM blocks_ingest_router.v_by_kind;   -- what's arriving, and where it goes
SELECT * FROM blocks_ingest_router.v_status;
```

`v_by_kind` is the first place to look when "nothing happened" — it distinguishes *no route
configured* from *too large* from *never delivered*, which otherwise look identical.

`/health` reports `unrouted` objects as degraded rather than healthy. It's usually a missing entry
in `ROUTER_ROUTES`, not a failure, but it's worth surfacing because the symptom is silence.

## Limits and honest caveats

- **Classification uses extension and content type, not magic bytes.** `detectKind` supports magic
  bytes, but the router doesn't read object contents to get them — that would mean downloading
  every file just to classify it. Practical consequence: a `.bin` file that's really a PDF routes as
  `unknown`. A 512-byte ranged read would fix this and is the obvious improvement.
- **One router per bucket.** A second bucket needs a second deployment.
- **No content-based routing.** Routes key on kind only, not size, tenant, or metadata.
- **Unverified against a live Neon project.** 23 unit tests cover route parsing and the loop guard;
  the storage and queue paths are written against documented behaviour but untested end-to-end.

## Uninstall

```bash
neon-blocks rollback ingest-router
```

Drops the dispatch ledger. Jobs already enqueued in `blocks_queue` are unaffected.
