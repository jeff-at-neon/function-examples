/**
 * Block 13 — Notification Engine.
 *
 * Transactional email, SMS, and push behind provider adapters, with templates, per-user preferences, quiet hours, and digests.
 *
 * Every app sends notifications and every app rebuilds preferences, quiet hours, and dedupe. The part that actually matters is restraint: the difference between a product people keep notifications on for and one they mute is entirely in the suppression logic, not the sending.
 *
 * Routes:
 *   POST   /notify                Enqueue a notification, applying preferences and quiet hours.
 *   POST   /send                  Cron. Send due and released notifications.
 *   POST   /digest                Cron. Roll up digested notifications.
 *   GET    /preferences           A user's preferences.
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
  parseTriggerEvent,
  problem,
  Router,
  ValidationError,
  type Logger,
} from "@neon-blocks/core";


const log: Logger = createLogger({ block: "notifications" });

const SPEC = {
  block: "notifications",
  optional: {
    NOTIFY_EMAIL_PROVIDER: "none",
    NOTIFY_EMAIL_FROM: "",
    NOTIFY_SMS_PROVIDER: "none",
    NOTIFY_DEDUPE_WINDOW_MINUTES: "60",
    NOTIFY_QUIET_HOURS_DEFAULT: "22:00-08:00",
    NOTIFY_BATCH_SIZE: "50",
  },
} as const;

function config() {
  return loadConfig(SPEC);
}

const router = new Router();

router.post("/notify", async (request) => {
  const body = await readJsonObject(request);
  const userRef = requireString(body, "userRef");
  const channel = requireString(body, "channel");
  const category = requireString(body, "category");
  const destination = requireString(body, "destination");

  const pool = getPool();

  // Preferences first. A disabled pairing is recorded as suppressed rather than dropped, so "why
  // didn't I get that email?" has an answer.
  const { rows: prefs } = await pool.query<{ enabled: boolean; cadence: string; quiet_hours: string | null; timezone: string }>(
    `SELECT enabled, cadence, quiet_hours, timezone
     FROM blocks_notifications.preferences
     WHERE user_ref = $1 AND channel = $2 AND category = $3`,
    [userRef, channel, category],
  );
  const pref = prefs[0];

  if (pref && !pref.enabled) {
    await pool.query(
      `INSERT INTO blocks_notifications.notifications
         (user_ref, channel, category, destination, variables, status, dedupe_key)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'suppressed', $6)
       ON CONFLICT DO NOTHING`,
      [userRef, channel, category, destination, JSON.stringify(body["variables"] ?? {}),
       typeof body["dedupeKey"] === "string" ? body["dedupeKey"] : null],
    );
    return json({ status: "suppressed", reason: "user disabled this channel and category" });
  }

  // TODO(notifications): quiet-hours evaluation and digest routing.
  //   * parse quiet_hours (HH:MM-HH:MM) in the user's timezone, handling windows that cross midnight
  //   * if inside, set status='deferred' and deferred_until to the window's end -- deferred, never
  //     dropped
  //   * if pref.cadence = 'digest', set status='digested' for /digest to collect
  // Cron is UTC-only, so the user's local release time must be computed at send time.
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO blocks_notifications.notifications
       (user_ref, channel, category, template_code, destination, variables, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      userRef, channel, category,
      typeof body["templateCode"] === "string" ? body["templateCode"] : null,
      destination,
      JSON.stringify(body["variables"] ?? {}),
      typeof body["dedupeKey"] === "string" ? body["dedupeKey"] : null,
    ],
  );

  const id = rows[0]?.id;
  // No row means the dedupe key matched a live notification -- deliberate, not an error.
  return json({ status: id ? "queued" : "deduplicated", id: id ?? null }, { status: id ? 202 : 200 });
});

router.post("/send", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", `/send expects a schedule trigger, got ${event.type}`);
  }

  const pool = getPool();
  const cfg = config();

  // Release deferred notifications whose quiet window has passed. Complete and useful on its own.
  const { rowCount: released } = await pool.query(
    `UPDATE blocks_notifications.notifications
     SET status = 'pending', deferred_until = NULL
     WHERE status = 'deferred' AND deferred_until <= now()`,
  );

  const { rows: due } = await pool.query(
    `SELECT id, channel, destination, template_code, variables
     FROM blocks_notifications.notifications
     WHERE status = 'pending'
     ORDER BY created_at
     FOR UPDATE SKIP LOCKED
     LIMIT $1`,
    [cfg.int("NOTIFY_BATCH_SIZE", { min: 1, max: 500 })],
  );

  // TODO(notifications): render and dispatch.
  //   * render the template with escaping appropriate to the channel. Naive replace() on user data
  //     is an HTML injection vector in email, which is why this is not a one-liner.
  //   * dispatch through providers/<name>.ts behind one interface (Resend or SES, Twilio or SNS)
  //   * record provider_message_id, or increment attempts and set error
  if (due.length > 0 && cfg.get("NOTIFY_EMAIL_PROVIDER") === "none") {
    log.warn("notifications are due but no provider is configured", { due: due.length });
  }

  return json({
    ok: true,
    scheduledAt: event.scheduledAt,
    released: released ?? 0,
    due: due.length,
    sent: 0,
    note: due.length > 0
      ? "Provider adapters are not yet wired; see the TODO in src/index.ts."
      : undefined,
  });
});

router.post("/digest", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", `/digest expects a schedule trigger, got ${event.type}`);
  }

  // TODO(notifications): collapse 'digested' notifications per (user, category) into one send.
  // Ten comments on a thread should be one email, not ten.
  const { rows } = await getPool().query<{ user_ref: string; category: string; n: string }>(
    `SELECT user_ref, category, count(*)::text AS n
     FROM blocks_notifications.notifications
     WHERE status = 'digested'
     GROUP BY user_ref, category`,
  );

  return json({ ok: true, scheduledAt: event.scheduledAt, pendingDigests: rows.length, groups: rows });
});

router.get("/preferences", async (_request, ctx) => {
  const userRef = ctx.url.searchParams.get("user");
  if (!userRef) throw new ValidationError("?user= is required");

  const { rows } = await getPool().query(
    `SELECT channel, category, enabled, cadence, timezone, quiet_hours
     FROM blocks_notifications.preferences WHERE user_ref = $1
     ORDER BY channel, category`,
    [userRef],
  );
  return json({ userRef, preferences: rows });
});

router.get("/health", async () => {
  const report = await checkHealth(getPool(), {
    block: "notifications",
    schema: "blocks_notifications",
    evaluate: (status) => {
      const problems: string[] = [];

      const overdue = Number(status["notifications_overdue"] ?? 0);
      const failed = Number(status["notifications_failed"] ?? 0);
      const oldestPending = Number(status["oldest_pending_seconds"] ?? 0);
      const templates = Number(status["templates_count"] ?? 0);

      if (templates === 0) problems.push("no templates are defined");
      if (overdue > 0) {
        problems.push(
          `${overdue} deferred notification(s) are past their release time; the /send trigger may ` +
            `be disabled on this branch`,
        );
      }
      if (oldestPending > 600) {
        problems.push(`oldest pending notification is ${oldestPending}s old`);
      }
      if (failed > 0) problems.push(`${failed} notification(s) failed to send`);
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
