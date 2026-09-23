# Block 6 — Receive webhooks

Verify, dedupe, and store Stripe, GitHub, Shopify, and Slack events

**Rank #6 of 25.** Everyone needs this; everyone gets the verification subtly wrong.

## The four mistakes this exists to prevent

A broken webhook verifier usually still accepts *legitimate* requests, so these don't surface in
testing:

1. **Verifying the re-serialized body.** `JSON.stringify(JSON.parse(raw))` is a *different string* —
   whitespace and key order aren't preserved. The signature can never match. This block reads
   `request.text()` once and verifies those exact bytes.
2. **Comparing digests with `===`.** Leaks timing. Uses `timingSafeEqual`, including a fixed-cost
   path for length mismatches, since `timingSafeEqual` itself throws on unequal lengths.
3. **Ignoring the timestamp.** Without it a captured request replays forever — the signature never
   expires. Stripe, Slack, and Svix all sign a timestamp; this enforces a tolerance window on all
   three, and rejects far-future times too (clock skew means misconfiguration).
4. **Accepting only the first signature candidate.** Stripe and Svix send multiple during secret
   rotation. Checking only the first works fine until the old secret expires, at 3am.

Provider-specific traps also handled: GitHub requires the `sha256=` prefix; Shopify is base64 not
hex; Slack signs `v0:<ts>:<body>` not `<ts>:<body>`; **Svix secrets are `whsec_` + base64 and the
decoded bytes are the key** — signing with the printable string produces a mismatch that looks
exactly like a wrong secret.

## Install

```bash
neon-blocks migrate webhooks-inbound
neon function deploy webhooks-inbound --src blocks/webhooks-inbound/src
```

No triggers. Nothing here drifts — the archive is written in the same request that verifies the
signature, so there's no missed-delivery state to reconcile. Point the provider at
`https://<your-domain>/hooks/stripe` (custom domains for Functions make this a stable URL).

Set only the secrets you need:

```bash
WEBHOOK_SECRET_STRIPE=whsec_...
WEBHOOK_SECRET_GITHUB=...
```

A provider with no configured secret is **refused**, not accepted unverified.

## Why the raw archive matters

Providers don't let you re-request a webhook. If a handler bug eats an event, bytes you kept are the
only recovery. Storing the body verbatim also means archived deliveries stay independently
re-verifiable — which is what makes `POST /replay` trustworthy rather than just convenient. Signature
headers are retained for that reason; `authorization` and `cookie` are dropped.

**Rejected deliveries are archived too.** A burst of verification failures is a signal — usually a
rotated secret, occasionally a probe — and discarding them hides it. `/health` reports rejections in
the last hour as degraded for the same reason.

## Status codes are chosen for provider retry behaviour

| Outcome | Code | Why |
|---|---|---|
| Accepted | `202` | Queued, not yet processed. Honest. |
| Duplicate | `200` | Already succeeded once; stop retrying. |
| Bad signature | `401` | Providers treat 4xx as permanent. Retrying will never succeed. |
| Body too large | `413` | Permanent. |

Work is handed to the outbox, not done inline — the provider is waiting and most have short
timeouts. Processing happens in block 1's queue.

## Dedupe

Prefers the provider's own event id (`evt_…`, `svix-id`, `X-GitHub-Delivery`). For providers that
send none, falls back to a body hash within `WEBHOOK_DEDUPE_WINDOW_MINUTES` — identical bytes twice
in an hour is a redelivery, not a coincidence.

## API

| Route | Purpose |
|---|---|
| `POST /hooks/:provider` | Receive. `provider` ∈ stripe, github, shopify, slack, clerk, generic. |
| `POST /replay` | `{provider?, since?, limit?}` — re-publish archived deliveries after a fix. |
| `GET /health` | `200` / `503`. |

## Limits and honest caveats

- **No per-endpoint secrets.** One secret per provider. Multi-tenant apps where each customer has
  their own Stripe Connect secret need a secrets table — a real addition, not a config change.
- **Event type extraction is regex-based** on the raw body, since parsing before verification would
  be backwards. Fine for Stripe and Clerk; GitHub and Shopify use headers instead.
- **The archive grows without bound.** No retention sweeper ships here deliberately — how long you
  must retain webhook evidence is a compliance question, not a default. Block 17 (`compliance`)
  owns TTL purging.
- **Replay re-publishes the event, it does not re-verify the signature.** The bytes are there to do
  so; wiring it in would be a good hardening step.
- **25 unit tests cover the verifiers exhaustively**, including the re-serialization trap and
  rotation. The SQL paths are unverified against a live Neon project.

## Observability

```sql
SELECT * FROM blocks_webhooks_inbound.v_by_provider;  -- accepted vs rejected, per provider
SELECT * FROM blocks_webhooks_inbound.v_status;
```

## Uninstall

```bash
neon-blocks rollback webhooks-inbound
```

**This destroys the raw archive** — the only copy of events providers won't resend. Back up
`blocks_webhooks_inbound.deliveries` first if replay matters to you.
