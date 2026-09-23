import { INJECTED_DB, INJECTED_STORAGE, INJECTED_AI, TRIGGER_SECRET } from "./lib/generate.mjs";

/** @type {BlockSpec[]} */
export const SPECS = [
  {
    slug: "notifications",
    rank: 13,
    name: "Notification Engine",
    summary: "Transactional email, SMS, and push behind provider adapters, with templates, per-user preferences, quiet hours, and digests.",
    billing: "free",
    capabilities: ["postgres", "neon_auth"],
    dependsOn: ["queue"],
    why:
      "Every app sends notifications and every app rebuilds preferences, quiet hours, and dedupe. The " +
      "part that actually matters is restraint: the difference between a product people keep " +
      "notifications on for and one they mute is entirely in the suppression logic, not the sending.",
    notes: [
      "**Preferences are per (user, channel, category).** A single on/off switch means users mute everything to stop one noisy category. Granularity is what keeps notifications enabled.",
      "**Quiet hours defer, never drop.** A notification suppressed at 2am is sent at 8am. Dropping it silently is how users miss things that mattered, and it's indistinguishable from a bug.",
      "**Dedupe on a caller-supplied key within a window.** Three password-reset requests in a minute should produce one email, and the queue's at-least-once delivery makes this mandatory rather than nice.",
      "**Digest rollups collapse N notifications into one.** Ten comments on a thread is one email, not ten — and the digest window is per category, since a security alert should never be digested.",
      "**Providers sit behind one interface** (`providers/`). Resend *or* SES, Twilio *or* SNS. A block that only works with one vendor's key is not reusable.",
    ],
    limits: [
      "**Provider adapters are TODO seams.** The interface and the dispatch logic are specified; the HTTP calls to Resend/SES/Twilio are not written. This is deliberate — the value is in preferences and suppression, not in wrapping a send API.",
      "**Template rendering is not implemented.** The schema holds templates and a variables jsonb; interpolation needs a real engine with escaping. Naive `replace()` on user data is an injection vector in HTML email.",
      "**Timezone handling for quiet hours requires a per-user timezone**, stored but unused until rendering lands. Cron is UTC-only, so a user's 8am is computed at send time, not scheduled.",
      "**No unsubscribe link generation or bounce handling.** Both are legally significant for bulk email and deliberately out of scope for a transactional block.",
    ],
    env: [
      INJECTED_DB,
      { name: "NOTIFY_EMAIL_PROVIDER", description: "Adapter to use: resend, ses, or none.", required: false, default: "none" },
      { name: "NOTIFY_EMAIL_FROM", description: "Default From address.", required: false, default: "" },
      { name: "NOTIFY_SMS_PROVIDER", description: "Adapter to use: twilio, sns, or none.", required: false, default: "none" },
      { name: "NOTIFY_DEDUPE_WINDOW_MINUTES", description: "Window in which an identical dedupe key is suppressed.", required: false, default: "60" },
      { name: "NOTIFY_QUIET_HOURS_DEFAULT", description: "Default quiet window as HH:MM-HH:MM in the user's timezone. Empty disables.", required: false, default: "22:00-08:00" },
      { name: "NOTIFY_BATCH_SIZE", description: "Notifications sent per invocation.", required: false, default: "50" },
      TRIGGER_SECRET,
    ],
    triggers: [
      { type: "schedule", cron: "* * * * *", functionPath: "/send", description: "Send due notifications, including those deferred past quiet hours." },
      { type: "schedule", cron: "19 8 * * *", functionPath: "/digest", description: "Build and send digest rollups." },
    ],
    tables: `
CREATE TABLE IF NOT EXISTS blocks_notifications.templates (
  code        text        PRIMARY KEY,
  channel     text        NOT NULL,
  category    text        NOT NULL,
  subject     text,
  body        text        NOT NULL,
  -- Variable names the template expects, so a missing one fails at send time with a clear message
  -- rather than rendering "Hello undefined".
  variables   text[]      NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT templates_channel_valid CHECK (channel IN ('email', 'sms', 'push', 'inapp'))
);

-- Per (user, channel, category). A single on/off switch means users mute everything to stop one
-- noisy category, so granularity is what keeps notifications enabled at all.
CREATE TABLE IF NOT EXISTS blocks_notifications.preferences (
  user_ref    text        NOT NULL,
  channel     text        NOT NULL,
  category    text        NOT NULL,
  enabled     boolean     NOT NULL DEFAULT true,
  -- 'immediate' or 'digest'. Per category, because a security alert must never be digested.
  cadence     text        NOT NULL DEFAULT 'immediate',
  timezone    text        NOT NULL DEFAULT 'UTC',
  -- Overrides NOTIFY_QUIET_HOURS_DEFAULT. Empty string means no quiet hours for this pairing.
  quiet_hours text,

  PRIMARY KEY (user_ref, channel, category),
  CONSTRAINT preferences_cadence_valid CHECK (cadence IN ('immediate', 'digest'))
);

CREATE TABLE IF NOT EXISTS blocks_notifications.notifications (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_ref      text        NOT NULL,
  channel       text        NOT NULL,
  category      text        NOT NULL,
  template_code text        REFERENCES blocks_notifications.templates(code),

  -- Where it goes: email address, phone number, device token. Resolved at enqueue time so a later
  -- profile change does not redirect a pending notification.
  destination   text        NOT NULL,
  variables     jsonb       NOT NULL DEFAULT '{}'::jsonb,

  status        text        NOT NULL DEFAULT 'pending',
  -- Set when quiet hours defer a notification. It is sent later, never dropped: silently dropping
  -- is how users miss things, and it is indistinguishable from a bug.
  deferred_until timestamptz,
  -- Caller-supplied. Three password resets in a minute should produce one email, and the queue's
  -- at-least-once delivery makes this mandatory rather than optional.
  dedupe_key    text,

  attempts      integer     NOT NULL DEFAULT 0,
  provider      text,
  provider_message_id text,
  error         text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,

  CONSTRAINT notifications_status_valid
    CHECK (status IN ('pending', 'deferred', 'sent', 'failed', 'suppressed', 'digested'))
);

CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_uniq
  ON blocks_notifications.notifications (user_ref, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'deferred', 'sent');

CREATE INDEX IF NOT EXISTS notifications_due_idx
  ON blocks_notifications.notifications (created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS notifications_deferred_idx
  ON blocks_notifications.notifications (deferred_until)
  WHERE status = 'deferred';
CREATE INDEX IF NOT EXISTS notifications_user_idx
  ON blocks_notifications.notifications (user_ref, created_at DESC);`,
    statusView: `
  count(*)                                                AS notifications_total,
  count(*) FILTER (WHERE status = 'pending')               AS notifications_pending,
  count(*) FILTER (WHERE status = 'deferred')              AS notifications_deferred,
  count(*) FILTER (WHERE status = 'sent')                  AS notifications_sent,
  count(*) FILTER (WHERE status = 'failed')                AS notifications_failed,
  count(*) FILTER (WHERE status = 'suppressed')            AS notifications_suppressed,
  -- Deferred past their own release time: the /send cron is not running.
  count(*) FILTER (WHERE status = 'deferred' AND deferred_until < now()) AS notifications_overdue,
  -- Age of the oldest unsent notification. The number to alert on.
  COALESCE(EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE status = 'pending')))::bigint, 0)
                                                          AS oldest_pending_seconds,
  (SELECT count(*) FROM blocks_notifications.templates)    AS templates_count
FROM blocks_notifications.notifications`,
    dropOrder: ["TABLE blocks_notifications.notifications", "TABLE blocks_notifications.preferences", "TABLE blocks_notifications.templates"],
    routes: [
      { method: "POST", path: "/notify", purpose: "Enqueue a notification, applying preferences and quiet hours." },
      { method: "POST", path: "/send", purpose: "Cron. Send due and released notifications." },
      { method: "POST", path: "/digest", purpose: "Cron. Roll up digested notifications." },
      { method: "GET", path: "/preferences", purpose: "A user's preferences." },
    ],
    imports: [],
    handlerBody: `
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
    \`SELECT enabled, cadence, quiet_hours, timezone
     FROM blocks_notifications.preferences
     WHERE user_ref = $1 AND channel = $2 AND category = $3\`,
    [userRef, channel, category],
  );
  const pref = prefs[0];

  if (pref && !pref.enabled) {
    await pool.query(
      \`INSERT INTO blocks_notifications.notifications
         (user_ref, channel, category, destination, variables, status, dedupe_key)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'suppressed', $6)
       ON CONFLICT DO NOTHING\`,
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
    \`INSERT INTO blocks_notifications.notifications
       (user_ref, channel, category, template_code, destination, variables, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT DO NOTHING
     RETURNING id\`,
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
    return problem(400, "wrong_trigger", \`/send expects a schedule trigger, got \${event.type}\`);
  }

  const pool = getPool();
  const cfg = config();

  // Release deferred notifications whose quiet window has passed. Complete and useful on its own.
  const { rowCount: released } = await pool.query(
    \`UPDATE blocks_notifications.notifications
     SET status = 'pending', deferred_until = NULL
     WHERE status = 'deferred' AND deferred_until <= now()\`,
  );

  const { rows: due } = await pool.query(
    \`SELECT id, channel, destination, template_code, variables
     FROM blocks_notifications.notifications
     WHERE status = 'pending'
     ORDER BY created_at
     FOR UPDATE SKIP LOCKED
     LIMIT $1\`,
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
    return problem(400, "wrong_trigger", \`/digest expects a schedule trigger, got \${event.type}\`);
  }

  // TODO(notifications): collapse 'digested' notifications per (user, category) into one send.
  // Ten comments on a thread should be one email, not ten.
  const { rows } = await getPool().query<{ user_ref: string; category: string; n: string }>(
    \`SELECT user_ref, category, count(*)::text AS n
     FROM blocks_notifications.notifications
     WHERE status = 'digested'
     GROUP BY user_ref, category\`,
  );

  return json({ ok: true, scheduledAt: event.scheduledAt, pendingDigests: rows.length, groups: rows });
});

router.get("/preferences", async (_request, ctx) => {
  const userRef = ctx.url.searchParams.get("user");
  if (!userRef) throw new ValidationError("?user= is required");

  const { rows } = await getPool().query(
    \`SELECT channel, category, enabled, cadence, timezone, quiet_hours
     FROM blocks_notifications.preferences WHERE user_ref = $1
     ORDER BY channel, category\`,
    [userRef],
  );
  return json({ userRef, preferences: rows });
});`,
    healthEval: `
      const overdue = Number(status["notifications_overdue"] ?? 0);
      const failed = Number(status["notifications_failed"] ?? 0);
      const oldestPending = Number(status["oldest_pending_seconds"] ?? 0);
      const templates = Number(status["templates_count"] ?? 0);

      if (templates === 0) problems.push("no templates are defined");
      if (overdue > 0) {
        problems.push(
          \`\${overdue} deferred notification(s) are past their release time; the /send trigger may \` +
            \`be disabled on this branch\`,
        );
      }
      if (oldestPending > 600) {
        problems.push(\`oldest pending notification is \${oldestPending}s old\`);
      }
      if (failed > 0) problems.push(\`\${failed} notification(s) failed to send\`);`,
  },
];
