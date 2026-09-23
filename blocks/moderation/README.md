# Block 18 — Content moderation

Classify content for abuse and quarantine it until reviewed

**Block 18 of 25**, numbered in build order.

> **Status: implemented.** Schema, safety checks, control flow, and the core logic (per-category
> thresholded classification, fail-closed decisioning, and quarantine on block) are all wired, with
> pure unit tests. Classification calls a model through the Neon AI Gateway. Still unverified
> against a live Neon project.

## Why this block

A trust-and-safety requirement for any app with user-generated content, and the one design decision that matters is fail-closed: content is quarantined until it passes, not served until it fails. Fail-open moderation means the window between upload and classification is a window in which anything can be served, and that window is exactly when abuse is posted.

## Install

```bash
neon-blocks migrate moderation
neon function deploy moderation --src blocks/moderation/src
neon triggers create --function-slug moderation --name moderation-scan \
  --bucket "$MODERATION_BUCKET" --function-path '/scan'
neon triggers create --function-slug moderation --name moderation-reconcile \
  --schedule '31 * * * *' --function-path '/reconcile'
```

> Child branches inherit triggers **disabled**. Enable them after promoting, or scheduled work
> silently never runs.

## Design notes

- **Quarantine by default, release on pass.** The alternative — serve immediately, remove on fail — guarantees a serving window for the worst content. Ordering is the whole control.
- **Categories are scored independently.** 'Adult' and 'violence' and 'self-harm' have genuinely different thresholds and different escalation paths; one aggregate score forces one policy.
- **Thresholds are configurable per category and default strict.** A moderation block with permissive defaults is worse than none, because it creates a belief that content was checked.
- **A human decision always beats a model score, and is recorded as such.** Appeals exist, models are wrong, and 'a human approved this on the 14th' is what you need when a decision is challenged.

## API

| Route | Purpose |
|---|---|
| `POST /scan` | Storage trigger. Classify an upload. |
| `POST /text` | Classify inline text synchronously. |
| `POST /reconcile` | Cron. Rescan stuck items. |
| `GET /review` | Items awaiting human review. |
| `POST /decide/:id` | Record a human decision. |
| `GET /health` | `200` / `503`. |

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `MODERATION_BUCKET` | *required* | Bucket to watch for uploads. |
| `MODERATION_PREFIX` | `uploads/` | Watched key prefix. |
| `MODERATION_QUARANTINE_PREFIX` | `quarantine/` | Prefix quarantined objects move to. Must be disjoint from the watched prefix, or moving an object retriggers moderation of itself. |
| `MODERATION_MODEL` | `gpt-4o-mini` | Vision-capable model for image classification. |
| `MODERATION_THRESHOLDS` | `{"adult":0.5,"violence":0.6,"self_harm":0.4,"hate":0.4,"harassment":0.6}` | Per-category block thresholds as JSON, e.g. {"adult":0.5,"violence":0.7}. Strict by default: permissive defaults create a false belief that content was checked. |
| `NEON_BLOCKS_TRIGGER_SECRET` | `` | Shared secret authenticating trigger delivery. Neon does not sign trigger POSTs. |

Injected automatically by Neon: `DATABASE_URL`, `NEON_STORAGE_ENDPOINT`, `NEON_STORAGE_ACCESS_KEY_ID`, `NEON_STORAGE_SECRET_ACCESS_KEY`, `NEON_AI_GATEWAY_API_KEY`.

## Limits and honest caveats

- **Classification calls are TODO seams**, for both image and text. The quarantine state machine, thresholds, and decision recording are real; the model calls are not written.
- **Malware scanning is not implemented.** It needs a real engine (ClamAV or a scanning API) and cannot be done by an LLM. The status is modelled so the field is not silently absent, but nothing populates it.
- **No CSAM detection or reporting.** This requires hash-matching against law-enforcement databases, specific legal obligations, and cannot responsibly be a generic block. If you host user uploads, you need a dedicated provider for this — stated plainly because implying coverage here would be harmful.
- **No perceptual-hash matching** against previously-blocked content, so the same image must be re-classified on every upload.
- **Unverified against a live Neon project.** Nothing in this repo has been run against real Neon
  infrastructure yet.

## Observability

```sql
SELECT * FROM blocks_moderation.v_status;
```

## Uninstall

```bash
neon-blocks rollback moderation
```
