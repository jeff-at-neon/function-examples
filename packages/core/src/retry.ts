/**
 * Backoff math, shared by the queue, outbound webhooks, and every provider adapter.
 *
 * Pure and separately testable: retry policy is the kind of thing that looks obviously
 * correct and is off by a factor of sixty.
 */

export interface BackoffPolicy {
  /** Delay before the first retry. */
  baseMs: number;
  /** Ceiling on any single delay. */
  maxMs: number;
  /** Multiplier per attempt. 2 = doubling. */
  factor: number;
  /**
   * Random proportion of the computed delay to add, 0..1.
   *
   * Non-zero by default and deliberately so: a batch of jobs that fail together will retry
   * in lockstep without it, producing a thundering herd against whatever just broke.
   */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  baseMs: 1_000,
  maxMs: 3_600_000, // One hour. Beyond this a human needs to look at it.
  factor: 2,
  jitter: 0.2,
};

/**
 * Delay before retry number `attempt` (1-based).
 *
 * `random` is injectable so tests are deterministic.
 */
export function backoffMs(
  attempt: number,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  if (attempt < 1) throw new Error(`attempt must be >= 1, got ${attempt}`);

  const exponential = policy.baseMs * Math.pow(policy.factor, attempt - 1);
  const capped = Math.min(exponential, policy.maxMs);
  const jittered = capped * (1 + policy.jitter * random());
  // Re-cap: jitter must not push a delay past the documented maximum.
  return Math.round(Math.min(jittered, policy.maxMs));
}

/**
 * Whether an error should be retried at all.
 *
 * Retrying a 400 forever is how a poison message burns a month of capacity-hours. 429 and
 * 5xx are retryable; other 4xx are permanent and belong in the DLQ immediately.
 */
export function isRetryableStatus(status: number): boolean {
  if (status === 429) return true;
  if (status === 408) return true;
  return status >= 500 && status < 600;
}

export interface CircuitState {
  consecutiveFailures: number;
  openedAt: number | null;
}

export interface CircuitPolicy {
  /** Consecutive failures before the circuit opens. */
  threshold: number;
  /** How long it stays open before a trial request is allowed. */
  cooldownMs: number;
}

export const DEFAULT_CIRCUIT: CircuitPolicy = { threshold: 5, cooldownMs: 60_000 };

/**
 * Whether a request to a repeatedly-failing endpoint should be attempted.
 *
 * Used by outbound webhooks: one customer's dead endpoint must not consume the delivery
 * budget for every other customer.
 */
export function circuitAllows(
  state: CircuitState,
  now: number,
  policy: CircuitPolicy = DEFAULT_CIRCUIT,
): boolean {
  if (state.openedAt === null) return true;
  if (state.consecutiveFailures < policy.threshold) return true;
  return now - state.openedAt >= policy.cooldownMs;
}
