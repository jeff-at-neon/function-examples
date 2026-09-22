/**
 * The reconciliation sweeper (convention §5).
 *
 * The queue's cron drain handles the happy path. This handles everything that went wrong:
 * leases held by dead functions, tables growing without bound, and a dead-letter queue nobody
 * is watching. Pure-ish and separately testable so the SQL can be exercised without a worker.
 */

import { createLogger, type Logger, type Queryable } from "@neon-blocks/core";
import { purgeSucceeded } from "@neon-blocks/queue";

export interface SweepOptions {
  retentionDays: number;
  /** Warn above this many dead letters. Silence here means nobody notices a broken handler. */
  deadLetterWarnThreshold?: number;
  logger?: Logger;
}

export interface SweepResult {
  leasesReclaimed: number;
  jobsPurged: number;
  eventsPurged: number;
  deadJobs: number;
  deadEvents: number;
  outboxLagSeconds: number;
  warnings: string[];
}

/**
 * Reclaim jobs whose lease expired while still marked running.
 *
 * The worker's claim query already steals expired leases opportunistically, but only for job
 * types it has handlers for. A type whose handler was removed in a deploy would otherwise stay
 * 'running' forever — invisible to both the worker and the stats view.
 */
export async function reclaimExpiredLeases(db: Queryable): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE blocks_queue.jobs
     SET state = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
         leased_until = NULL,
         claimed_by = NULL,
         last_error = COALESCE(last_error, 'lease expired; worker presumed dead'),
         finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END
     WHERE state = 'running' AND leased_until < now()`,
  );
  return rowCount ?? 0;
}

/**
 * Delete delivered outbox events past the retention window.
 *
 * Bounded by `limit` so one sweep can't hold an invocation open deleting millions of rows;
 * the next run continues. Dead-lettered events are never purged — they are the evidence.
 */
export async function purgeDeliveredEvents(
  db: Queryable,
  retentionDays: number,
  limit = 10_000,
): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM blocks_core.outbox_events
     WHERE id IN (
       SELECT id FROM blocks_core.outbox_events
       WHERE delivered_at IS NOT NULL
         AND delivered_at < now() - make_interval(days => $1::int)
       LIMIT $2
     )`,
    [retentionDays, limit],
  );
  return rowCount ?? 0;
}

interface StatusRow {
  [column: string]: unknown;
  jobs_dead: string;
  outbox_dead: string;
  outbox_lag_seconds: string;
  oldest_due_seconds: string;
  jobs_lease_expired: string;
}

export async function sweep(db: Queryable, opts: SweepOptions): Promise<SweepResult> {
  const log = opts.logger ?? createLogger({ block: "queue", op: "sweep" });
  const threshold = opts.deadLetterWarnThreshold ?? 1;
  const warnings: string[] = [];

  const leasesReclaimed = await reclaimExpiredLeases(db);
  if (leasesReclaimed > 0) {
    // Not merely informational: repeated reclaims mean handlers are exceeding the lease, and
    // the fix is configuration (raise QUEUE_LEASE_SECONDS), not more retries.
    warnings.push(
      `${leasesReclaimed} job(s) had expired leases and were reclaimed — handlers may be ` +
        `exceeding QUEUE_LEASE_SECONDS, or a function died mid-job`,
    );
  }

  const jobsPurged = await purgeSucceeded(db, opts.retentionDays);
  const eventsPurged = await purgeDeliveredEvents(db, opts.retentionDays);

  const { rows } = await db.query<StatusRow>(`SELECT * FROM blocks_queue.v_status`);
  const status = rows[0];

  const deadJobs = Number(status?.jobs_dead ?? 0);
  const deadEvents = Number(status?.outbox_dead ?? 0);
  const outboxLagSeconds = Number(status?.outbox_lag_seconds ?? 0);
  const oldestDueSeconds = Number(status?.oldest_due_seconds ?? 0);

  if (deadJobs >= threshold) {
    warnings.push(
      `${deadJobs} dead job(s) in blocks_queue.v_dead_letters — inspect, fix, then replay`,
    );
  }
  if (deadEvents >= threshold) {
    warnings.push(`${deadEvents} dead outbox event(s) — no consumer succeeded after max attempts`);
  }

  // A backlog older than a few minutes on a per-minute cron almost always means the trigger
  // isn't firing. The most common cause by far: this is a promoted child branch, and child
  // branches inherit triggers DISABLED.
  if (oldestDueSeconds > 300) {
    warnings.push(
      `oldest due job is ${oldestDueSeconds}s old. If the /work trigger is scheduled every ` +
        `minute, it is probably not firing — child branches inherit triggers DISABLED, so ` +
        `check \`neon triggers list\` and enable them on this branch`,
    );
  }
  if (outboxLagSeconds > 300) {
    warnings.push(`outbox lag is ${outboxLagSeconds}s; the drain is behind or not running`);
  }

  const result: SweepResult = {
    leasesReclaimed,
    jobsPurged,
    eventsPurged,
    deadJobs,
    deadEvents,
    outboxLagSeconds,
    warnings,
  };

  for (const warning of warnings) log.warn(warning);
  log.info("sweep complete", { ...result, warnings: warnings.length });

  return result;
}
