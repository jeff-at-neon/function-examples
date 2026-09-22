# The catalog, ranked

Ranking criteria, weighted in this order: **dependency order** (foundations first),
**differentiation** (does colocation with Postgres actually help, or is this Cloudflare's
job), **universality**, **adoption pull** on sibling Neon primitives, **buildability
today** given real platform constraints, and **revenue ceiling**.

Monetization posture: `free` blocks drive compute and storage — monetize indirectly, keep
them excellent. `meter` blocks grow with the customer's *own* revenue, which is where
defensible per-event pricing lives. Nothing foundational is metered early; adoption first.

## Top 3 — build first

| # | Block | Why | Pulls in | $ |
|---|---|---|---|---|
| 1 | `queue` | Highest dependency count — 12+ blocks need it. Where "no row triggers" is solved **once**, behind an interface that survives the platform gaining them. | Functions, cron | free |
| 2 | `rag` | Best demo in the catalog: drop a PDF in a bucket, it's semantically searchable. Four primitives in one gesture. | Object Storage, pgvector, AI Gateway | free |
| 3 | `realtime` | The only block that's *hard to build elsewhere*. Long-running compute next to Postgres with native WebSocket upgrade; competitors need Redis plus a separate service. This is the moat. | Functions, Data API | free |

One substrate, one adoption narrative, one differentiator.

## Top 10 — credible v1 catalog

| # | Block | Why here | Pulls in | $ |
|---|---|---|---|---|
| 4 | `file-registry` | Keystone of the storage family — Object Storage is unqueryable without a SQL index of it. Includes presigned PUT and `pending→ready` finalize. Jumps to top 3 if you lead with storage. | Object Storage, RLS | free |
| 5 | `ingest-router` | One trigger per bucket, dispatch by type in-function. Solves the missing suffix filter; centralizes etag-idempotency, HEAD-verify, and loop safety so no downstream block reinvents them. | Storage triggers | free |
| 6 | `webhooks-inbound` | Signature verification per provider, raw archive, replay, dedupe. Everyone needs it; everyone gets it subtly wrong. | Custom domains | free |
| 7 | `hybrid-search` | BM25 + vector + RRF, facets, trigram typo tolerance. Completes #2 — ingestion without good retrieval is half a product. | pgvector, FTS | free |
| 8 | `billing` | Stripe/Polar → normalized tables, entitlements, usage rollups, dunning cron. Clearest addon-revenue story to *your* users. | Auth, queue | **meter** |
| 9 | `vision` | Tags, captions, **auto alt-text**, OCR. Network-bound so it's cheap; accessibility value is real and underrated. Ship earlier than instinct suggests. | AI Gateway, Object Storage | **meter** |
| 10 | `webhooks-outbound` | HMAC signing, backoff, circuit breaking, delivery log, replay. This is Svix's entire business. Highest per-event pricing power here. | queue | **meter** |

## Top 25 — full roadmap

| # | Block | Note | $ |
|---|---|---|---|
| 11 | `csv-import` | Staging → validate → typed merge → row-level error report. Unglamorous, universally needed, sells itself to enterprise. | free |
| 12 | `api-edge` | Hashed scoped API keys, per-tenant rate limits + quotas, idempotency middleware. Everyone rebuilds this badly. | free |
| 13 | `notifications` | Email/SMS/push, templates, preferences, quiet hours, digests, provider adapters. | free |
| 14 | `embedding-freshness` | Watermark/outbox-driven re-embed. Solves pgvector's #1 failure mode: stale vectors. Promoted to ~6 when row events land. | free |
| 15 | `pii-anonymizer` | Deterministic masking of DB **and** Object Storage. The flagship branching demo: a whole prod env safe to hand a contractor or an AI agent. | **meter** |
| 16 | `doc-extraction` | Invoices/receipts/forms → typed rows + confidence + human-review queue. High willingness to pay. | **meter** |
| 17 | `compliance` | Audit log (hash-chained option), soft delete + TTL purge, GDPR export/hard-delete. SOC 2 catnip. | **meter** |
| 18 | `moderation` | NSFW/abuse classification + malware scan, quarantine-by-default. Trust-and-safety requirement for any UGC app. | **meter** |
| 19 | `transcription` | Whisper-class via gateway → transcript + timestamps → feeds #7. Orchestrate, don't transcode in-function. | **meter** |
| 20 | `semantic-cache` | Cuts your users' AI Gateway spend. Slightly awkward — reduces Neon revenue while increasing loyalty. Worth it. | free |
| 21 | `agent-memory` | Sessions, summarization compaction, retrieval. Rides the agent wave; Neon already pitches Functions for agent loops. | free |
| 22 | `feature-flags` | Assignment, exposure logging, sticky bucketing, significance readout. | free |
| 23 | `image-derivatives` | Table stakes, not a differentiator. **WASM libvips** default to keep one-command install; native `sharp` needs `--no-bundle`. Transform-on-read beats eager generation. | **meter** |
| 24 | `analytics` | Event ingest → sessionization → funnel/retention/cohort query pack. | free |
| 25 | `db-health` | `pg_stat_statements` digest, index advisor, bloat monitor, schema-drift diff between branches, capacity-hours cost monitor. Cheap, makes Neon feel attentive. | free |

## Below the line, deliberately

**Strong but narrower (v2):** tenant provisioning (branch/schema-per-tenant), PR preview
environments with auto-expiry, backup-restore verification against a throwaway branch,
guarded read-only text-to-SQL, LLM prompt logging + judge evals, connector framework (high
stickiness, high effort), analytics landing zone, geospatial ingest → PostGIS,
perceptual-hash dedupe, retention/legal-hold/WORM, materialized-view refresher, metric
anomaly alerts, per-tenant cost attribution, data-quality assertions, migration guard.

**App primitives** (activity feeds, comments, booking/slots, inventory reservations,
waitlist/referrals, leaderboards, geocoding): correctly last. They're schema + queries more
than functions, they invite vertical-specific bikeshedding, and they compete with your
users' actual product work.

**Cut entirely: auth user sync from Clerk/Auth0/WorkOS.** Managed Better Auth owns
`neon_auth`; a block that mirrors a foreign IdP into Neon is building the off-ramp. Blocks
should build *on* `neon_auth`. When auth events ship, handlers for signup/trial/org-seeding
are the honest replacement.

## Two rules that bind the whole list

1. **Every trigger-driven block ships a cron reconciliation sweeper.** Storage triggers are
   Beta with no retry/ordering/delivery guarantee and no delete events. Trigger for
   latency, cron for correctness. That pairing also gives deletion detection for free.
2. **Monetize the middle, not the foundation.** 1–7 free and excellent. Meter the ones that
   grow with your customer's revenue.
