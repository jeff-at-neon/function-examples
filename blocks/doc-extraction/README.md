# Block 16 — Structured Document Extraction

Invoices, receipts, and forms become typed rows with per-field confidence and a human-review queue.

**Rank #16 of 25.** Metered.

> **Status: scaffold.** Schema, safety checks, and control flow are real and reviewable. The marked
> `TODO` seams are the remaining work, and unimplemented endpoints return `501` with a specific
> explanation rather than failing in a way that looks like a bug.

## Why this block

High willingness to pay, because the alternative is someone typing invoice totals into a form. The part that makes it usable in production is not the extraction -- it is the confidence scoring and the review queue. An extraction system with no review step either needs a human to check everything, which defeats the purpose, or silently books wrong numbers.

## Install

```bash
neon-blocks migrate doc-extraction
neon function deploy doc-extraction --src blocks/doc-extraction/src
neon triggers create --function-slug doc-extraction --name doc-extraction-extract \
  --bucket "$EXTRACT_BUCKET" --function-path '/extract'
neon triggers create --function-slug doc-extraction --name doc-extraction-reconcile \
  --schedule '43 * * * *' --function-path '/reconcile'
```

> Child branches inherit triggers **disabled**. Enable them after promoting, or scheduled work
> silently never runs.

## Design notes

- **Confidence is per field, not per document.** An invoice where the total is certain and the tax line is a guess needs the tax line reviewed and nothing else. A single document-level score forces all-or-nothing review.
- **Below-threshold fields queue for review; above-threshold ones apply.** That split is what makes the block save labour rather than relocate it.
- **Schemas are declared per document type**, with field types and required flags. The model is asked for exactly those fields, so a missing one is a detectable error rather than an absent key nobody notices.
- **A reviewed correction is stored alongside the extraction**, never overwriting it. The pair is training data and an audit trail: 'the model said 1,240.00 and a human changed it to 1,204.00' is the record you need when the numbers are disputed.

## API

| Route | Purpose |
|---|---|
| `POST /schemas` | Declare what to extract for a document type. |
| `POST /extract` | Storage trigger. Extract one document. |
| `POST /reconcile` | Cron. Retries and missed deliveries. |
| `GET /review` | Fields awaiting review, least confident first. |
| `POST /review/:id` | Submit a correction. |
| `GET /health` | `200` / `503`. |

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `EXTRACT_BUCKET` | *required* | Bucket to watch for documents. |
| `EXTRACT_PREFIX` | `documents/` | Watched key prefix. |
| `EXTRACT_MODEL` | `gpt-4o-mini` | Vision-capable model. Must accept image input. |
| `EXTRACT_CONFIDENCE_THRESHOLD` | `0.8` | Fields below this confidence queue for human review. Measure against your own corpus before trusting a value; model confidence is uncalibrated. |
| `EXTRACT_MAX_BYTES` | `20971520` | Largest document to process. |
| `NEON_BLOCKS_TRIGGER_SECRET` | `` | Shared secret authenticating trigger delivery. Neon does not sign trigger POSTs. |

Injected automatically by Neon: `DATABASE_URL`, `NEON_STORAGE_ENDPOINT`, `NEON_STORAGE_ACCESS_KEY_ID`, `NEON_STORAGE_SECRET_ACCESS_KEY`, `NEON_AI_GATEWAY_API_KEY`.

## Limits and honest caveats

- **The extraction call is a TODO seam.** Schema-to-prompt generation and response validation are the remaining work, and they mirror block 9's tolerant-parse approach closely.
- **PDF rendering for vision models is not implemented.** A scanned invoice is an image and works; a born-digital PDF needs either text extraction (block 2's seam) or rasterisation, which is CPU-bound.
- **No table extraction.** Line items in an invoice are the hardest part of this problem and are deliberately out of scope for a first version — getting a total right is useful on its own.
- **Confidence is model self-reported and uncalibrated.** Useful for ranking a review queue, not for deciding a threshold without measuring against your own corpus first.
- **Unverified against a live Neon project.** Nothing in this repo has been run against real Neon
  infrastructure yet.

## Observability

```sql
SELECT * FROM blocks_doc_extraction.v_status;
```

## Uninstall

```bash
neon-blocks rollback doc-extraction
```
