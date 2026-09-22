/**
 * Queue contract.
 *
 * This is the shared vocabulary twelve blocks depend on, so it's deliberately small. Anything
 * a specific block needs goes in its own payload, not here.
 */

export type JobState = "pending" | "running" | "succeeded" | "failed" | "dead";

export interface Job<P = unknown> {
  id: string;
  /** Logical job type; consumers register handlers per type. */
  type: string;
  payload: P;
  state: JobState;
  attempts: number;
  maxAttempts: number;
  /** Higher runs first. Equal priorities run oldest-first. */
  priority: number;
  runAt: Date;
  /** Present after a failure; the most recent error only. */
  lastError: string | null;
  /** Correlates a job with the event or request that produced it. */
  idempotencyKey: string | null;
  createdAt: Date;
}

export interface EnqueueRequest<P = unknown> {
  type: string;
  payload: P;
  /**
   * Dedupe key. A second enqueue with the same key is a no-op while the original is still
   * pending or running.
   *
   * This is the main defence against the outbox's at-least-once delivery turning into
   * duplicated side effects: a redelivered event enqueues the same key and nothing happens
   * twice.
   */
  idempotencyKey?: string;
  priority?: number;
  /** Delay execution. Used for backoff and for genuinely scheduled work. */
  runAt?: Date;
  maxAttempts?: number;
}

export interface JobHandlerContext {
  /** Increment on partial progress so a long job's retries don't restart from zero. */
  readonly attempt: number;
  readonly jobId: string;
  /**
   * Signal that aborts when the invocation is running out of time.
   *
   * Functions are long-running but not unbounded; a handler that ignores this gets killed
   * mid-write instead of checkpointing.
   */
  readonly signal: AbortSignal;
}

export type JobHandler<P = unknown> = (payload: P, ctx: JobHandlerContext) => Promise<void>;

/** Thrown by a handler to skip retries and dead-letter immediately. */
export class PermanentJobError extends Error {
  override readonly name = "PermanentJobError";
}

export interface WorkerStats {
  claimed: number;
  succeeded: number;
  failed: number;
  deadLettered: number;
  /** True when the batch filled — more work is waiting right now. */
  saturated: boolean;
  /** Types skipped because their concurrency cap was already met. */
  throttled: string[];
}
