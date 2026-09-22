/**
 * The worker loop.
 *
 * Runs inside an HTTP or cron invocation. Functions are long-running (minutes), so a single
 * invocation can drain a meaningful batch — but it must stop before the platform kills it, or
 * jobs die mid-write with their lease still held.
 */

import {
  backoffMs,
  createLogger,
  DEFAULT_BACKOFF,
  type BackoffPolicy,
  type Logger,
  type Queryable,
} from "@neon-blocks/core";
import { claim, complete, fail, runningByType } from "./queue.js";
import { PermanentJobError, type Job, type JobHandler, type WorkerStats } from "./types.js";

export interface WorkerOptions {
  /** Max jobs claimed per invocation. */
  batchSize?: number;
  /** Lease duration. Should exceed the slowest handler's realistic runtime. */
  leaseSeconds?: number;
  /**
   * Stop claiming new work after this long, so the invocation finishes cleanly.
   *
   * Billing runs until the handler returns — including `waitUntil` work — so an invocation
   * that runs long is billed for all of it. Bounding the loop keeps cost predictable.
   */
  budgetMs?: number;
  /** Per-type ceiling on simultaneously-running jobs across all workers. */
  concurrency?: Readonly<Record<string, number>>;
  backoff?: BackoffPolicy;
  worker?: string;
  logger?: Logger;
  now?: () => Date;
}

export class Worker {
  readonly #handlers = new Map<string, JobHandler>();
  readonly #logger: Logger;

  constructor(logger: Logger = createLogger({ pkg: "queue" })) {
    this.#logger = logger;
  }

  /** Register a handler. One per type; re-registering is a programming error, not an override. */
  register<P>(type: string, handler: JobHandler<P>): this {
    if (this.#handlers.has(type)) {
      throw new Error(
        `A handler for job type "${type}" is already registered. Two handlers for one type ` +
          `would silently drop one.`,
      );
    }
    this.#handlers.set(type, handler as JobHandler);
    return this;
  }

  registeredTypes(): string[] {
    return [...this.#handlers.keys()];
  }

  /**
   * Claim and run one batch.
   *
   * Jobs run sequentially. Parallelism comes from Neon running multiple invocations, not from
   * one invocation fanning out — a fixed-size function gains little from in-process
   * concurrency on CPU-bound work, and I/O-bound work is already cheap while waiting.
   */
  async runOnce(db: Queryable, opts: WorkerOptions = {}): Promise<WorkerStats> {
    const batchSize = opts.batchSize ?? 25;
    const leaseSeconds = opts.leaseSeconds ?? 300;
    const budgetMs = opts.budgetMs ?? 60_000;
    const backoffPolicy = opts.backoff ?? DEFAULT_BACKOFF;
    const worker = opts.worker ?? `worker-${process.pid}`;
    const log = opts.logger ?? this.#logger;
    const now = opts.now ?? (() => new Date());
    const startedAt = Date.now();

    const stats: WorkerStats = {
      claimed: 0,
      succeeded: 0,
      failed: 0,
      deadLettered: 0,
      saturated: false,
      throttled: [],
    };

    if (this.#handlers.size === 0) {
      log.warn("worker has no registered handlers; nothing to do");
      return stats;
    }

    const eligible = await this.#eligibleTypes(db, opts.concurrency, stats, log);
    if (eligible.length === 0) return stats;

    const jobs = await claim(db, {
      limit: batchSize,
      types: eligible,
      leaseSeconds,
      worker,
    });
    stats.claimed = jobs.length;
    stats.saturated = jobs.length >= batchSize;

    for (const job of jobs) {
      if (Date.now() - startedAt > budgetMs) {
        // Release the rest by expiring their lease immediately, so another invocation picks
        // them up now rather than after the full lease window.
        await this.#release(db, jobs.slice(jobs.indexOf(job)));
        log.capped("worker budget exhausted; released unstarted jobs", {
          budgetMs,
          released: jobs.length - jobs.indexOf(job),
        });
        break;
      }

      const outcome = await this.#runJob(db, job, { leaseSeconds, backoffPolicy, log, now });
      if (outcome === "succeeded") stats.succeeded++;
      else if (outcome === "dead") {
        stats.failed++;
        stats.deadLettered++;
      } else stats.failed++;
    }

    if (stats.saturated) {
      log.capped("job batch filled; backlog remains", { batchSize, claimed: stats.claimed });
    }

    return stats;
  }

  /** Filter out types already at their concurrency cap. */
  async #eligibleTypes(
    db: Queryable,
    concurrency: Readonly<Record<string, number>> | undefined,
    stats: WorkerStats,
    log: Logger,
  ): Promise<string[]> {
    const all = this.registeredTypes();
    if (!concurrency || Object.keys(concurrency).length === 0) return all;

    const running = await runningByType(db);
    const eligible: string[] = [];

    for (const type of all) {
      const cap = concurrency[type];
      if (cap === undefined) {
        eligible.push(type);
        continue;
      }
      const current = running.get(type) ?? 0;
      if (current < cap) eligible.push(type);
      else {
        stats.throttled.push(type);
        log.info("job type throttled at concurrency cap", { type, cap, running: current });
      }
    }

    return eligible;
  }

  async #runJob(
    db: Queryable,
    job: Job,
    ctx: { leaseSeconds: number; backoffPolicy: BackoffPolicy; log: Logger; now: () => Date },
  ): Promise<"succeeded" | "retry" | "dead"> {
    const handler = this.#handlers.get(job.type);
    if (!handler) {
      // Claimed by type filter, so this shouldn't happen — but a stale claim after a
      // deploy that removed a handler would land here. Dead-letter rather than loop.
      await fail(db, job.id, `No handler registered for job type "${job.type}"`, null);
      return "dead";
    }

    // Abort slightly before the lease expires so a handler that respects the signal
    // checkpoints instead of being stolen mid-write.
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(1_000, ctx.leaseSeconds * 1_000 - 5_000),
    );

    try {
      await handler(job.payload, {
        attempt: job.attempts,
        jobId: job.id,
        signal: controller.signal,
      });
      await complete(db, job.id);
      ctx.log.debug("job succeeded", { jobId: job.id, type: job.type, attempt: job.attempts });
      return "succeeded";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const permanent = err instanceof PermanentJobError;
      const exhausted = job.attempts >= job.maxAttempts;

      if (permanent || exhausted) {
        await fail(db, job.id, message, null);
        ctx.log.error("job dead-lettered", {
          jobId: job.id,
          type: job.type,
          attempts: job.attempts,
          reason: permanent ? "permanent error" : "attempts exhausted",
          err: message,
        });
        return "dead";
      }

      const retryAt = new Date(ctx.now().getTime() + backoffMs(job.attempts, ctx.backoffPolicy));
      await fail(db, job.id, message, retryAt);
      ctx.log.warn("job failed, will retry", {
        jobId: job.id,
        type: job.type,
        attempts: job.attempts,
        retryAt: retryAt.toISOString(),
        err: message,
      });
      return "retry";
    } finally {
      clearTimeout(timer);
    }
  }

  /** Hand unstarted jobs straight back rather than letting their leases idle out. */
  async #release(db: Queryable, jobs: readonly Job[]): Promise<void> {
    if (jobs.length === 0) return;
    await db.query(
      `UPDATE blocks_queue.jobs
       SET state = 'pending', attempts = GREATEST(attempts - 1, 0), leased_until = NULL
       WHERE id = ANY($1::uuid[]) AND state = 'running'`,
      [jobs.map((j) => j.id)],
    );
  }
}
