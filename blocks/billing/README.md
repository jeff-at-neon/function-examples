# Block 8 — Billing Spine

Normalized subscriptions, **local** entitlement checks, idempotent usage metering, and dunning
escalation. Provider-agnostic: Stripe, Polar, Paddle, or anything that emits subscription events.

**Block 8 of 25**, numbered in build order.

## Why local entitlements

The point is that "can this customer do this?" becomes an indexed local lookup, not an API call on
the request path. A Stripe API call in your authorization path makes Stripe's latency and Stripe's
outages *your* latency and *your* outages.

Plans are defined here, not at the provider. Provider price objects describe money; they don't
describe what a plan is *allowed to do*.

## Install

```bash
neon-blocks migrate billing
neon function deploy billing --src blocks/billing/src

neon triggers create --function-slug billing --name billing-sweep \
  --schedule '13 7 * * *' --function-path '/sweep'
```

Define plans:

```sql
INSERT INTO blocks_billing.plans (code, name, provider_ids, features, limits) VALUES
  ('free', 'Free', '{price_free}', '{}',                     '{"seats":1,"api_calls":1000}'),
  ('pro',  'Pro',  '{price_pro_m,price_pro_y}',
                   '{api_access,export}', '{"seats":5,"api_calls":100000,"storage_gb":null}');
```

`null` means **unlimited**. An **absent** key means the metric isn't granted at all. Those are
deliberately different, and conflating them either blocks paying customers or gives usage away for
free — the code refuses an explicit `undefined` rather than guessing which you meant.

## The decisions that matter

**`past_due` keeps access.** This is the case most implementations get wrong. A failed payment is
usually an expired card, not a churn decision — cutting access instantly turns a recoverable billing
problem into a cancelled customer. Access continues to `current_period_end` plus
`BILLING_GRACE_PERIOD_DAYS`, which is also what dunning assumes.

**Cancelled ≠ no access.** They paid for the period. Access continues to `current_period_end`.

**A lapsed trial is denied even if the status still says `trialing`.** Trusting a stale status means
an indefinite free trial whenever the status-change webhook is missed.

**`upgradeRequired` is separate from `allowed`.** "Upgrade your plan" and "fix your card" are
entirely different messages to put in front of a user.

**Out-of-order webhooks are rejected, not applied.** Provider events aren't ordered, so a delayed
webhook can overwrite newer state with older. The upsert's `WHERE` clause makes it a no-op unless
`provider_updated_at` is genuinely newer.

**Usage is raw events, aggregated by view — never an incremented counter.** When a customer disputes
an invoice, the only useful answer is the individual events, and you can't reconstruct those from a
number. Metering is driven by at-least-once events, so `idempotency_key` is enforced by a unique
index; a redelivery that double-bills would be the most damaging bug this block could have.

**Billing periods anchor to the subscription, not the calendar month.** A subscription renewing on
the 17th with calendar-month rollups produces totals that match no invoice, which is impossible to
reconcile with a customer.

**Dunning records each stage with a unique constraint**, so a customer who's had three notices never
gets a fourth on the next cron run — and the highest threshold reached wins, so a gap in cron runs
doesn't skip a notice entirely.

## API

| Route | Purpose |
|---|---|
| `POST /sync` | Apply normalized subscription state. Takes fields, not raw provider JSON. |
| `GET /entitlements?account=X&feature=Y&metric=Z&increment=N` | The authorization answer. |
| `POST /usage` | `{accountRef, metric, quantity?, idempotencyKey?}` → `201`, or `200` if deduplicated. |
| `POST /sweep` | Cron: dunning, trial warnings, rollups. |
| `GET /health` | `200` / `503`. |

`/sync` takes already-normalized fields deliberately — this block isn't coupled to any provider's
JSON shape. Pair it with block 6, which verifies and archives the webhook; a queue handler maps the
payload into this call.

Dunning and trial notices are **published as events**, not sent. Block 13 (`notifications`) owns
delivery, templates, and quiet hours. This block decides *that* a notice is due, not how it looks.

## Observability

```sql
SELECT * FROM blocks_billing.v_status;
SELECT * FROM blocks_billing.v_entitlements WHERE account_ref = 'acme';
```

`/health` reports **`subscriptions_orphan_plan`** as an error — a subscription pointing at a
nonexistent `plan_code` evaluates to "no plan" and denies every feature. That's a paying customer
locked out by a typo, and it's invisible without this check.

## Limits and honest caveats

- **No provider API calls at all.** This block never talks to Stripe. It can't create checkout
  sessions, sync plans, or reconcile against the provider's state. It's the *read model*; you still
  need provider integration for writes.
- **No proration, no invoices, no tax.** Deliberately out of scope — the provider does this far
  better than a block could, and getting tax wrong is a legal problem.
- **Quota checks aggregate raw events**, not rollups, so a check reflects usage from one second ago.
  Correct, but it's a `sum()` per check; a customer with millions of events per period will want a
  cached counter with the audit trail retained alongside.
- **Usage fallback window is 30 days** when no billing period is known. Counting all usage ever
  would make a long-lived account permanently over quota.
- **No seat-level tracking.** `seats` is a metric like any other; who occupies them is your domain.
- **31 unit tests cover entitlement logic exhaustively** — it's the part that's expensive to get
  wrong. The SQL paths are unverified against a live Neon project.

## Uninstall

```bash
neon-blocks rollback billing
```

**This destroys `usage_events`** — the audit trail behind invoices already sent. Export it first if
any billing dispute could still arise. The rollups are not a substitute.
