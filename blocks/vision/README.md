# Block 9 — AI Vision Enrichment

Tags, captions, **auto alt text**, and OCR for uploaded images. Makes images searchable and closes
an accessibility gap nobody fills by hand.

**Rank #9 of 25.** Ranked deliberately above the CPU-bound image work in block 23, for a reason
worth stating.

## The economics are the argument

This block is **network-bound**: the function sits idle while the model works, so it bills at the
**waiting** rate of $0.025/Capacity-Hour — a quarter of the $0.10 active rate. The model call
dominates the cost; Neon compute is close to free.

Compare block 23 (thumbnails), which is CPU-bound and pays the active rate for real work. Instinct
says "resize images before you call an AI model"; the cost model says the opposite. Ship this
earlier than instinct suggests.

The image URL is **presigned and handed to the provider**, never downloaded and re-uploaded. That
would double the transfer, add egress, and hold the function open for the whole upload.

## Install

```bash
neon-blocks migrate vision
neon function deploy vision --src blocks/vision/src

neon triggers create --function-slug vision --name vision-analyze \
  --bucket uploads --prefix 'uploads/' --function-path '/analyze'
neon triggers create --function-slug vision --name vision-reconcile \
  --schedule '47 * * * *' --function-path '/reconcile'
```

> **Set `NEON_BLOCKS_TRIGGER_SECRET` for this block.** Trigger delivery is unauthenticated and each
> analysis costs a model call, so a forged event costs real money. This is the block where that
> matters most.

## Alt text is not a caption

They're different artifacts and models conflate them unless told not to:

- A **caption** adds information alongside the image. "A golden retriever running through a park."
- **Alt text** *substitutes* for the image. Under 125 characters, describes purpose in context,
  never starts with "image of" (screen readers already announce that).

Two details the code handles that most implementations don't:

1. **`alt=""` is preserved, never collapsed to null.** An empty alt attribute is the *correct*
   markup for a decorative image, and it is different from having no alt attribute. Conflating them
   is an accessibility regression, so `v_status.missing_alt_text` counts only genuine nulls.
2. **Redundant prefixes are stripped** post-hoc — models emit "Image of a red bicycle" despite being
   told not to.

## Response parsing is deliberately tolerant

A model returning almost-JSON is the normal case, not the exception. The parser handles markdown
fences, leading prose ("Here is the analysis:"), braces inside string values, escaped quotes,
comma-separated strings where an array was requested, arrays containing nulls, and confidence
reported as `85` instead of `0.85`.

Brace-scanning with string awareness, not a regex — `{"caption":"a sign reading {open}"}` truncates
under a regex. Failing an ingestion over a stray fence would be absurd.

## What you get to query

```sql
-- every invoice image
SELECT object_key FROM blocks_vision.analyses WHERE tags @> '{invoice}';

-- text *inside* images
SELECT object_key, ocr_text FROM blocks_vision.analyses
WHERE search_tsv @@ websearch_to_tsquery('english', 'purchase order');

SELECT * FROM blocks_vision.v_tag_frequency;
```

`GET /search?tags=invoice,scan&text=purchase+order&limit=25` exposes both. Tag search uses the GIN
index; text search uses a generated tsvector over OCR + caption, which cannot drift from its sources.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `VISION_BUCKET` | *required* | |
| `VISION_PREFIX` | `uploads/` | Non-images here are recorded `skipped` — no suffix filter exists. |
| `VISION_MODEL` | `gpt-4o-mini` | Must accept image input. |
| `VISION_OUTPUTS` | `tags,caption,altText,ocr` | All in **one** call: image tokens dominate, so five calls means paying for the image five times. |
| `VISION_MAX_TAGS` | `12` | |
| `VISION_MAX_BYTES` | `20971520` (20 MB) | |
| `VISION_URL_TTL_SECONDS` | `300` | Short — the URL leaves your infrastructure. |

OCR requests use `detail: "high"`; everything else uses `auto`. High detail costs more but `low`
loses small text, which defeats the point of OCR.

## Cost control

Identity is `(bucket, key, etag)`, so an unchanged image is **never** re-analysed — each analysis is
a paid call. The reconciler is capped at **10 images per run** for the same reason: an unbounded
backlog sweep could spend real money in a single invocation. When it caps, it logs what it dropped.

## Limits and honest caveats

- **Dominant colours come from the model, not pixel analysis.** Approximate. Real extraction needs
  image decoding, which is block 23's territory.
- **No face detection, no NSFW classification.** Moderation is block 18 — deliberately separate,
  because quarantine-on-upload has different failure semantics than enrichment.
- **OCR quality is whatever the model gives you.** Good for signs and documents, unreliable for
  dense scans or handwriting. A dedicated OCR service beats a general vision model here.
- **Confidence is model self-reported** and therefore advisory. It's recorded so a human-review queue
  can prioritise, but don't treat it as calibrated.
- **No human-review queue.** Low-confidence results are flagged in `v_status`; wiring them to a
  review workflow is block 16's pattern.
- **33 unit tests cover prompt construction and parsing** — including the `alt=""` case. The model
  and storage paths are unverified against a live Neon project.

## Uninstall

```bash
neon-blocks rollback vision
```

Drops `blocks_vision`, including alt text you may be serving. Export it first if your pages depend
on it.
