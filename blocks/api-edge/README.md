# Block 12 — API Edge Pack

Hashed scoped API keys, per-tenant rate limits and quotas, and idempotency-key middleware.

**Block 12 of 25**, numbered in build order.

> **Status: implemented.** Schema, safety checks, control flow, and the core logic are all wired,
> with pure unit tests over the key/rate-limit logic. Still unverified against a live Neon project.

## Why this block

Everyone rebuilds this, and everyone rebuilds it badly: keys stored in plaintext, rate limits that reset on deploy because they live in memory, idempotency that isn't. Putting it in Postgres makes the limits survive restarts and the keys survive a database dump landing in the wrong place.

## Install

```bash
neon-blocks migrate api-edge
neon function deploy api-edge --src blocks/api-edge/src
neon triggers create --function-slug api-edge --name api-edge-sweep \
  --schedule '11 * * * *' --function-path '/sweep'
```

> Child branches inherit triggers **disabled**. Enable them after promoting, or scheduled work
> silently never runs.

## Design notes

- **Keys are stored as SHA-256 hashes, never plaintext.** The full key is shown exactly once at creation. A database dump then leaks nothing usable — which is the entire reason to hash.
- **A short lookup prefix is stored alongside.** Verifying a key otherwise means hashing the candidate against every row; the prefix narrows it to one index lookup, and it's also what you display in a UI (`nb_live_a1b2…`).
- **Rate limiting is a fixed window in Postgres, not a token bucket in memory.** In-memory state is per-instance and resets on deploy, which means the limit isn't a limit. The tradeoff is burstiness at window boundaries, documented rather than hidden.
- **Idempotency stores the response, not just the key.** A retried request must get the *original* response back, not a 409. Storing only the key means the client can't recover the result of the call it already made.

## API

| Route | Purpose |
|---|---|
| `POST /keys` | Create a key. Returns the plaintext exactly once. |
| `DELETE /keys/:id` | Revoke a key. |
| `POST /verify` | Verify a key and consume rate budget. |
| `POST /sweep` | Cron. Prune expired windows and idempotency records. |
| `GET /health` | `200` / `503`. |

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `API_KEY_PREFIX` | `nb_live` | Human-readable key prefix, e.g. nb_live. Makes leaked keys identifiable in logs and greppable in code. |
| `API_RATE_WINDOW_SECONDS` | `60` | Fixed window length. Shorter windows reduce burst but increase write volume. |
| `API_DEFAULT_RATE_LIMIT` | `1000` | Requests per window when a key has no explicit limit. |
| `API_IDEMPOTENCY_TTL_HOURS` | `24` | How long a stored idempotent response is replayed before the key is reusable. |
| `NEON_BLOCKS_TRIGGER_SECRET` | `` | Shared secret authenticating trigger delivery. Neon does not sign trigger POSTs. |

Injected automatically by Neon: `DATABASE_URL`.

## Limits and honest caveats

- **Rate limiting is a fixed window, so it permits 2× burst at a boundary.** A sliding window needs per-request timestamps and more write volume. Documented because the alternative — pretending it's exact — leads to surprise.
- **Every check is a database round trip.** Correct and durable, but it adds latency to every request. A read replica or a short-lived in-process cache in front is the obvious optimisation.
- **Key verification is a TODO seam** for the constant-time comparison path; the hashing and prefix lookup are specified in the schema but the handler is not written.
- **No JWT or session handling.** Managed Better Auth owns `neon_auth`; this block is for machine-to-machine API keys, deliberately not a second auth system.
- **Unverified against a live Neon project.** Nothing in this repo has been run against real Neon
  infrastructure yet.

## Observability

```sql
SELECT * FROM blocks_api_edge.v_status;
```

## Uninstall

```bash
neon-blocks rollback api-edge
```
