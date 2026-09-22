/**
 * Block 6 — Inbound Webhook Kit.
 *
 * Signature verification per provider, a raw archive, dedupe, and replay. Everyone needs this and
 * everyone gets the verification subtly wrong — see src/verify.ts for the four classic mistakes.
 *
 * Routes:
 *   POST /hooks/:provider  receive a webhook
 *   POST /replay           re-publish archived deliveries after a handler fix
 *   GET  /health           observability
 *
 * Deliberately has no cron trigger: nothing here drifts. The archive is written synchronously in
 * the same request that verifies the signature, so there is no missed-delivery state to reconcile.
 */

import { createHash } from "node:crypto";
import {
  checkHealth,
  createLogger,
  getPool,
  json,
  loadConfig,
  problem,
  Router,
  ValidationError,
  type Logger,
  type Queryable,
} from "@neon-blocks/core";
import { publish } from "@neon-blocks/events";
import { verifyWebhook, type Provider } from "./verify.js";

const log: Logger = createLogger({ block: "webhooks-inbound" });

const PROVIDERS: readonly Provider[] = ["stripe", "github", "shopify", "slack", "clerk", "generic"];

const SPEC = {
  block: "webhooks-inbound",
  optional: {
    WEBHOOK_TOLERANCE_SECONDS: "300",
    WEBHOOK_MAX_BODY_BYTES: "1048576",
    WEBHOOK_DEDUPE_WINDOW_MINUTES: "60",
    WEBHOOK_SIGNATURE_HEADER: "x-signature",
    WEBHOOK_SIGNATURE_PREFIX: "",
  },
} as const;

/**
 * Per-provider secret, from `WEBHOOK_SECRET_<PROVIDER>`.
 *
 * Separate variables rather than one shared secret: each provider issues its own, and a single
 * value would mean rotating one breaks all of them.
 */
function secretFor(provider: Provider, env: NodeJS.ProcessEnv = process.env): string {
  const name = `WEBHOOK_SECRET_${provider.toUpperCase()}`;
  const secret = env[name];
  if (!secret) {
    throw new ValidationError(
      `${name} is not set, so ${provider} webhooks cannot be verified. An unverified webhook ` +
        `endpoint accepts forged events, so this block refuses to process them.`,
    );
  }
  return secret;
}

const router = new Router();

router.post("/hooks/:provider", async (request, ctx) => {
  const raw = ctx.params["provider"]!;
  if (!PROVIDERS.includes(raw as Provider)) {
    return problem(404, "unknown_provider", `No verifier for "${raw}". Known: ${PROVIDERS.join(", ")}`);
  }
  const provider = raw as Provider;
  const cfg = loadConfig(SPEC);
  const maxBytes = cfg.int("WEBHOOK_MAX_BODY_BYTES", { min: 1_024 });

  // Read as text, once, and verify against exactly these bytes. request.json() would discard the
  // original formatting and every signature would fail.
  const rawBody = await request.text();
  if (rawBody.length > maxBytes) {
    return problem(413, "body_too_large", `Body exceeds ${maxBytes} bytes`);
  }

  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  const pool = getPool();

  const result = verifyWebhook({
    provider,
    rawBody,
    headers: request.headers,
    secret: secretFor(provider),
    toleranceSeconds: cfg.int("WEBHOOK_TOLERANCE_SECONDS", { min: 0, max: 86_400 }),
    signatureHeader: cfg.get("WEBHOOK_SIGNATURE_HEADER"),
    ...(cfg.get("WEBHOOK_SIGNATURE_PREFIX")
      ? { signaturePrefix: cfg.get("WEBHOOK_SIGNATURE_PREFIX") }
      : {}),
  });

  if (!result.ok) {
    // Archived, not discarded: a burst of rejections means a rotated secret or a probe, and
    // throwing them away hides the signal.
    await archive(pool, {
      provider,
      providerEventId: null,
      eventType: null,
      rawBody,
      bodyHash,
      headers: safeHeaders(request.headers),
      status: "rejected",
      rejectReason: result.reason,
      eventAt: null,
    });

    log.warn("webhook rejected", { provider, reason: result.reason });
    // 401 rather than 400: providers treat 4xx as permanent and stop retrying, which is right —
    // retrying an unverifiable request will never succeed.
    return problem(401, "signature_invalid", result.reason);
  }

  const eventType = extractEventType(provider, rawBody, request.headers);
  const duplicate = await findDuplicate(pool, {
    provider,
    providerEventId: result.eventId,
    bodyHash,
    windowMinutes: cfg.int("WEBHOOK_DEDUPE_WINDOW_MINUTES", { min: 1, max: 43_200 }),
  });

  if (duplicate) {
    await archive(pool, {
      provider,
      providerEventId: result.eventId,
      eventType,
      rawBody,
      bodyHash,
      headers: safeHeaders(request.headers),
      status: "duplicate",
      rejectReason: null,
      eventAt: result.timestamp,
    });
    log.info("duplicate webhook ignored", { provider, providerEventId: result.eventId });
    // 200 so the provider stops retrying. It already succeeded once.
    return json({ ok: true, duplicate: true, originalId: duplicate });
  }

  const deliveryId = await archive(pool, {
    provider,
    providerEventId: result.eventId,
    eventType,
    rawBody,
    bodyHash,
    headers: safeHeaders(request.headers),
    status: "accepted",
    rejectReason: null,
    eventAt: result.timestamp,
  });

  // Hand off to the outbox rather than processing inline: the provider is waiting on this response,
  // and most have short timeouts. Work happens in the queue.
  await publish(pool, {
    type: `webhook.${provider}.received`,
    subject: result.eventId ?? deliveryId,
    payload: { deliveryId, provider, eventType, providerEventId: result.eventId },
    idempotencyKey: `webhook:${provider}:${result.eventId ?? bodyHash}`,
  });

  log.info("webhook accepted", { provider, eventType, deliveryId });
  return json({ ok: true, deliveryId }, { status: 202 });
});

router.post("/replay", async (request) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ValidationError("Request body is not valid JSON");
  }
  const { provider, since, limit } = (body ?? {}) as Record<string, unknown>;

  const count = typeof limit === "number" ? limit : 100;
  if (count < 1 || count > 1_000) {
    throw new ValidationError("limit must be between 1 and 1000");
  }

  const pool = getPool();
  const { rows } = await pool.query<{ id: string; provider: string; provider_event_id: string | null }>(
    `UPDATE blocks_webhooks_inbound.deliveries
     SET replayed_at = now(), replay_count = replay_count + 1
     WHERE id IN (
       SELECT id FROM blocks_webhooks_inbound.deliveries
       WHERE status = 'accepted'
         AND ($1::text IS NULL OR provider = $1)
         AND ($2::timestamptz IS NULL OR received_at >= $2)
       ORDER BY received_at
       LIMIT $3
     )
     RETURNING id, provider, provider_event_id`,
    [
      typeof provider === "string" ? provider : null,
      typeof since === "string" ? since : null,
      count,
    ],
  );

  for (const row of rows) {
    await publish(pool, {
      type: `webhook.${row.provider}.received`,
      subject: row.provider_event_id ?? row.id,
      payload: { deliveryId: row.id, provider: row.provider, replay: true },
      // Replay-count-suffixed so a second replay is not deduplicated against the first.
      idempotencyKey: `webhook-replay:${row.id}:${Date.now()}`,
    });
  }

  log.info("replayed deliveries", { count: rows.length });
  return json({ replayed: rows.length });
});

router.get("/health", async () => {
  const report = await checkHealth(getPool(), {
    block: "webhooks-inbound",
    schema: "blocks_webhooks_inbound",
    evaluate: (status) => {
      const problems: string[] = [];
      const rejectedRecently = Number(status["deliveries_rejected_last_hour"] ?? 0);

      if (rejectedRecently > 0) {
        problems.push(
          `${rejectedRecently} webhook(s) failed verification in the last hour. The usual cause ` +
            `is a signing secret that was rotated at the provider but not updated here; check ` +
            `blocks_webhooks_inbound.v_by_provider for which one.`,
        );
      }
      return problems;
    },
  });

  return json(report, { status: report.status === "ok" ? 200 : 503 });
});

interface ArchiveRow {
  provider: string;
  providerEventId: string | null;
  eventType: string | null;
  rawBody: string;
  bodyHash: string;
  headers: Record<string, string>;
  status: string;
  rejectReason: string | null;
  eventAt: Date | null;
}

async function archive(db: Queryable, row: ArchiveRow): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO blocks_webhooks_inbound.deliveries
       (provider, provider_event_id, event_type, raw_body, body_sha256, headers,
        status, reject_reason, event_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
     RETURNING id`,
    [
      row.provider,
      row.providerEventId,
      row.eventType,
      row.rawBody,
      row.bodyHash,
      JSON.stringify(row.headers),
      row.status,
      row.rejectReason,
      row.eventAt,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("Failed to archive webhook delivery");
  return id;
}

/**
 * Find a prior accepted delivery of the same event.
 *
 * Prefers the provider's event id. Falls back to a body hash within a window for providers that
 * send none — identical bytes arriving twice in an hour is a redelivery, not a coincidence.
 */
async function findDuplicate(
  db: Queryable,
  opts: {
    provider: string;
    providerEventId: string | null;
    bodyHash: string;
    windowMinutes: number;
  },
): Promise<string | null> {
  if (opts.providerEventId) {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM blocks_webhooks_inbound.deliveries
       WHERE provider = $1 AND provider_event_id = $2 AND status = 'accepted'
       LIMIT 1`,
      [opts.provider, opts.providerEventId],
    );
    return rows[0]?.id ?? null;
  }

  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM blocks_webhooks_inbound.deliveries
     WHERE provider = $1 AND body_sha256 = $2 AND status = 'accepted'
       AND received_at > now() - make_interval(mins => $3::int)
     LIMIT 1`,
    [opts.provider, opts.bodyHash, opts.windowMinutes],
  );
  return rows[0]?.id ?? null;
}

/** Best-effort event type, for routing and for the archive. */
function extractEventType(provider: Provider, rawBody: string, headers: Headers): string | null {
  switch (provider) {
    case "github":
      return headers.get("x-github-event");
    case "shopify":
      return headers.get("x-shopify-topic");
    default: {
      // Stripe and Clerk both use a top-level "type". Read it without parsing, since the raw bytes
      // are what matter and this runs on a payload we have only just decided to trust.
      const match = /"type"\s*:\s*"([^"\\]*)"/.exec(rawBody);
      return match?.[1] ?? null;
    }
  }
}

/**
 * Capture headers for the archive, excluding secrets.
 *
 * Signature headers are kept — they are not secrets, and retaining them is what makes an archived
 * delivery independently re-verifiable later. Authorization and cookies are dropped.
 */
function safeHeaders(headers: Headers): Record<string, string> {
  const excluded = new Set(["authorization", "cookie", "proxy-authorization"]);
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (!excluded.has(key.toLowerCase())) out[key] = value;
  });
  return out;
}

export default {
  fetch: (request: Request): Promise<Response> => router.handle(request),
};

export {
  verifyWebhook,
  verifyStripe,
  verifyGithub,
  verifyShopify,
  verifySlack,
  verifyClerk,
  verifyGeneric,
  safeEqual,
  type Provider,
  type VerifyResult,
} from "./verify.js";
