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
  parseTriggerEvent,
  problem,
  Router,
  ValidationError,
  type Logger,
} from "@neon-blocks/core";
import { autoMigrate } from "@neon-blocks/migrate";
import { loadNotifyConfig } from "./config.js";
import { parseQuietHours, releaseAfterQuietHours } from "./quiet-hours.js";
import { renderTemplate } from "./render.js";
import { selectEmailProvider } from "./providers.js";
import { buildDigestMessage } from "./digest.js";

const log: Logger = createLogger({ block: "notifications" });

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

  // Quiet-hours and digest routing. Cron is UTC-only, so the local release time is computed here
  // from the user's timezone and stored; nothing is dropped, only deferred or digested.
  const cfg = loadNotifyConfig();
  let status = "pending";
  let deferredUntil: Date | null = null;

  if (pref?.cadence === "digest") {
    status = "digested";
  } else {
    const window = parseQuietHours(pref?.quiet_hours ?? cfg.quietHoursDefault);
    if (window) {
      const release = releaseAfterQuietHours(new Date(), pref?.timezone ?? "UTC", window);
      if (release) {
        status = "deferred";
        deferredUntil = release;
      }
    }
  }

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO blocks_notifications.notifications
       (user_ref, channel, category, template_code, destination, variables, dedupe_key, status, deferred_until)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      userRef, channel, category,
      typeof body["templateCode"] === "string" ? body["templateCode"] : null,
      destination,
      JSON.stringify(body["variables"] ?? {}),
      typeof body["dedupeKey"] === "string" ? body["dedupeKey"] : null,
      status,
      deferredUntil,
    ],
  );

  const id = rows[0]?.id;
  // No row means the dedupe key matched a live notification -- deliberate, not an error.
  if (!id) return json({ status: "deduplicated", id: null });
  return json({ status, id, deferredUntil }, { status: 202 });
});

router.post("/send", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", `/send expects a schedule trigger, got ${event.type}`);
  }

  const pool = getPool();
  const cfg = loadNotifyConfig();

  // Release deferred notifications whose quiet window has passed. Complete and useful on its own.
  const { rowCount: released } = await pool.query(
    `UPDATE blocks_notifications.notifications
     SET status = 'pending', deferred_until = NULL
     WHERE status = 'deferred' AND deferred_until <= now()`,
  );

  const { rows: due } = await pool.query<{
    id: string;
    channel: string;
    destination: string;
    template_code: string | null;
    variables: Record<string, unknown>;
    subject: string | null;
    tmpl_body: string | null;
  }>(
    `SELECT n.id, n.channel, n.destination, n.template_code, n.variables,
            t.subject, t.body AS tmpl_body
     FROM blocks_notifications.notifications n
     LEFT JOIN blocks_notifications.templates t ON t.code = n.template_code
     WHERE n.status = 'pending'
     ORDER BY n.created_at
     FOR UPDATE SKIP LOCKED
     LIMIT $1`,
    [cfg.batchSize],
  );

  // Render (channel-appropriate escaping) and dispatch through the provider adapter. The HTTP send
  // is the one part that cannot run offline; everything shaping the message is pure and tested.
  const provider = selectEmailProvider(cfg);
  let sent = 0;
  let failed = 0;

  for (const n of due) {
    try {
      if (n.channel !== "email") throw new Error(`no provider configured for channel "${n.channel}"`);
      if (n.tmpl_body == null) throw new Error(`template "${n.template_code}" not found`);
      const message = renderTemplate({ subject: n.subject, body: n.tmpl_body }, n.variables, n.channel);
      const { providerMessageId } = await provider.send({
        channel: n.channel,
        to: n.destination,
        from: cfg.emailFrom,
        ...(message.subject !== undefined ? { subject: message.subject } : {}),
        body: message.body,
      });
      await pool.query(
        `UPDATE blocks_notifications.notifications
         SET status = 'sent', provider_message_id = $2, sent_at = now() WHERE id = $1`,
        [n.id, providerMessageId],
      );
      sent++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Retry a few times, then dead-letter to 'failed' so a poison message stops churning.
      await pool.query(
        `UPDATE blocks_notifications.notifications
         SET attempts = attempts + 1, error = $2,
             status = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE status END
         WHERE id = $1`,
        [n.id, message],
      );
      failed++;
    }
  }

  if (due.length > 0 && cfg.emailProvider === "none") {
    log.warn("notifications are due but no email provider is configured", { due: due.length });
  }

  return json({ ok: true, scheduledAt: event.scheduledAt, released: released ?? 0, due: due.length, sent, failed });
});

router.post("/digest", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", `/digest expects a schedule trigger, got ${event.type}`);
  }

  // Collapse 'digested' notifications per (user, category) into one send. Ten comments on a thread
  // become one email, not ten.
  const pool = getPool();
  const cfg = loadNotifyConfig();
  const provider = selectEmailProvider(cfg);

  const { rows: items } = await pool.query<{
    id: string;
    user_ref: string;
    category: string;
    channel: string;
    destination: string;
    variables: Record<string, unknown>;
    subject: string | null;
    tmpl_body: string | null;
  }>(
    `SELECT n.id, n.user_ref, n.category, n.channel, n.destination, n.variables,
            t.subject, t.body AS tmpl_body
     FROM blocks_notifications.notifications n
     LEFT JOIN blocks_notifications.templates t ON t.code = n.template_code
     WHERE n.status = 'digested'
     ORDER BY n.created_at`,
  );

  // Group by (user_ref, category) — the unit a digest collapses to.
  const groups = new Map<string, typeof items>();
  for (const it of items) {
    const key = `${it.user_ref} ${it.category}`;
    const list = groups.get(key) ?? [];
    list.push(it);
    groups.set(key, list);
  }

  let digestsSent = 0;
  for (const [, group] of groups) {
    const first = group[0];
    if (!first) continue;
    const rendered = group.map((it) => ({
      subject: it.subject,
      body: it.tmpl_body ? renderTemplate({ subject: it.subject, body: it.tmpl_body }, it.variables, it.channel).body : "",
    }));
    const digest = buildDigestMessage(first.category, rendered);
    const ids = group.map((it) => it.id);
    try {
      if (first.channel !== "email") throw new Error(`digest only supports email, not "${first.channel}"`);
      const { providerMessageId } = await provider.send({
        channel: "email",
        to: first.destination,
        from: cfg.emailFrom,
        subject: digest.subject,
        body: digest.body,
      });
      await pool.query(
        `UPDATE blocks_notifications.notifications
         SET status = 'sent', provider_message_id = $2, sent_at = now() WHERE id = ANY($1)`,
        [ids, providerMessageId],
      );
      digestsSent++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await pool.query(
        `UPDATE blocks_notifications.notifications SET error = $2 WHERE id = ANY($1)`,
        [ids, message],
      );
    }
  }

  return json({ ok: true, scheduledAt: event.scheduledAt, groups: groups.size, digestsSent });
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

export default autoMigrate({
  block: "notifications",
  migrationsUrl: new URL("./migrations/", import.meta.url),
  fetch: (request: Request): Promise<Response> => router.handle(request),
});

// Re-exported so unit tests can import the pure logic directly.
export { loadNotifyConfig, SPEC } from "./config.js";
export { parseQuietHours, isWithinQuietHours, minutesUntilEnd, localMinutes, releaseAfterQuietHours } from "./quiet-hours.js";
export { escapeHtml, renderString, renderTemplate } from "./render.js";
export { buildDigestMessage } from "./digest.js";
export { selectEmailProvider } from "./providers.js";
