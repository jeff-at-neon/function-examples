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
 *
 * STATUS: scaffold. The schema, safety checks, and control flow are real; the marked TODO seams are
 * the remaining work. Endpoints that are not implemented return 501 with a specific explanation
 * rather than failing in a way that looks like a bug.
 */

import {
  assertTriggerAuthentic,
  checkHealth,
  createLogger,
  getPool,
  json,
  loadConfig,
  NotFoundError,
  parseTriggerEvent,
  problem,
  Router,
  ValidationError,
  type Logger,
} from "@neon-blocks/core";
import { createHash, randomBytes } from "node:crypto";

const log: Logger = createLogger({ block: "api-edge" });

const SPEC = {
  block: "api-edge",
  optional: {
    API_KEY_PREFIX: "nb_live",
    API_RATE_WINDOW_SECONDS: "60",
    API_DEFAULT_RATE_LIMIT: "1000",
    API_IDEMPOTENCY_TTL_HOURS: "24",
  },
} as const;

function config() {
  return loadConfig(SPEC);
}

const router = new Router();

router.post("/keys", async (request) => {
  const body = await readJsonObject(request);
  const tenant = requireString(body, "tenant");
  const name = requireString(body, "name");
  const cfg = config();

  // 32 bytes of CSPRNG output. base64url so the key is copy-pasteable without escaping.
  const secret = randomBytes(32).toString("base64url");
  const key = `${cfg.get("API_KEY_PREFIX")}_${secret}`;
  const keyHash = createHash("sha256").update(key).digest("hex");
  // Long enough to be selective, short enough to be safe to display and log.
  const keyPrefix = key.slice(0, cfg.get("API_KEY_PREFIX").length + 9);

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
  const keyHash = createHash("sha256").update(key).digest("hex");

  // TODO(api-edge): verification and rate consumption.
  //   1. SELECT by key_hash (already unique-indexed), checking revoked_at and expires_at
  //   2. atomically increment the current fixed window:
  //        INSERT INTO rate_windows (subject, window_start, count) VALUES (...)
  //        ON CONFLICT (subject, window_start) DO UPDATE SET count = rate_windows.count + 1
  //        RETURNING count
  //      One statement, so concurrent requests cannot both read an under-limit count.
  //   3. compare against rate_limit or API_DEFAULT_RATE_LIMIT and return 429 with Retry-After
  //   4. update last_used_at (consider throttling this write -- it is one per request otherwise)
  void keyHash;
  return problem(
    501,
    "not_implemented",
    "Key verification is not yet wired. See the TODO in src/index.ts. The schema and the atomic " +
      "window-increment statement are specified there.",
  );
});

router.post("/sweep", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", `/sweep expects a schedule trigger, got ${event.type}`);
  }

  const pool = getPool();
  const cfg = config();

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

  void cfg;
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

export default {
  fetch: (request: Request): Promise<Response> => router.handle(request),
};
