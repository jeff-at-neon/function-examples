# Block 19 — Audio and Video Transcription

Whisper-class transcription with timestamps, feeding the same search index as documents.

**Block 19 of 25**, numbered in build order.

> **Status: scaffold.** Schema, safety checks, and control flow are real and reviewable. The marked
> `TODO` seams are the remaining work, and unimplemented endpoints return `501` with a specific
> explanation rather than failing in a way that looks like a bug.

## Why this block

Makes spoken content searchable, which is the point: a two-hour meeting recording is unusable until you can find the thirty seconds that matter. It writes into the same chunk table the RAG block owns, so hybrid search covers audio and documents with one query rather than two.

## Install

```bash
neon-blocks migrate transcription
neon function deploy transcription --src blocks/transcription/src
neon triggers create --function-slug transcription --name transcription-transcribe \
  --bucket "$TRANSCRIBE_BUCKET" --function-path '/transcribe'
neon triggers create --function-slug transcription --name transcription-reconcile \
  --schedule '53 * * * *' --function-path '/reconcile'
```

> Child branches inherit triggers **disabled**. Enable them after promoting, or scheduled work
> silently never runs.

## Design notes

- **Orchestrate, never transcode in-function.** Transcoding is the most CPU-expensive thing you could do here, and functions run at a fixed size. The provider accepts the original file, or the file is rejected — no ffmpeg.
- **Segments with timestamps, not a wall of text.** A transcript without timestamps can be searched but not navigated, and 'somewhere in this two-hour recording' is barely better than nothing.
- **Chunks are written into the RAG block's table** so hybrid search covers audio and documents together. Declared via `dependsOn`, which is what makes that cross-schema write legitimate.
- **Long media is expected to exceed provider limits.** The block records a specific 'too long' status rather than failing generically, because that is a routine outcome needing a different remedy (split the file) than a transient error.

## API

| Route | Purpose |
|---|---|
| `POST /transcribe` | Storage trigger. Transcribe one file. |
| `POST /reconcile` | Cron. Retries and missed deliveries. |
| `GET /search` | Search spoken content, returning timestamps. |
| `GET /transcripts/:id` | A transcript with its segments. |
| `GET /health` | `200` / `503`. |

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `TRANSCRIBE_BUCKET` | *required* | Bucket to watch for media. |
| `TRANSCRIBE_PREFIX` | `media/` | Watched key prefix. |
| `TRANSCRIBE_MODEL` | `whisper-1` | Transcription model. |
| `TRANSCRIBE_MAX_BYTES` | `26214400` | Largest media file to attempt. Provider limits are usually well below this, so keep it conservative. |
| `TRANSCRIBE_INDEX_CHUNKS` | `true` | Write transcript chunks into blocks_rag.chunks so hybrid search covers spoken content. |
| `NEON_BLOCKS_TRIGGER_SECRET` | `` | Shared secret authenticating trigger delivery. Neon does not sign trigger POSTs. |

Injected automatically by Neon: `DATABASE_URL`, `NEON_STORAGE_ENDPOINT`, `NEON_STORAGE_ACCESS_KEY_ID`, `NEON_STORAGE_SECRET_ACCESS_KEY`, `NEON_AI_GATEWAY_API_KEY`.

## Limits and honest caveats

- **The transcription call is a TODO seam.** Provider APIs differ in how they accept media — URL versus multipart upload — and that choice determines whether bytes flow through the function at all.
- **No diarisation.** 'Who said what' needs a provider that supports speaker labels; segments carry no speaker field yet.
- **No transcoding, by design.** A format the provider rejects is rejected here too. That is a deliberate cost decision, and the README states it rather than implying broad format support.
- **Duration is not verified before the call.** A file over the provider's limit fails at the provider rather than being caught locally, which wastes a call — reading media duration needs a parser.
- **Unverified against a live Neon project.** Nothing in this repo has been run against real Neon
  infrastructure yet.

## Observability

```sql
SELECT * FROM blocks_transcription.v_status;
```

## Uninstall

```bash
neon-blocks rollback transcription
```
