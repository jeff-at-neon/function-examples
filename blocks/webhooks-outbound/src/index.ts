/**
 * Block 10 — Outbound Webhook Delivery.
 *
 * Your users' customers register endpoints; this signs and delivers events to them with retries,
 * per-endpoint circuit breaking, and a delivery log they can inspect. Dedicated providers exist and
 * are good at this; the reason to run it here is that the delivery log lives in the same database as
 * the events it describes, so a failed delivery can be joined back to what caused it.
 *
 * Routes:
 *   POST   /endpoints       register an endpoint
 *   DELETE /endpoints/:id   remove one
 *   POST   /endpoints/:id/enable  clear a disabled state after a fix
 *   POST   /events          fan an event out to matching endpoints
 *   POST   /send            cron — deliver due attempts
 *   GET    /deliveries      delivery log for a subscriber
 *   GET    /health          observability
 */

import {
  assertTriggerAuthentic,
  backoffMs,
  checkHealth,
  createLogger,
  getPool,
  json,
  loadConfig,
  NotFoundError,
  parseTriggerRequest,
  problem,
  Router,
  ValidationError,
  type Logger,
  type Queryable,
} from "@neon-blocks/core";
import { autoMigrate } from "@neon-blocks/migrate";
import { matchesPattern } from "@neon-blocks/events";
import {
  assertSafeEndpointUrl,
  isDelivered,
  isRetryable,
  parseRetryAfter,
  shouldDeliver,
  signPayload,
  DEFAULT_CIRCUIT,
  type EndpointHealth,
} from "./sign.js";

const log: Logger = createLogger({ block: "webhooks-outbound" });

const SPEC = {
  block: "webhooks-outbound",
  optional: {
    OUTBOUND_BATCH_SIZE: "50",
    OUTBOUND_TIMEOUT_MS: "10000",
    OUTBOUND_MAX_ATTEMPTS: "12",
    OUTBOUND_BUDGET_MS: "45000",
    OUTBOUND_MAX_PAYLOAD_BYTES: "1048576",
  },
} as const;

function config() {
  const raw = loadConfig(SPEC);
  return {
    batchSize: raw.int("OUTBOUND_BATCH_SIZE", { min: 1, max: 500 }),
    // Short by design: a slow endpoint should not hold an invocation open. 10s × 50 deliveries is
    // already over the budget, so the budget check below is what actually bounds the run.
    timeoutMs: raw.int("OUTBOUND_TIMEOUT_MS", { min: 1_000, max: 60_000 }),
    maxAttempts: raw.int("OUTBOUND_MAX_ATTEMPTS", { min: 1, max: 50 }),
    budgetMs: raw.int("OUTBOUND_BUDGET_MS", { min: 1_000, max: 300_000 }),
    maxPayloadBytes: raw.int("OUTBOUND_MAX_PAYLOAD_BYTES", { min: 1_024 }),
  };
}

const router = new Router();

router.post("/endpoints", async (request) => {
  const body = await readJsonObject(request);
  const subscriberRef = requireString(body, "subscriberRef");
  const url = requireString(body, "url");

  // SSRF guard. We make requests to customer-supplied URLs, so this is not optional.
  assertSafeEndpointUrl(url);

  const eventTypes = Array.isArray(body["eventTypes"])
    ? (body["eventTypes"] as unknown[]).filter((t): t is string => typeof t === "string")
    : [];

  // Generated rather than accepted from the caller: a subscriber-chosen secret is usually weak, and
  // this is the only time the plaintext is available to return.
  const secret = `whsec_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")}`;

  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO blocks_webhooks_outbound.endpoints
       (subscriber_ref, url, description, event_types, secrets)
     VALUES ($1, $2, $3, $4::text[], ARRAY[$5]::text[])
     RETURNING id`,
    [subscriberRef, url, body["description"] ?? null, eventTypes, secret],
  );

  return json(
    {
      id: rows[0]?.id,
      url,
      eventTypes,
      // Returned once. Storing it is the subscriber's responsibility from here.
      secret,
    },
    { status: 201 },
  );
});

router.add("DELETE", "/endpoints/:id", async (_request, ctx) => {
  const { rowCount } = await getPool().query(
    `DELETE FROM blocks_webhooks_outbound.endpoints WHERE id = $1`,
    [ctx.params["id"]],
  );
  if ((rowCount ?? 0) === 0) throw new NotFoundError("No such endpoint");
  return json({ deleted: ctx.params["id"] });
});

router.post("/endpoints/:id/enable", async (_request, ctx) => {
  // Clears both the disabled flag and the breaker, so a subscriber who has fixed their endpoint gets
  // an immediate retry rather than waiting out a cooldown.
  const { rowCount } = await getPool().query(
    `UPDATE blocks_webhooks_outbound.endpoints
     SET disabled_at = NULL, circuit_opened_at = NULL, consecutive_failures = 0, is_active = true
     WHERE id = $1`,
    [ctx.params["id"]],
  );
  if ((rowCount ?? 0) === 0) throw new NotFoundError("No such endpoint");

  // Re-arm dead deliveries too: they failed because the endpoint was broken, not because the events
  // were bad.
  const { rowCount: revived } = await getPool().query(
    `UPDATE blocks_webhooks_outbound.deliveries
     SET status = 'pending', attempts = 0, next_attempt_at = now(), error = NULL
     WHERE endpoint_id = $1 AND status = 'dead'`,
    [ctx.params["id"]],
  );

  return json({ enabled: ctx.params["id"], deliveriesRequeued: revived ?? 0 });
});

router.post("/events", async (request) => {
  const body = await readJsonObject(request);
  const eventType = requireString(body, "eventType");
  const cfg = config();

  const payload = JSON.stringify(body["payload"] ?? {});
  if (payload.length > cfg.maxPayloadBytes) {
    return problem(413, "payload_too_large", `Payload exceeds ${cfg.maxPayloadBytes} bytes`);
  }

  // Caller-supplied so fan-out is idempotent: re-publishing the same event id cannot double-deliver,
  // enforced by a unique constraint on (endpoint_id, event_id).
  const eventId = typeof body["eventId"] === "string" ? body["eventId"] : crypto.randomUUID();
  const subscriberRef = typeof body["subscriberRef"] === "string" ? body["subscriberRef"] : null;

  const pool = getPool();
  const { rows: endpoints } = await pool.query<{ id: string; event_types: string[] }>(
    `SELECT id, event_types FROM blocks_webhooks_outbound.endpoints
     WHERE is_active AND disabled_at IS NULL
       AND ($1::text IS NULL OR subscriber_ref = $1)`,
    [subscriberRef],
  );

  // Matched in-process rather than in SQL: patterns support 'order.*' wildcards, and expressing that
  // as a SQL predicate would mean LIKE against an array, which cannot use the GIN index anyway.
  const matching = endpoints.filter(
    (e) => e.event_types.length === 0 || e.event_types.some((p) => matchesPattern(eventType, p)),
  );

  let created = 0;
  for (const endpoint of matching) {
    const { rowCount } = await pool.query(
      `INSERT INTO blocks_webhooks_outbound.deliveries
         (endpoint_id, event_type, event_id, payload, max_attempts)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (endpoint_id, event_id) DO NOTHING`,
      [endpoint.id, eventType, eventId, payload, cfg.maxAttempts],
    );
    created += rowCount ?? 0;
  }

  log.info("event fanned out", { eventType, eventId, endpoints: matching.length, created });
  return json({ eventId, endpointsMatched: matching.length, deliveriesCreated: created }, { status: 202 });
});

router.post("/send", async (request) => {
  assertTriggerAuthentic(request);
  const event = await parseTriggerRequest(request);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", `/send expects a schedule trigger, got ${event.type}`);
  }

  const cfg = config();
  const pool = getPool();
  const startedAt = Date.now();

  interface DueRow {
    [column: string]: unknown;
    id: string;
    endpoint_id: string;
    event_type: string;
    event_id: string;
    payload: unknown;
    attempts: number;
    max_attempts: number;
    url: string;
    secrets: string[];
    consecutive_failures: number;
    circuit_opened_at: Date | null;
    disabled_at: Date | null;
  }

  // SKIP LOCKED so overlapping cron runs take disjoint work.
  const { rows: due } = await pool.query<DueRow>(
    `WITH claimed AS (
       SELECT d.id
       FROM blocks_webhooks_outbound.deliveries d
       JOIN blocks_webhooks_outbound.endpoints e ON e.id = d.endpoint_id
       WHERE d.status = 'pending'
         AND d.next_attempt_at <= now()
         AND e.is_active AND e.disabled_at IS NULL
       ORDER BY d.next_attempt_at
       FOR UPDATE OF d SKIP LOCKED
       LIMIT $1
     )
     SELECT d.id, d.endpoint_id, d.event_type, d.event_id, d.payload, d.attempts, d.max_attempts,
            e.url, e.secrets, e.consecutive_failures, e.circuit_opened_at, e.disabled_at
     FROM blocks_webhooks_outbound.deliveries d
     JOIN claimed ON claimed.id = d.id
     JOIN blocks_webhooks_outbound.endpoints e ON e.id = d.endpoint_id`,
    [cfg.batchSize],
  );

  let delivered = 0;
  let failed = 0;
  let skipped = 0;
  let budgetExhausted = false;

  for (const row of due) {
    if (Date.now() - startedAt > cfg.budgetMs) {
      budgetExhausted = true;
      break;
    }

    const health: EndpointHealth = {
      consecutiveFailures: row.consecutive_failures,
      circuitOpenedAt: row.circuit_opened_at,
      disabledAt: row.disabled_at,
    };

    const decision = shouldDeliver(health, new Date());
    if (!decision.deliver) {
      // Pushed out rather than failed: the delivery is fine, the endpoint is not. Counting this as an
      // attempt would exhaust max_attempts while the circuit is open and dead-letter healthy events.
      await pool.query(
        `UPDATE blocks_webhooks_outbound.deliveries
         SET next_attempt_at = now() + make_interval(secs => $2::double precision)
         WHERE id = $1`,
        [row.id, (decision.retryAfterMs ?? DEFAULT_CIRCUIT.cooldownMs) / 1000],
      );
      skipped++;
      continue;
    }

    const attempt = row.attempts + 1;
    const outcome = await attemptDelivery(row, cfg.timeoutMs);

    await pool.query(
      `INSERT INTO blocks_webhooks_outbound.attempts
         (delivery_id, attempt, response_status, duration_ms, error)
       VALUES ($1, $2, $3, $4, $5)`,
      [row.id, attempt, outcome.status, outcome.durationMs, outcome.error],
    );

    if (outcome.ok) {
      await pool.query(
        `UPDATE blocks_webhooks_outbound.deliveries
         SET status = 'delivered', attempts = $2, delivered_at = now(),
             response_status = $3, response_body = $4, error = NULL
         WHERE id = $1`,
        [row.id, attempt, outcome.status, outcome.body],
      );
      // Success closes the circuit, including from the half-open trial.
      await pool.query(
        `UPDATE blocks_webhooks_outbound.endpoints
         SET consecutive_failures = 0, circuit_opened_at = NULL, last_success_at = now()
         WHERE id = $1`,
        [row.endpoint_id],
      );
      delivered++;
      continue;
    }

    failed++;
    const retryable = outcome.status === null ? true : isRetryable(outcome.status);
    const exhausted = attempt >= row.max_attempts;

    // Honour Retry-After when the endpoint gave one: overriding a customer's stated rate limit with
    // our own backoff is how you get permanently throttled.
    const delayMs = outcome.retryAfterMs ?? backoffMs(attempt);

    await pool.query(
      `UPDATE blocks_webhooks_outbound.deliveries
       SET status = CASE WHEN $5 THEN 'dead' ELSE 'pending' END,
           attempts = $2,
           next_attempt_at = now() + make_interval(secs => $6::double precision),
           response_status = $3,
           error = $4
       WHERE id = $1`,
      [
        row.id,
        attempt,
        outcome.status,
        outcome.error ?? `HTTP ${outcome.status}`,
        !retryable || exhausted,
        delayMs / 1000,
      ],
    );

    // Track consecutive failures, opening the circuit at the threshold and disabling well past it.
    await pool.query(
      `UPDATE blocks_webhooks_outbound.endpoints
       SET consecutive_failures = consecutive_failures + 1,
           last_failure_at = now(),
           circuit_opened_at = CASE
             WHEN consecutive_failures + 1 >= $2 THEN COALESCE(circuit_opened_at, now())
             ELSE circuit_opened_at END,
           disabled_at = CASE
             WHEN consecutive_failures + 1 >= $3 THEN now()
             ELSE disabled_at END
       WHERE id = $1`,
      [row.endpoint_id, DEFAULT_CIRCUIT.failureThreshold, DEFAULT_CIRCUIT.disableThreshold],
    );
  }

  if (budgetExhausted) {
    log.capped("send budget exhausted; remaining deliveries left for the next run", {
      budgetMs: cfg.budgetMs,
      processed: delivered + failed + skipped,
      claimed: due.length,
    });
  }

  const result = { claimed: due.length, delivered, failed, skipped, budgetExhausted };
  log.info("send complete", result);
  return json({ ok: true, scheduledAt: event.scheduledAt, ...result });
});

router.get("/deliveries", async (_request, ctx) => {
  const subscriberRef = ctx.url.searchParams.get("subscriber");
  if (!subscriberRef) throw new ValidationError("?subscriber= is required");

  const limit = Math.min(Number(ctx.url.searchParams.get("limit") ?? "50"), 500);

  const { rows } = await getPool().query(
    `SELECT d.id, d.event_type, d.event_id, d.status, d.attempts, d.response_status,
            d.error, d.created_at, d.delivered_at, e.url
     FROM blocks_webhooks_outbound.deliveries d
     JOIN blocks_webhooks_outbound.endpoints e ON e.id = d.endpoint_id
     WHERE e.subscriber_ref = $1
     ORDER BY d.created_at DESC
     LIMIT $2`,
    [subscriberRef, limit],
  );

  return json({ subscriberRef, count: rows.length, deliveries: rows });
});

router.get("/health", async () => {
  const report = await checkHealth(getPool(), {
    block: "webhooks-outbound",
    schema: "blocks_webhooks_outbound",
    evaluate: (status) => {
      const problems: string[] = [];
      const disabled = Number(status["endpoints_disabled"] ?? 0);
      const circuitOpen = Number(status["endpoints_circuit_open"] ?? 0);
      const dead = Number(status["deliveries_dead"] ?? 0);
      const oldestDue = Number(status["oldest_due_seconds"] ?? 0);

      if (oldestDue > 600) {
        problems.push(
          `oldest due delivery is ${oldestDue}s old; the /send trigger may be disabled ` +
            `(child branches inherit triggers DISABLED)`,
        );
      }
      if (disabled > 0) {
        problems.push(
          `${disabled} endpoint(s) are disabled after sustained failure and need manual re-enabling`,
        );
      }
      // Distinct from disabled: these recover on their own, so it is informational rather than
      // actionable.
      if (circuitOpen > 0) problems.push(`${circuitOpen} endpoint(s) have an open circuit`);
      if (dead > 0) problems.push(`${dead} delivery/deliveries exhausted their retries`);
      return problems;
    },
  });

  return json(report, { status: report.status === "ok" ? 200 : 503 });
});

interface AttemptOutcome {
  ok: boolean;
  status: number | null;
  body: string | null;
  error: string | null;
  durationMs: number;
  retryAfterMs: number | null;
}

/**
 * Make one delivery attempt.
 *
 * Never throws: a network error is a normal outcome here, not an exception, and letting it propagate
 * would abort the whole batch and starve every other subscriber.
 */
async function attemptDelivery(
  row: { url: string; secrets: string[]; event_id: string; event_type: string; payload: unknown },
  timeoutMs: number,
): Promise<AttemptOutcome> {
  const payload = JSON.stringify(row.payload);
  const startedAt = Date.now();

  const headers = signPayload({
    payload,
    secrets: row.secrets,
    timestamp: new Date(),
    eventId: row.event_id,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(row.url, {
      method: "POST",
      headers: { ...headers, "x-webhook-event-type": row.event_type },
      body: payload,
      signal: controller.signal,
      // A redirect on a webhook endpoint is a misconfiguration, and following it could send signed
      // payloads somewhere the subscriber never authorised.
      redirect: "manual",
    });

    // Bounded read: a subscriber returning a 100 MB error page must not be able to exhaust memory.
    const body = (await response.text().catch(() => "")).slice(0, 2_000);

    return {
      ok: isDelivered(response.status),
      status: response.status,
      body,
      error: isDelivered(response.status) ? null : `HTTP ${response.status}`,
      durationMs: Date.now() - startedAt,
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after"), new Date()),
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      status: null,
      body: null,
      error: aborted ? `timed out after ${timeoutMs}ms` : err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
      retryAfterMs: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new ValidationError("Request body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value === "") {
    throw new ValidationError(`"${key}" is required and must be a non-empty string`);
  }
  return value;
}

export default autoMigrate({
  block: "webhooks-outbound",
  migrationsUrl: new URL("./migrations/", import.meta.url),
  fetch: (request: Request): Promise<Response> => router.handle(request),
});

export {
  signPayload,
  shouldDeliver,
  isDelivered,
  isRetryable,
  parseRetryAfter,
  assertSafeEndpointUrl,
  DEFAULT_CIRCUIT,
  type EndpointHealth,
  type SignedHeaders,
} from "./sign.js";
