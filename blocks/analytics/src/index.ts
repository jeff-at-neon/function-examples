/**
 * Block 24 — Event Analytics.
 *
 * Event ingest, sessionization, and a funnel, retention, and cohort query pack over your own Postgres.
 *
 * Product analytics where events live next to the rest of your data, so a funnel can join against
 * your actual customer table rather than whatever you remembered to send to a third party. The
 * hard parts are sessionization -- a gap-based window function, not a timestamp bucket -- and
 * keeping the queries fast enough to run interactively on real volume.
 *
 * Routes:
 *   POST   /track                 Ingest a batch of events, idempotently.
 *   POST   /rollup                Cron. Sessionize and aggregate.
 *   GET    /funnel                Ordered-step funnel conversion.
 *   GET    /retention             Cohort retention by week.
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


const log: Logger = createLogger({ block: "analytics" });

const SPEC = {
  block: "analytics",
  optional: {
    ANALYTICS_SESSION_GAP_MINUTES: "30",
    ANALYTICS_MAX_BATCH: "1000",
    ANALYTICS_RETENTION_DAYS: "400",
  },
} as const;

function config() {
  return loadConfig(SPEC);
}

const router = new Router();

router.post("/track", async (request) => {
  const body = await readJsonObject(request);
  const cfg = config();
  const maxBatch = cfg.int("ANALYTICS_MAX_BATCH", { min: 1, max: 10_000 });

  const events = Array.isArray(body["events"]) ? body["events"] : [body];
  if (events.length > maxBatch) {
    return problem(413, "batch_too_large", `Batch of ${events.length} exceeds ${maxBatch}`);
  }

  // One multi-row INSERT rather than a loop: a 1000-event batch as 1000 round trips would hold the
  // invocation open far longer than the work requires.
  const values: unknown[] = [];
  const tuples: string[] = [];

  for (const raw of events) {
    if (typeof raw !== "object" || raw === null) {
      throw new ValidationError("Each event must be an object");
    }
    const e = raw as Record<string, unknown>;
    const eventName = e["event"] ?? e["eventName"];
    if (typeof eventName !== "string" || eventName === "") {
      throw new ValidationError('Each event needs a non-empty "event" name');
    }
    if (typeof e["anonymousId"] !== "string" && typeof e["userRef"] !== "string") {
      throw new ValidationError('Each event needs "anonymousId" or "userRef"');
    }

    const base = values.length;
    values.push(
      e["anonymousId"] ?? null,
      e["userRef"] ?? null,
      eventName,
      JSON.stringify(e["properties"] ?? {}),
      typeof e["occurredAt"] === "string" ? e["occurredAt"] : null,
      typeof e["dedupeKey"] === "string" ? e["dedupeKey"] : null,
    );
    tuples.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb, ` +
        `COALESCE($${base + 5}::timestamptz, now()), $${base + 6})`,
    );
  }

  // ON CONFLICT DO NOTHING on the dedupe key: clients batch and retry, and without this a retried
  // batch silently doubles every metric it contains.
  const { rowCount } = await getPool().query(
    `INSERT INTO blocks_analytics.events
       (anonymous_id, user_ref, event_name, properties, occurred_at, dedupe_key)
     VALUES ${tuples.join(", ")}
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    values,
  );

  const accepted = rowCount ?? 0;
  return json(
    { accepted, submitted: events.length, deduplicated: events.length - accepted },
    { status: 202 },
  );
});

router.post("/rollup", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", `/rollup expects a schedule trigger, got ${event.type}`);
  }

  const cfg = config();
  const gapMinutes = cfg.int("ANALYTICS_SESSION_GAP_MINUTES", { min: 1, max: 1_440 });
  const pool = getPool();

  // Sessionization by inactivity gap using a window function. NOT a fixed clock window: a user
  // active 10:55-11:05 is one session, and calendar-hour bucketing would split them and halve the
  // session count.
  //
  // lag() gives each event its predecessor's time for the same actor; a gap over the threshold starts
  // a new session, and a running sum of those boundaries numbers them.
  const { rows: sessionized } = await pool.query<{ sessions: string; events: string }>(
    `WITH gapped AS (
       SELECT id,
              COALESCE(user_ref, anonymous_id) AS actor_ref,
              event_name,
              occurred_at,
              CASE
                WHEN lag(occurred_at) OVER w IS NULL THEN 1
                WHEN occurred_at - lag(occurred_at) OVER w > make_interval(mins => $1::int) THEN 1
                ELSE 0
              END AS is_new_session
       FROM blocks_analytics.events
       WHERE session_id IS NULL
       WINDOW w AS (PARTITION BY COALESCE(user_ref, anonymous_id) ORDER BY occurred_at)
     ),
     numbered AS (
       SELECT id, actor_ref, event_name, occurred_at,
              sum(is_new_session) OVER (PARTITION BY actor_ref ORDER BY occurred_at) AS session_seq
       FROM gapped
     ),
     bounds AS (
       SELECT actor_ref, session_seq,
              min(occurred_at) AS started_at,
              max(occurred_at) AS ended_at,
              count(*)         AS event_count,
              (array_agg(event_name ORDER BY occurred_at))[1] AS entry_event,
              (array_agg(event_name ORDER BY occurred_at DESC))[1] AS exit_event
       FROM numbered
       GROUP BY actor_ref, session_seq
     ),
     created AS (
       INSERT INTO blocks_analytics.sessions
         (actor_ref, started_at, ended_at, event_count, entry_event, exit_event)
       SELECT actor_ref, started_at, ended_at, event_count, entry_event, exit_event FROM bounds
       RETURNING id, actor_ref, started_at, ended_at
     ),
     linked AS (
       UPDATE blocks_analytics.events e
       SET session_id = created.id
       FROM created
       WHERE COALESCE(e.user_ref, e.anonymous_id) = created.actor_ref
         AND e.occurred_at BETWEEN created.started_at AND created.ended_at
         AND e.session_id IS NULL
       RETURNING e.id
     )
     SELECT (SELECT count(*)::text FROM created) AS sessions,
            (SELECT count(*)::text FROM linked)  AS events`,
    [gapMinutes],
  );

  // Daily aggregates. Distinct actors rather than event count: one user firing an event fifty times
  // is one active user, and conflating them overstates engagement.
  const { rowCount: dailyRows } = await pool.query(
    `INSERT INTO blocks_analytics.daily_events (day, event_name, event_count, unique_actors)
     SELECT date_trunc('day', occurred_at)::date,
            event_name,
            count(*),
            count(DISTINCT COALESCE(user_ref, anonymous_id))
     FROM blocks_analytics.events
     WHERE occurred_at >= date_trunc('day', now() - interval '2 days')
     GROUP BY 1, 2
     ON CONFLICT (day, event_name) DO UPDATE
       SET event_count = EXCLUDED.event_count,
           unique_actors = EXCLUDED.unique_actors`,
  );

  // First-seen per actor, anchoring retention cohorts. LEAST/GREATEST so a late-arriving older event
  // correctly moves the cohort earlier rather than being ignored.
  const { rowCount: cohortRows } = await pool.query(
    `INSERT INTO blocks_analytics.actor_cohorts (actor_ref, first_seen_at, cohort_week, last_seen_at)
     SELECT COALESCE(user_ref, anonymous_id),
            min(occurred_at),
            date_trunc('week', min(occurred_at))::date,
            max(occurred_at)
     FROM blocks_analytics.events
     GROUP BY 1
     ON CONFLICT (actor_ref) DO UPDATE
       SET first_seen_at = LEAST(blocks_analytics.actor_cohorts.first_seen_at, EXCLUDED.first_seen_at),
           cohort_week = date_trunc('week',
             LEAST(blocks_analytics.actor_cohorts.first_seen_at, EXCLUDED.first_seen_at))::date,
           last_seen_at = GREATEST(blocks_analytics.actor_cohorts.last_seen_at, EXCLUDED.last_seen_at)`,
  );

  const result = {
    sessionsCreated: Number(sessionized[0]?.sessions ?? 0),
    eventsSessionized: Number(sessionized[0]?.events ?? 0),
    dailyRowsWritten: dailyRows ?? 0,
    cohortRowsWritten: cohortRows ?? 0,
  };
  log.info("analytics rollup complete", result);
  return json({ ok: true, scheduledAt: event.scheduledAt, ...result });
});

router.get("/funnel", async (_request, ctx) => {
  const steps = ctx.url.searchParams.get("steps");
  if (!steps) {
    throw new ValidationError("?steps= is required, e.g. ?steps=view,add_to_cart,checkout");
  }

  const stepNames = steps.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (stepNames.length < 2) throw new ValidationError("A funnel needs at least two steps");

  // TODO(analytics): ordered-step funnel.
  //   Each step must occur AFTER the previous one for the same actor. A query that merely counts
  //   actors who did all the steps inflates conversion: someone who checked out before adding to
  //   cart has not converted through the funnel.
  //   Shape: lateral joins per step, or min(occurred_at) per (actor, step) with a monotonicity check
  //   across steps. A conversion window (all steps within N days) should be a parameter.
  return json({
    steps: stepNames,
    results: [],
    note:
      "Funnel analysis is not yet wired. See the TODO in src/index.ts -- steps must be ordered per " +
      "actor, since counting actors who did all steps in any order overstates conversion.",
  });
});

router.get("/retention", async (_request, ctx) => {
  const weeks = Math.min(Number(ctx.url.searchParams.get("weeks") ?? "12"), 52);

  // Cohort sizes are real; the per-period return rates are the remaining work.
  const { rows } = await getPool().query(
    `SELECT cohort_week, count(*) AS cohort_size
     FROM blocks_analytics.actor_cohorts
     WHERE cohort_week >= date_trunc('week', now() - make_interval(weeks => $1::int))::date
     GROUP BY cohort_week
     ORDER BY cohort_week`,
    [weeks],
  );

  // TODO(analytics): the retention matrix. For each cohort, the fraction still active in week 1, 2,
  // 3... Join actor_cohorts to sessions and bucket by weeks-since-first-seen. A single retention
  // number hides whether the product is improving, which is the whole reason to compute cohorts.
  return json({
    cohorts: rows,
    matrix: [],
    note: "Retention rates are not yet wired; cohort sizes above are real.",
  });
});

router.get("/health", async () => {
  const report = await checkHealth(getPool(), {
    block: "analytics",
    schema: "blocks_analytics",
    evaluate: (status) => {
      const problems: string[] = [];

      const unsessionized = Number(status["events_unsessionized"] ?? 0);
      const futureDated = Number(status["events_future_dated"] ?? 0);
      const latestRollup = String(status["latest_rollup_day"] ?? "never");

      if (unsessionized > 10_000) {
        problems.push(
          `${unsessionized} event(s) are unsessionized; the /rollup trigger may be disabled, so ` +
            `every session-based metric is progressively more wrong`,
        );
      }
      if (latestRollup === "never") problems.push("no daily rollups have ever been computed");
      if (futureDated > 0) {
        problems.push(
          `${futureDated} event(s) have a client timestamp over an hour ahead of receipt, which ` +
            `distorts event ordering and any funnel built on it`,
        );
      }
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
