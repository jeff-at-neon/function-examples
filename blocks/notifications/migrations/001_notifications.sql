-- Block 13: notification engine.
--
-- Every app sends notifications and every app rebuilds preferences, quiet hours, and dedupe. The part that actually matters is restraint: the difference between a product people keep notifications on for and one they mute is entirely in the suppression logic, not the sending.

CREATE SCHEMA IF NOT EXISTS blocks_notifications;

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
  ON blocks_notifications.notifications (user_ref, created_at DESC);

-- ---------------------------------------------------------------------------
-- Observability (§10)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW blocks_notifications.v_status AS
SELECT
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
FROM blocks_notifications.notifications
;
