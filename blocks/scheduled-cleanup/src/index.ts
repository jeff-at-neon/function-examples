/**
 * Block 28 — Scheduled Cleanup Job.
 *
 * A UTC cron trigger fires /run, which expires records whose deadline has passed and logs the run.
 * Because the timer lives outside the compute, it fires correctly even when the function has scaled
 * to zero. This demonstrates, on its own, the scheduled-trigger pattern several blocks depend on.
 *
 * Routes:
 *   POST   /run        Cron. Expire due records under an advisory lock, then log the run.
 *   GET    /preview    Dry run: how many records would expire now, by kind.
 *   POST   /register   Register a record to expire (the producer side, for the demo).
 *   GET    /health     200 / 503, backed by the block's v_status view.
 *
 * STATUS: implemented. The sweep, run log, advisory lock, and trigger authentication are wired for
 * real over the block's own table. To expire your own rows, point the /run query at your table
 * (marked below) rather than the demo table. Unverified against a live Neon project.
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
  withAdvisoryLock,
  type Logger,
} from "@neon-blocks/core";
import { parseRegister, toByKind, totalExpired } from "./logic.js";

const log: Logger = createLogger({ block: "scheduled-cleanup" });

const SPEC = {
  block: "scheduled-cleanup",
  required: ["DATABASE_URL"],
  optional: {
    CLEANUP_BATCH_SIZE: "500",
    CLEANUP_DEFAULT_TTL_SECONDS: "3600",
  },
} as const;

function config() {
  return loadConfig(SPEC);
}

const router = new Router();

router.post("/register", async (request) => {
  const cfg = config();
  const reg = parseRegister(
    await readJson(request),
    cfg.int("CLEANUP_DEFAULT_TTL_SECONDS", { min: 1 }),
  );
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO blocks_scheduled_cleanup.expiring_records (kind, reference, expires_at)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [reg.kind, reg.reference, reg.expiresAt.toISOString()],
  );
  return json({ id: rows[0]?.id, kind: reg.kind, expiresAt: reg.expiresAt.toISOString() }, { status: 201 });
});

router.get("/preview", async () => {
  const { rows } = await getPool().query<{ kind: string; n: string }>(
    `SELECT kind, count(*)::text AS n
     FROM blocks_scheduled_cleanup.expiring_records
     WHERE status = 'active' AND expires_at <= now()
     GROUP BY kind`,
  );
  const byKind = toByKind(rows);
  return json({ wouldExpire: totalExpired(byKind), byKind });
});

router.post("/run", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", `/run expects a schedule trigger, got ${event.type}`);
  }

  const cfg = config();
  const batch = cfg.int("CLEANUP_BATCH_SIZE", { min: 1, max: 100_000 });
  const pool = getPool();

  // Advisory lock so two overlapping cron runs (a run exceeding the interval) do not both process
  // the same rows. A second holder exits successfully rather than retrying.
  const result = await withAdvisoryLock(pool, "scheduled-cleanup:run", async () => {
    // The one line to change to expire your own table: replace this UPDATE with one against your
    // rows. Everything around it (lock, batch bound, run log) stays.
    const { rows } = await pool.query<{ kind: string; n: string }>(
      `WITH due AS (
         SELECT id FROM blocks_scheduled_cleanup.expiring_records
         WHERE status = 'active' AND expires_at <= now()
         ORDER BY expires_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       ), expired AS (
         UPDATE blocks_scheduled_cleanup.expiring_records r
         SET status = 'expired', expired_at = now()
         FROM due WHERE r.id = due.id
         RETURNING r.kind
       )
       SELECT kind, count(*)::text AS n FROM expired GROUP BY kind`,
      [batch],
    );

    const byKind = toByKind(rows);
    const expired = totalExpired(byKind);

    await pool.query(
      `INSERT INTO blocks_scheduled_cleanup.runs (scanned, expired, by_kind)
       VALUES ($1, $2, $3::jsonb)`,
      [expired, expired, JSON.stringify(byKind)],
    );

    // TODO(scheduled-cleanup) fan-out seam: publish an event per expired record on the events
    //   contract so other blocks (notifications #13, webhooks-outbound #10) can react.
    return { expired, byKind };
  });

  if (result === false) {
    log.info("another run holds the lock; skipping");
    return json({ ok: true, skipped: true, scheduledAt: event.scheduledAt });
  }

  return json({ ok: true, scheduledAt: event.scheduledAt, expired: result.expired, byKind: result.byKind });
});

router.get("/health", async () => {
  const report = await checkHealth(getPool(), {
    block: "scheduled-cleanup",
    schema: "blocks_scheduled_cleanup",
    evaluate: (status) => {
      const problems: string[] = [];
      const overdue = Number(status["overdue"] ?? 0);
      if (overdue > 0) {
        problems.push(
          `${overdue} record(s) are past their expiry but still active; the /run trigger may be ` +
            `disabled on this branch (child branches inherit triggers disabled)`,
        );
      }
      return problems;
    },
  });
  return json(report, { status: report.status === "ok" ? 200 : 503 });
});

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ValidationError("Request body is not valid JSON");
  }
}

export default {
  fetch: (request: Request): Promise<Response> => router.handle(request),
};

// Re-exported so unit tests can import the pure logic directly.
export { parseRegister, toByKind, totalExpired } from "./logic.js";
