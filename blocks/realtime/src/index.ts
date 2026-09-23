/**
 * Block 3 — Realtime Fan-out.
 *
 * The differentiator. Neon Functions are long-running with native SSE and WebSocket upgrade, and
 * Postgres LISTEN/NOTIFY does the fan-out — so this needs no Redis and no separate always-on
 * service. A held stream bills at the *waiting* rate ($0.025/Capacity-Hour, a quarter of active),
 * which is what makes holding thousands of idle connections economical.
 *
 * Routes:
 *   GET  /subscribe  SSE stream. ?channels=a,b&actor=user:7
 *   POST /publish    publish to a channel
 *   GET  /presence   who is on a channel
 *   POST /sweep      cron — expire stale presence, prune the replay buffer
 *   GET  /health     observability
 */

import {
  assertTriggerAuthentic,
  checkHealth,
  createLogger,
  getPool,
  json,
  loadConfig,
  parseTriggerEvent,
  problem,
  Router,
  ValidationError,
  type Logger,
} from "@neon-blocks/core";
import { autoMigrate } from "@neon-blocks/migrate";
import { assertValidChannel, parseChannels } from "./channels.js";
import { join, leave, listPresence, sweep } from "./presence.js";
import { parseLastEventId, sseHeaders } from "./sse.js";
import { createEventStream } from "./stream.js";

const log: Logger = createLogger({ block: "realtime" });

const SPEC = {
  block: "realtime",
  optional: {
    REALTIME_MAX_CONNECTION_SECONDS: "900",
    REALTIME_HEARTBEAT_SECONDS: "25",
    REALTIME_MAX_CHANNELS_PER_CONNECTION: "16",
    REALTIME_PRESENCE_TTL_SECONDS: "60",
    REALTIME_EVENT_RETENTION_MINUTES: "60",
  },
} as const;

function config() {
  const raw = loadConfig(SPEC);
  const cfg = {
    maxConnectionSeconds: raw.int("REALTIME_MAX_CONNECTION_SECONDS", { min: 10, max: 3_600 }),
    heartbeatSeconds: raw.int("REALTIME_HEARTBEAT_SECONDS", { min: 5, max: 300 }),
    maxChannels: raw.int("REALTIME_MAX_CHANNELS_PER_CONNECTION", { min: 1, max: 256 }),
    presenceTtlSeconds: raw.int("REALTIME_PRESENCE_TTL_SECONDS", { min: 10, max: 3_600 }),
    eventRetentionMinutes: raw.int("REALTIME_EVENT_RETENTION_MINUTES", { min: 1, max: 10_080 }),
  };

  // A TTL below the heartbeat interval expires live connections between their own heartbeats,
  // making presence flicker. Caught at startup rather than debugged from user reports.
  if (cfg.presenceTtlSeconds <= cfg.heartbeatSeconds) {
    throw new ValidationError(
      `REALTIME_PRESENCE_TTL_SECONDS (${cfg.presenceTtlSeconds}) must exceed ` +
        `REALTIME_HEARTBEAT_SECONDS (${cfg.heartbeatSeconds}), or live connections expire ` +
        `between heartbeats and presence lists flicker.`,
    );
  }

  return cfg;
}

const router = new Router();

router.get("/subscribe", async (request, ctx) => {
  const cfg = config();
  const channels = parseChannels(ctx.url.searchParams.get("channels"), cfg.maxChannels);
  const since = parseLastEventId(request.headers.get("last-event-id"));

  // Presence is opt-in: a read-only subscriber need not identify itself.
  const actor = ctx.url.searchParams.get("actor");
  const connectionId = crypto.randomUUID();
  const pool = getPool();

  if (actor) {
    // Presence is per-channel; for a multi-channel subscription, record the first. Tracking all
    // of them would need a separate row per channel and a composite key — deliberately deferred
    // rather than half-implemented.
    await join(pool, {
      connectionId,
      channel: channels[0]!,
      actor,
      metadata: { channels },
    });
  }

  const stream = createEventStream({
    pool,
    channels,
    since,
    maxConnectionSeconds: cfg.maxConnectionSeconds,
    heartbeatSeconds: cfg.heartbeatSeconds,
    logger: log.child({ connectionId }),
    signal: request.signal,
  });

  // Remove the presence row when the client goes away, so presence is correct immediately rather
  // than after the TTL. The sweeper is the backstop for connections that die without this firing.
  if (actor) {
    request.signal.addEventListener("abort", () => {
      void leave(pool, connectionId).catch((err) => {
        log.warn("failed to remove presence on disconnect", {
          connectionId,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    });
  }

  return new Response(stream, { headers: sseHeaders() });
});

router.post("/publish", async (request) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ValidationError("Request body is not valid JSON");
  }
  if (typeof body !== "object" || body === null) {
    throw new ValidationError("Request body must be a JSON object");
  }

  const { channel, event, payload } = body as Record<string, unknown>;
  if (typeof channel !== "string") {
    throw new ValidationError('"channel" is required and must be a string');
  }
  assertValidChannel(channel);

  const { rows } = await getPool().query<{ id: string }>(
    `SELECT blocks_realtime.publish($1, $2, $3::jsonb) AS id`,
    [channel, typeof event === "string" ? event : "message", JSON.stringify(payload ?? {})],
  );

  return json({ id: rows[0]?.id ?? null, channel }, { status: 201 });
});

router.get("/presence", async (_request, ctx) => {
  const cfg = config();
  const channel = ctx.url.searchParams.get("channel");
  if (!channel) throw new ValidationError("?channel= is required");
  assertValidChannel(channel);

  const entries = await listPresence(getPool(), channel, cfg.presenceTtlSeconds);
  return json({ channel, count: entries.length, actors: entries });
});

router.post("/sweep", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", `/sweep expects a schedule trigger, got ${event.type}`);
  }

  const cfg = config();
  const result = await sweep(getPool(), {
    presenceTtlSeconds: cfg.presenceTtlSeconds,
    eventRetentionMinutes: cfg.eventRetentionMinutes,
    logger: log,
  });

  return json({ ok: true, scheduledAt: event.scheduledAt, ...result });
});

router.get("/health", async () => {
  const report = await checkHealth(getPool(), {
    block: "realtime",
    schema: "blocks_realtime",
    evaluate: (status) => {
      const problems: string[] = [];
      const stale = Number(status["connections_stale"] ?? 0);
      const expired = Number(status["buffered_events_expired"] ?? 0);

      if (stale > 0) {
        problems.push(
          `${stale} presence record(s) have no recent heartbeat; presence lists may show ` +
            `ghosts. Check the /sweep trigger is enabled on this branch.`,
        );
      }
      if (expired > 10_000) {
        problems.push(
          `${expired} events are past retention; the replay buffer is not being pruned`,
        );
      }
      return problems;
    },
  });

  return json(report, { status: report.status === "ok" ? 200 : 503 });
});

export default autoMigrate({
  block: "realtime",
  migrationsUrl: new URL("./migrations/", import.meta.url),
  fetch: (request: Request): Promise<Response> => router.handle(request),
});

export { createEventStream } from "./stream.js";
export { encodeSseFrame, sseHeartbeat, sseHeaders, parseLastEventId } from "./sse.js";
export { assertValidChannel, parseChannels, parseNotification } from "./channels.js";
export { join, leave, listPresence, sweep } from "./presence.js";
