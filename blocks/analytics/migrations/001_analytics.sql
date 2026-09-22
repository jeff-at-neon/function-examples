-- Block 24: event analytics.
--
-- Product analytics where events live next to the rest of your data, so a funnel can join against
-- your actual customer table rather than whatever you remembered to send to a third party. The
-- hard parts are sessionization -- a gap-based window function, not a timestamp bucket -- and
-- keeping the queries fast enough to run interactively on real volume.

CREATE SCHEMA IF NOT EXISTS blocks_analytics;

-- Append-only. A table that permits updates cannot be trusted retrospectively, and every rollup
-- derived from it becomes unreproducible.
CREATE TABLE IF NOT EXISTS blocks_analytics.events (
  id            bigserial   PRIMARY KEY,

  -- anonymous_id before signup, user_ref after. Both recorded, but NOT stitched -- see limitations.
  anonymous_id  text,
  user_ref      text,

  event_name    text        NOT NULL,
  properties    jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- Client-asserted time, kept separate from received_at. Clock skew and offline buffering can put
  -- them hours apart, and conflating them makes event ordering wrong.
  occurred_at   timestamptz NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),

  -- Assigned by the rollup pass, not at ingest: sessionization needs surrounding events to know
  -- where a gap falls.
  session_id    uuid,

  -- Client-supplied dedupe key. Clients batch and retry, so without this a retried batch silently
  -- doubles every metric in it.
  dedupe_key    text,

  CONSTRAINT events_identified CHECK (anonymous_id IS NOT NULL OR user_ref IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS events_dedupe_uniq
  ON blocks_analytics.events (dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS events_occurred_idx ON blocks_analytics.events (occurred_at);
CREATE INDEX IF NOT EXISTS events_name_occurred_idx
  ON blocks_analytics.events (event_name, occurred_at);
-- Serves per-actor timelines and the sessionization window function.
CREATE INDEX IF NOT EXISTS events_actor_idx
  ON blocks_analytics.events (COALESCE(user_ref, anonymous_id), occurred_at);
-- Finds events awaiting sessionization without scanning the whole table.
CREATE INDEX IF NOT EXISTS events_unsessionized_idx
  ON blocks_analytics.events (occurred_at) WHERE session_id IS NULL;
CREATE INDEX IF NOT EXISTS events_properties_idx
  ON blocks_analytics.events USING gin (properties);

CREATE TABLE IF NOT EXISTS blocks_analytics.sessions (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_ref     text        NOT NULL,
  started_at    timestamptz NOT NULL,
  ended_at      timestamptz NOT NULL,
  event_count   integer     NOT NULL DEFAULT 0,
  -- First and last event names, which is most of what a session summary gets used for.
  entry_event   text,
  exit_event    text,

  CONSTRAINT sessions_times_sane CHECK (ended_at >= started_at)
);

CREATE INDEX IF NOT EXISTS sessions_actor_idx ON blocks_analytics.sessions (actor_ref, started_at);
CREATE INDEX IF NOT EXISTS sessions_started_idx ON blocks_analytics.sessions (started_at);

-- Daily aggregates. These outlive raw events, so long-range trends survive the retention purge.
CREATE TABLE IF NOT EXISTS blocks_analytics.daily_events (
  day           date        NOT NULL,
  event_name    text        NOT NULL,
  event_count   bigint      NOT NULL DEFAULT 0,
  -- Distinct actors, not event count: one user firing an event fifty times is one active user.
  unique_actors bigint      NOT NULL DEFAULT 0,

  PRIMARY KEY (day, event_name)
);

-- First-seen per actor, anchoring retention cohorts.
CREATE TABLE IF NOT EXISTS blocks_analytics.actor_cohorts (
  actor_ref     text        PRIMARY KEY,
  first_seen_at timestamptz NOT NULL,
  cohort_week   date        NOT NULL,
  last_seen_at  timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS actor_cohorts_week_idx
  ON blocks_analytics.actor_cohorts (cohort_week, last_seen_at);

-- ---------------------------------------------------------------------------
-- Observability (§10)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW blocks_analytics.v_status AS
SELECT
  (SELECT count(*) FROM blocks_analytics.events)                        AS events_total,
  (SELECT count(*) FROM blocks_analytics.events
     WHERE received_at > now() - interval '1 day')                      AS events_last_day,

  -- Events with no session. A growing number means the rollup cron is not running, so every
  -- session-based metric is progressively more wrong.
  (SELECT count(*) FROM blocks_analytics.events WHERE session_id IS NULL) AS events_unsessionized,

  -- Client clocks are unreliable, and a large gap between asserted and received time distorts
  -- ordering. Worth surfacing rather than discovering via a funnel that makes no sense.
  (SELECT count(*) FROM blocks_analytics.events
     WHERE occurred_at > received_at + interval '1 hour')               AS events_future_dated,

  (SELECT count(*) FROM blocks_analytics.sessions)                      AS sessions_total,
  (SELECT count(*) FROM blocks_analytics.actor_cohorts)                 AS actors_total,
  (SELECT count(*) FROM blocks_analytics.daily_events)                  AS daily_rollup_rows,
  (SELECT COALESCE(max(day)::text, 'never') FROM blocks_analytics.daily_events)
                                                                        AS latest_rollup_day,
  (SELECT count(DISTINCT event_name) FROM blocks_analytics.events)      AS event_names
;
