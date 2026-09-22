/**
 * Block 1 — Outbox + Durable Job Queue.
 *
 * The substrate the rest of the catalog sits on, and the reference implementation for every
 * convention in docs/CONVENTIONS.md.
 *
 * Routes:
 *   POST /work    cron, every minute — drain the outbox, then run due jobs
 *   POST /sweep   cron, daily — reclaim leases, purge, report DLQ depth
 *   POST /enqueue HTTP — enqueue a job from application code
 *   POST /publish HTTP — publish an event to the outbox
 *   POST /replay  HTTP — move dead jobs back to pending after a fix
 *   GET  /health  observability
 *
 * Other blocks import { queueWorker } and register their own handlers, so one deployed
 * function can serve the whole catalog's background work.
 */

import {
  assertTriggerAuthentic,
  checkHealth,
  createLogger,
  getPool,
  json,
  parseTriggerEvent,
  problem,
  Router,
  ValidationError,
  type Logger,
} from "@neon-blocks/core";
import { activeTransport, EventConsumer, publish } from "@neon-blocks/events";
import { enqueue, replayDead, Worker } from "@neon-blocks/queue";
import { loadQueueConfig } from "./config.js";
import { sweep } from "./sweep.js";

const log: Logger = createLogger({ block: "queue" });

/**
 * The shared worker. Other blocks register handlers against this instance at import time.
 *
 * A single worker rather than one per block is deliberate: 25 separate cron triggers polling
 * 25 tables every minute would cost 25× the invocations to do the same work.
 */
export const queueWorker = new Worker(log);

/**
 * The shared event consumer. Blocks subscribe by event type.
 *
 * Note this consumes `BlockEvent`, not a platform payload — the indirection that makes native
 * row triggers a transport swap (docs/ROW_EVENTS.md).
 */
export const eventConsumer = new EventConsumer(activeTransport(), log);

// The outbox drain's own job: turn events into queued jobs. Registered here so the queue block
// is useful standalone, and so the event→job bridge has exactly one implementation.
eventConsumer.on("*", "outbox_to_queue", async (event) => {
  // Idempotency key derived from the event id, so a redelivered event cannot enqueue twice.
  await enqueue(getPool(), {
    type: `event.${event.type.replace(/\./g, "_")}`,
    payload: { eventId: event.id, subject: event.subject, data: event.payload },
    idempotencyKey: `event:${event.id}`,
  });
});

const router = new Router();

router.post("/work", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", `/work expects a schedule trigger, got ${event.type}`);
  }

  const config = loadQueueConfig();
  const pool = getPool();

  // Drain the outbox first: it creates jobs, and doing it in this order means an event
  // published a moment ago can be worked in the same invocation rather than waiting a minute.
  const drained = await eventConsumer.drain(pool, {
    limit: config.outboxBatchSize,
    consumer: "queue_block",
    logger: log,
  });

  const worked = await queueWorker.runOnce(pool, {
    batchSize: config.batchSize,
    leaseSeconds: config.leaseSeconds,
    budgetMs: config.budgetMs,
    concurrency: config.concurrency,
    worker: "queue_block",
    logger: log,
  });

  return json({
    ok: true,
    scheduledAt: event.scheduledAt,
    outbox: drained,
    jobs: worked,
    // Surfaced so an operator polling /work can tell whether a per-minute cron is keeping up
    // or whether they need a shorter interval and a bigger batch.
    backlog: drained.saturated || worked.saturated,
  });
});

router.post("/sweep", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", `/sweep expects a schedule trigger, got ${event.type}`);
  }

  const config = loadQueueConfig();
  const result = await sweep(getPool(), { retentionDays: config.retentionDays, logger: log });
  return json({ ok: true, ...result });
});

router.post("/enqueue", async (request) => {
  const body = await readJsonObject(request);
  const type = requireString(body, "type");

  const result = await enqueue(getPool(), {
    type,
    payload: body["payload"] ?? {},
    ...(typeof body["idempotencyKey"] === "string"
      ? { idempotencyKey: body["idempotencyKey"] }
      : {}),
    ...(typeof body["priority"] === "number" ? { priority: body["priority"] } : {}),
    ...(typeof body["runAt"] === "string" ? { runAt: new Date(body["runAt"]) } : {}),
    ...(typeof body["maxAttempts"] === "number" ? { maxAttempts: body["maxAttempts"] } : {}),
  });

  // 200 rather than 201 on the dedupe path: nothing was created, and a client retrying a
  // request should be able to tell the difference.
  return json(
    { jobId: result.job.id, deduplicated: result.deduplicated },
    { status: result.deduplicated ? 200 : 201 },
  );
});

router.post("/publish", async (request) => {
  const body = await readJsonObject(request);
  const eventId = await publish(getPool(), {
    type: requireString(body, "type"),
    subject: requireString(body, "subject"),
    payload: body["payload"] ?? {},
    ...(typeof body["idempotencyKey"] === "string"
      ? { idempotencyKey: body["idempotencyKey"] }
      : {}),
  });
  return json({ eventId }, { status: 201 });
});

router.post("/replay", async (request) => {
  const body = await readJsonObject(request);
  const limit = typeof body["limit"] === "number" ? body["limit"] : 100;
  if (limit < 1 || limit > 10_000) {
    throw new ValidationError(`limit must be between 1 and 10000, got ${limit}`);
  }
  const replayed = await replayDead(getPool(), {
    limit,
    ...(typeof body["type"] === "string" ? { type: body["type"] } : {}),
  });
  return json({ replayed });
});

router.get("/health", async () => {
  const report = await checkHealth(getPool(), {
    block: "queue",
    schema: "blocks_queue",
    evaluate: (status) => {
      const problems: string[] = [];
      const oldestDue = Number(status["oldest_due_seconds"] ?? 0);
      const outboxLag = Number(status["outbox_lag_seconds"] ?? 0);
      const dead = Number(status["jobs_dead"] ?? 0);
      const expired = Number(status["jobs_lease_expired"] ?? 0);

      // 300s on a per-minute cron is five missed runs — past coincidence.
      if (oldestDue > 300) {
        problems.push(
          `oldest due job is ${oldestDue}s old; the /work trigger may be disabled ` +
            `(child branches inherit triggers DISABLED)`,
        );
      }
      if (outboxLag > 300) problems.push(`outbox lag is ${outboxLag}s`);
      if (dead > 0) problems.push(`${dead} dead job(s) awaiting replay`);
      if (expired > 0) problems.push(`${expired} job(s) with expired leases`);
      return problems;
    },
  });

  return json(report, { status: report.status === "ok" ? 200 : 503 });
});

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

export default {
  fetch: (request: Request): Promise<Response> => router.handle(request),
};

export { loadQueueConfig, parseConcurrency } from "./config.js";
export { sweep, reclaimExpiredLeases, purgeDeliveredEvents } from "./sweep.js";
