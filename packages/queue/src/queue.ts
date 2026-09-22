/**
 * The queue itself: enqueue, claim, complete.
 *
 * `FOR UPDATE SKIP LOCKED` is the whole trick. Multiple concurrent invocations each claim a
 * disjoint set of rows without blocking on one another, which is what makes a Postgres table a
 * usable queue rather than a contention point.
 */

import { type Queryable } from "@neon-blocks/core";
import type { EnqueueRequest, Job, JobState } from "./types.js";

interface JobRow {
  [column: string]: unknown;
  id: string;
  job_type: string;
  payload: unknown;
  state: JobState;
  attempts: number;
  max_attempts: number;
  priority: number;
  run_at: Date;
  last_error: string | null;
  idempotency_key: string | null;
  created_at: Date;
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    type: row.job_type,
    payload: row.payload,
    state: row.state,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    priority: row.priority,
    runAt: row.run_at,
    lastError: row.last_error,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

export const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Enqueue a job, or return the existing one when `idempotencyKey` collides.
 *
 * The partial unique index only covers pending/running jobs, so the same key can be reused
 * once the earlier job finished — "send the daily digest for user 7" should be enqueueable
 * again tomorrow.
 */
export async function enqueue<P>(
  db: Queryable,
  request: EnqueueRequest<P>,
): Promise<{ job: Job<P>; deduplicated: boolean }> {
  if (!/^[a-z][a-z0-9_.]*$/.test(request.type)) {
    throw new Error(
      `Invalid job type ${JSON.stringify(request.type)}. Use lowercase with dots or ` +
        `underscores, e.g. "rag.embed_chunk".`,
    );
  }

  const { rows } = await db.query<JobRow>(
    `INSERT INTO blocks_queue.jobs
       (job_type, payload, priority, run_at, max_attempts, idempotency_key)
     VALUES ($1, $2::jsonb, $3, COALESCE($4, now()), $5, $6)
     ON CONFLICT ON CONSTRAINT jobs_idempotency_active DO NOTHING
     RETURNING *`,
    [
      request.type,
      JSON.stringify(request.payload ?? null),
      request.priority ?? 0,
      request.runAt ?? null,
      request.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      request.idempotencyKey ?? null,
    ],
  );

  const inserted = rows[0];
  if (inserted) return { job: toJob(inserted) as Job<P>, deduplicated: false };

  // DO NOTHING fired, so an active job already holds this key.
  const existing = await db.query<JobRow>(
    `SELECT * FROM blocks_queue.jobs
     WHERE idempotency_key = $1 AND state IN ('pending', 'running')
     ORDER BY created_at LIMIT 1`,
    [request.idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row) {
    throw new Error(
      `Enqueue of "${request.type}" was skipped by the idempotency constraint but no active ` +
        `job holds key ${JSON.stringify(request.idempotencyKey)}. This indicates a different ` +
        `constraint violation.`,
    );
  }
  return { job: toJob(row) as Job<P>, deduplicated: true };
}

export interface ClaimOptions {
  limit: number;
  /** Restrict to these types. Omit for all. */
  types?: readonly string[];
  /**
   * How long a claimed job may run before another worker may steal it.
   *
   * Necessary because a function can die mid-job — without a lease, that job is stuck in
   * `running` forever and nothing retries it.
   */
  leaseSeconds: number;
  worker: string;
}

/**
 * Claim runnable jobs.
 *
 * Also reclaims jobs whose lease expired, which is how crashed workers self-heal. Ordering is
 * priority-then-age so a high-priority job can't be starved by a long backlog.
 */
export async function claim(db: Queryable, opts: ClaimOptions): Promise<Job[]> {
  const { rows } = await db.query<JobRow>(
    `WITH runnable AS (
       SELECT id
       FROM blocks_queue.jobs
       WHERE run_at <= now()
         AND ($2::text[] IS NULL OR job_type = ANY($2::text[]))
         AND (
           state = 'pending'
           OR (state = 'running' AND leased_until < now())
         )
       ORDER BY priority DESC, run_at
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE blocks_queue.jobs j
     SET state = 'running',
         attempts = j.attempts + 1,
         leased_until = now() + make_interval(secs => $3::double precision),
         claimed_by = $4,
         claimed_at = now()
     FROM runnable
     WHERE j.id = runnable.id
     RETURNING j.*`,
    [opts.limit, opts.types ?? null, opts.leaseSeconds, opts.worker],
  );

  return rows.map(toJob);
}

export async function complete(db: Queryable, jobId: string): Promise<void> {
  await db.query(
    `UPDATE blocks_queue.jobs
     SET state = 'succeeded', finished_at = now(), leased_until = NULL, last_error = NULL
     WHERE id = $1`,
    [jobId],
  );
}

/**
 * Record a failure: either schedule a retry or dead-letter.
 *
 * `retryAt === null` means give up now — used for permanent errors and for exhausted attempts.
 * Dead jobs stay in the table so they can be inspected and replayed; silently deleting a failed
 * job is how you lose a customer's order.
 */
export async function fail(
  db: Queryable,
  jobId: string,
  error: string,
  retryAt: Date | null,
): Promise<void> {
  await db.query(
    `UPDATE blocks_queue.jobs
     SET state = CASE WHEN $3::timestamptz IS NULL THEN 'dead' ELSE 'pending' END,
         run_at = COALESCE($3, run_at),
         last_error = $2,
         leased_until = NULL,
         finished_at = CASE WHEN $3::timestamptz IS NULL THEN now() ELSE NULL END
     WHERE id = $1`,
    [jobId, error.slice(0, 4_000), retryAt],
  );
}

/**
 * Per-type count of jobs currently running, for concurrency caps.
 *
 * Caps exist from day one specifically because row-event triggers will be a firehose when they
 * ship: the difference between "row events are great" and "row events blew up my
 * capacity-hours bill" is whether the queue can refuse work (docs/ROW_EVENTS.md).
 */
export async function runningByType(db: Queryable): Promise<Map<string, number>> {
  const { rows } = await db.query<{ job_type: string; running: string }>(
    `SELECT job_type, count(*)::text AS running
     FROM blocks_queue.jobs
     WHERE state = 'running' AND leased_until > now()
     GROUP BY job_type`,
  );
  return new Map(rows.map((r) => [r.job_type, Number(r.running)]));
}

/** Move dead jobs back to pending, for operator-driven replay after a fix. */
export async function replayDead(
  db: Queryable,
  opts: { type?: string; limit: number },
): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE blocks_queue.jobs
     SET state = 'pending', attempts = 0, run_at = now(), last_error = NULL, finished_at = NULL
     WHERE id IN (
       SELECT id FROM blocks_queue.jobs
       WHERE state = 'dead' AND ($1::text IS NULL OR job_type = $1)
       ORDER BY finished_at
       LIMIT $2
     )`,
    [opts.type ?? null, opts.limit],
  );
  return rowCount ?? 0;
}

/** Delete succeeded jobs older than the retention window. Called by the sweeper. */
export async function purgeSucceeded(
  db: Queryable,
  retentionDays: number,
  limit = 10_000,
): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM blocks_queue.jobs
     WHERE id IN (
       SELECT id FROM blocks_queue.jobs
       WHERE state = 'succeeded'
         AND finished_at < now() - make_interval(days => $1::int)
       LIMIT $2
     )`,
    [retentionDays, limit],
  );
  return rowCount ?? 0;
}
