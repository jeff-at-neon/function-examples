# Block 23 — Image Derivatives

Thumbnails and transforms with EXIF stripping, generated on read and cached, not eagerly on upload.

**Block 23 of 25**, numbered in build order.

> **Status: implemented.** Schema, safety checks, control flow, and the safety logic (header-based
> decompression-bomb guard, EXIF/GPS stripping, cache + orphan reconcile) are all wired, with pure
> unit tests. The pixel resize runs through a Codec adapter (WASM libvips or equivalent) supplied at
> deploy — the esbuild bundle cannot ship a native binary — so `/i/:key` returns 503 until a codec
> is installed. Still unverified against a live Neon project.

## Why this block

Image resizing is well served by dedicated image CDNs, and running it next to Postgres buys
nothing for the pixel work itself. What it does buy is the registry join -- "every image this
tenant owns, and whether its thumbnail exists yet" -- which is not a question object storage
can answer on its own.

Built late because of packaging, not cost. The compute is affordable: active Capacity-Hours are
4x waiting rather than 40x, which works out around $16-26 per million images. The real obstacle
is that the default esbuild bundle cannot load native .node binaries, so sharp breaks the
one-command install.

## Install

```bash
neon-blocks migrate image-derivatives
neon function deploy image-derivatives --src blocks/image-derivatives/src
neon triggers create --function-slug image-derivatives --name image-derivatives-reconcile \
  --schedule '19 5 * * *' --function-path '/reconcile'
```

> Child branches inherit triggers **disabled**. Enable them after promoting, or scheduled work
> silently never runs.

## Design notes

- **Transform-on-read, not eager generation.** Eager generation means guessing sizes up front, regenerating everything when the design changes, and paying to store derivatives nobody requests. On-demand with a cache check inverts all three.
- **WASM libvips by default, native `sharp` as an opt-in.** WASM is 2–4× slower but bundles cleanly with the default esbuild path, which keeps `neon-blocks add` a single command. Native needs `bundler: "none"` plus a platform-matched `node_modules`, and unbundled deploys cannot ship TypeScript.
- **Derivatives go to a separate bucket or a provably disjoint prefix, enforced at startup.** Writing output into the watched bucket retriggers the pipeline forever, and there is no negative prefix filter to prevent it. `assertNoLoop` throws rather than warns because the failure mode is a runaway bill.
- **EXIF and GPS are stripped unconditionally.** A phone photo carries the coordinates of where it was taken; serving that alongside a user's avatar is a privacy leak nobody remembers to handle, so it is not configurable.
- **Pixel count is capped, not just byte size.** A 40 KB PNG can decode to 30,000×30,000 pixels and exhaust memory instantly. Byte limits do not catch decompression bombs; dimension limits do.

## API

| Route | Purpose |
|---|---|
| `GET /i/:key` | Serve a derivative, generating on a cache miss. |
| `POST /reconcile` | Cron. Mark derivatives whose source is gone. |
| `GET /derivatives` | Derivatives for a source key. |
| `GET /health` | `200` / `503`. |

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `IMAGES_SOURCE_BUCKET` | *required* | Bucket holding original images. |
| `IMAGES_SOURCE_PREFIX` | `uploads/` | Prefix under which originals live. |
| `IMAGES_DERIVATIVE_BUCKET` | `` | Where derivatives are written. A separate bucket is the safest shape; empty reuses the source bucket, which then requires a disjoint prefix. |
| `IMAGES_DERIVATIVE_PREFIX` | `derived/` | Prefix for derivatives. Must be provably disjoint from IMAGES_SOURCE_PREFIX when sharing a bucket, or every output retriggers the pipeline. |
| `IMAGES_MAX_PIXELS` | `40000000` | Maximum source pixel count. The decompression-bomb guard: a 40KB PNG can decode to 30000x30000, which a byte limit does not catch. |
| `IMAGES_MAX_BYTES` | `26214400` | Maximum source file size. |
| `IMAGES_ALLOWED_WIDTHS` | `64,128,256,512,1024,2048` | Comma-separated permitted widths. An allowlist, not a range: unbounded widths let a caller generate unlimited distinct derivatives and bill you for each. |
| `IMAGES_CACHE_CONTROL` | `public, max-age=31536000, immutable` | Cache-Control on served derivatives. Long, because content is immutable for a given key and etag. |
| `NEON_BLOCKS_TRIGGER_SECRET` | `` | Shared secret authenticating trigger delivery. Neon does not sign trigger POSTs. |

Injected automatically by Neon: `DATABASE_URL`, `NEON_STORAGE_ENDPOINT`, `NEON_STORAGE_ACCESS_KEY_ID`, `NEON_STORAGE_SECRET_ACCESS_KEY`.

## Limits and honest caveats

- **The resize call is a TODO seam.** The cache lookup, loop guard, dimension validation, and metadata recording are real; the pixel work is not wired, and the library choice determines the packaging story.
- **Without a CDN in front, every image request is a billed invocation.** Transform-on-read is only economical with edge caching, where the 99% cache-hit path never reaches compute. This is the single biggest platform ask for making this block genuinely good.
- **Functions run at a fixed size**, so there is no scaling up for large TIFFs. Big sources fail rather than run slowly, which is why the pixel cap exists.
- **No `storage_object_deleted` event exists**, so a deleted source leaves its derivatives orphaned. The reconciler detects that by absence; until it runs you are paying to store garbage.
- **AVIF and JPEG XL support depends on the chosen library**, and the WASM build may lack encoders the native build has.
- **Unverified against a live Neon project.** Nothing in this repo has been run against real Neon
  infrastructure yet.

## Observability

```sql
SELECT * FROM blocks_image_derivatives.v_status;
```

## Uninstall

```bash
neon-blocks rollback image-derivatives
```
