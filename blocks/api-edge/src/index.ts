/**
 * Block 12 — API Edge Pack.
 *
 * Hashed scoped API keys, per-tenant rate limits and quotas, and idempotency-key middleware.
 *
 * Everyone rebuilds this, and everyone rebuilds it badly: keys stored in plaintext, rate limits that reset on deploy because they live in memory, idempotency that isn't. Putting it in Postgres makes the limits survive restarts and the keys survive a database dump landing in the wrong place.
 *
 * Routes:
 *   POST   /keys                  Create a key. Returns the plaintext exactly once.
 *   DELETE /keys/:id              Revoke a key.
 *   POST   /verify                Verify a key and consume rate budget.
 *   POST   /sweep                 Cron. Prune expired windows and idempotency records.
 */

import {
  assertTriggerAuthentic,
  checkHealth,
  createLogger,
  getPool,
  json,
  NotFoundError,
  parseTriggerEvent,
  problem,
  Router,
  ValidationError,
  type Logger,
} from "@neon-blocks/core";
import { autoMigrate } from "@neon-blocks/migrate";
import { loadApiEdgeConfig } from "./config.js";
import { generateKey, hashKey } from "./keys.js";
import { verifyKey } from "./verify.js";

const log: Logger = createLogger({ block: "api-edge" });

const router = new Router();

router.post("/keys", async (request) => {
  const body = await readJsonObject(request);
  const tenant = requireString(body, "tenant");
  const name = requireString(body, "name");
  const cfg = loadApiEdgeConfig();

  const { key, keyHash, keyPrefix } = generateKey(cfg.keyPrefix);

  const scopes = Array.isArray(body["scopes"])
    ? (body["scopes"] as unknown[]).filter((s): s is string => typeof s === "string")
    : [];

  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO blocks_api_edge.api_keys (tenant, name, key_hash, key_prefix, scopes, rate_limit, expires_at)
     VALUES ($1, $2, $3, $4, $5::text[], $6, $7)
     RETURNING id`,
    [
      tenant,
      name,
      keyHash,
      keyPrefix,
      scopes,
      typeof body["rateLimit"] === "number" ? body["rateLimit"] : null,
      typeof body["expiresAt"] === "string" ? body["expiresAt"] : null,
    ],
  );

  // The only time the plaintext exists. Not stored, not recoverable, not logged.
  return json({ id: rows[0]?.id, key, keyPrefix, scopes }, { status: 201 });
});

router.add("DELETE", "/keys/:id", async (_request, ctx) => {
  // Revoked, not deleted: the row is evidence of what that key did, and last_used_at is useful
  // after the fact.
  const { rowCount } = await getPool().query(
    `UPDATE blocks_api_edge.api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
    [ctx.params["id"]],
  );
  if ((rowCount ?? 0) === 0) throw new NotFoundError("No such active key");
  return json({ revoked: ctx.params["id"] });
});

router.post("/verify", async (request) => {
  const body = await readJsonObject(request);
  const key = requireString(body, "key");
  const cfg = loadApiEdgeConfig();

  const result = await verifyKey(getPool(), {
    keyHash: hashKey(key),
    windowSeconds: cfg.windowSeconds,
    defaultRateLimit: cfg.defaultRateLimit,
  });

  if (!result.ok) {
    if (result.reason === "rate_limited") {
      return json(
        { ok: false, error: "rate_limited", limit: result.limit },
        { status: 429, headers: { "Retry-After": String(result.retryAfter ?? 1) } },
      );
    }
    // unknown / revoked / expired collapse to one opaque 401: a probing client must not be able to
    // tell a revoked key from one that was never issued.
    return problem(401, "invalid_key", "The key is missing, revoked, or expired");
  }

  return json({
    ok: true,
    tenant: result.tenant,
    scopes: result.scopes,
    rateLimit: result.limit,
    remaining: result.remaining,
  });
});

router.post("/sweep", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", `/sweep expects a schedule trigger, got ${event.type}`);
  }

  const pool = getPool();

  // Both tables grow without bound otherwise. This part is complete and worth running on its own.
  const { rowCount: windows } = await pool.query(
    `DELETE FROM blocks_api_edge.rate_windows WHERE window_start < now() - interval '1 hour'`,
  );
  const { rowCount: idempotency } = await pool.query(
    `DELETE FROM blocks_api_edge.idempotency WHERE expires_at < now()`,
  );
  // A handler that crashed mid-request leaves a key stuck in_flight, blocking legitimate retries.
  const { rowCount: stuck } = await pool.query(
    `DELETE FROM blocks_api_edge.idempotency
     WHERE state = 'in_flight' AND created_at < now() - interval '15 minutes'`,
  );

  return json({
    ok: true,
    scheduledAt: event.scheduledAt,
    rateWindowsPruned: windows ?? 0,
    idempotencyPruned: idempotency ?? 0,
    stuckInFlightCleared: stuck ?? 0,
  });
});

router.get("/health", async () => {
  const report = await checkHealth(getPool(), {
    block: "api-edge",
    schema: "blocks_api_edge",
    evaluate: (status) => {
      const problems: string[] = [];

      const stale = Number(status["rate_windows_stale"] ?? 0);
      const stuck = Number(status["idempotency_stuck"] ?? 0);
      const expired = Number(status["keys_expired"] ?? 0);

      if (stale > 0) {
        problems.push(
          `${stale} stale rate window(s); the /sweep trigger may be disabled on this branch`,
        );
      }
      if (stuck > 0) {
        problems.push(
          `${stuck} idempotency record(s) stuck in_flight -- handlers crashed mid-request, and ` +
            `those keys are blocking legitimate retries`,
        );
      }
      if (expired > 0) problems.push(`${expired} key(s) are past expiry but not revoked`);
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

export default autoMigrate({
  block: "api-edge",
  migrationsUrl: new URL("./migrations/", import.meta.url),
  fetch: (request: Request): Promise<Response> => router.handle(request),
});

// Re-exported so unit tests can import the pure logic directly.
export { loadApiEdgeConfig, SPEC } from "./config.js";
export { generateKey, hashKey } from "./keys.js";
export { windowStart, rateDecision, retryAfterSeconds, verifyKey } from "./verify.js";
