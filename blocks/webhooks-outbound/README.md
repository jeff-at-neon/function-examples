# Block 10 — Send webhooks

Sign and deliver events to customer endpoints with retries

**Block 10 of 25**, numbered in build order. Outbound webhook delivery is a well-understood problem
with mature dedicated providers, which is worth knowing before building it yourself — the value here
is that the delivery log lives in the same database as the events it describes.

## Install

```bash
neon-blocks migrate webhooks-outbound
neon function deploy webhooks-outbound --src blocks/webhooks-outbound/src

neon triggers create --function-slug webhooks-outbound --name outbound-send \
  --schedule '* * * * *' --function-path '/send'
```

```bash
# register an endpoint (returns the secret once)
curl -X POST "$URL/endpoints" \
  -d '{"subscriberRef":"acme","url":"https://acme.com/hooks","eventTypes":["order.*"]}'

# fan an event out
curl -X POST "$URL/events" \
  -d '{"eventType":"order.created","eventId":"evt_1","payload":{"id":42}}'
```

## The signature scheme is deliberately not novel

`x-webhook-signature: v1,<base64> v1,<base64>` over `<eventId>.<timestamp>.<payload>` — the
Svix/Stripe shape. Customers already have libraries and documentation for verifying it; inventing a
scheme means every customer writes new code.

- **Multiple signatures = rotation without a flag day.** We sign with every secret, the subscriber
  verifies with either. Neither side needs a synchronised cutover.
- **The event id is signed**, so a valid body cannot be replayed as a different event.
- **The timestamp is signed**, bounding replay.
- **`whsec_` secrets are base64-decoded to bytes before signing** — the same trap block 6 documents
  for inbound. Getting it wrong means *every* customer's verification fails in a way that looks like
  a bad secret.

## Circuit breaking is the load-bearing feature

Without it, 10,000 queued events for one black-holing endpoint each burn a full connection timeout,
and every other subscriber's webhooks arrive late. Isolation is the whole point:

| State | Trigger | Recovery |
|---|---|---|
| **closed** | normal | — |
| **open** | 5 consecutive failures | 5-minute cooldown, then one trial delivery |
| **half-open** | cooldown elapsed | success closes it; failure reopens |
| **disabled** | 200 consecutive failures | **manual** `POST /endpoints/:id/enable` |

Two details that matter:

**A circuit-skipped delivery does not count as an attempt.** The delivery is fine; the endpoint
isn't. Counting it would exhaust `max_attempts` while the circuit is open and dead-letter perfectly
healthy events.

**Re-enabling requeues dead deliveries.** They failed because the endpoint was broken, not because
the events were bad — and it clears the breaker so the subscriber gets an immediate retry rather than
waiting out a cooldown.

~200 failures is days of retries. Past that the endpoint is gone, not flaky, and continuing costs
money to deliver to nobody.

## SSRF protection

We make HTTPS requests to customer-supplied URLs, which is server-side request forgery by
construction. `assertSafeEndpointUrl` rejects non-https, `localhost`, `.internal`, `.local`, private
ranges (10/8, 172.16/12, 192.168/16, 127/8), IPv6 loopback and unique-local, and — most importantly —
**169.254.169.254**, the cloud metadata endpoint that can expose instance credentials.

> **This is necessary but not sufficient.** A hostname that *resolves* to a private address passes
> the check. Full protection needs DNS-level validation or an egress proxy. Stated plainly because
> believing you're protected when you aren't is worse than knowing you aren't.

## Retry and response handling

| Response | Treatment |
|---|---|
| 2xx | Delivered. |
| **3xx** | **Failure, not followed.** A redirect on a webhook endpoint is a misconfiguration, and following it could send signed payloads somewhere unauthorised. |
| 408, 429 | Retry. |
| **410 Gone** | **Permanent.** The customer is explicitly saying the endpoint no longer exists; retrying for days is rude and expensive. |
| other 4xx | Permanent. |
| 5xx, network, timeout | Retry with exponential backoff. |

**`Retry-After` is honoured** when present. A customer returning 429 with `Retry-After` is telling us
their rate limit; overriding it with our own backoff is how you get permanently throttled. Capped at
one hour so a hostile or broken header can't park a job for a week.

Response bodies are read but **bounded to 2 KB** — a subscriber returning a 100 MB error page must
not exhaust memory.

## What subscribers can see

```
GET /deliveries?subscriber=acme&limit=50
```

Plus a per-attempt history in `blocks_webhooks_outbound.attempts`. "It worked on attempt 4 after
three 502s" is the answer that resolves most support tickets, and it's only available if you record
every attempt rather than just the outcome.

```sql
SELECT * FROM blocks_webhooks_outbound.v_endpoint_health;
SELECT * FROM blocks_webhooks_outbound.v_status;
```

`oldest_due_seconds` is the number to alert on — if it climbs, the `/send` cron isn't running (child
branches inherit triggers **disabled**).

## Limits and honest caveats

- **One-minute delivery floor.** Cron-driven, so median latency is ~30s. Sub-second delivery needs
  calling `/send` directly after publishing, or native row-event triggers when they ship.
- **No per-subscriber rate limiting.** A subscriber with 100k events gets them as fast as the batch
  allows. Fair queueing across subscribers is a real gap under load.
- **Secrets are stored in plaintext** in `endpoints.secrets`. They must be to sign with them.
  Encrypt at rest via Neon, and treat this table as sensitive.
- **No delivery ordering guarantee.** Events may arrive out of order, especially after a retry.
  Subscribers must handle that — document it in *your* API docs.
- **No payload transformation or per-endpoint filtering** beyond event-type patterns.
- **34 unit tests cover signing, the breaker, retry classification, and the SSRF guard.** The
  delivery loop and SQL are unverified against a live Neon project.

## Uninstall

```bash
neon-blocks rollback webhooks-outbound
```

**Destroys endpoint registrations including signing secrets.** Subscribers can't re-derive those, so
every integration would need re-provisioning. Export `endpoints` first.
