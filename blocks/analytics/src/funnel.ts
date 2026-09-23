/**
 * Ordered-step funnel. The monotonicity rule — a step only counts if it happened at or after the
 * previous step for the same actor — is the whole point and lives in `computeFunnel`, which is pure
 * and takes plain timestamps so it can be unit tested without a database. The SQL builder only
 * gathers each actor's first time per step; the ordering decision is not delegated to SQL.
 */

/** Query returning, per actor, the earliest occurrence of each named step. */
export function buildFunnelSql(): string {
  return `SELECT COALESCE(user_ref, anonymous_id) AS actor_ref,
                 event_name,
                 min(occurred_at) AS first_at
          FROM blocks_analytics.events
          WHERE event_name = ANY($1)
            AND ($2::int IS NULL OR occurred_at >= now() - make_interval(days => $2::int))
          GROUP BY actor_ref, event_name`;
}

/**
 * Count how many actors progressed through each step in order.
 *
 * `perActor[k][i]` is actor k's first time (epoch ms) for step i, or null if they never did it.
 * An actor is counted at step i only if they did every step up to i, each at or after the previous
 * step's first time, and — when `windowMs` is given — within that window of their first step.
 *
 * The returned array is cumulative and non-increasing: `counts[i]` is everyone still in the funnel
 * at step i.
 */
export function computeFunnel(
  perActor: readonly (readonly (number | null)[])[],
  stepCount: number,
  windowMs?: number,
): number[] {
  const counts = new Array<number>(stepCount).fill(0);
  for (const actor of perActor) {
    const first = actor[0];
    if (first == null) continue;
    counts[0] = (counts[0] ?? 0) + 1;
    let prevTime = first;
    for (let i = 1; i < stepCount; i++) {
      const t = actor[i];
      if (t == null) break; // never did this step
      if (t < prevTime) break; // did it, but out of order — not a progression
      if (windowMs != null && t - first > windowMs) break; // outside the conversion window
      counts[i] = (counts[i] ?? 0) + 1;
      prevTime = t;
    }
  }
  return counts;
}

/** Shape one actor's rows (event_name -> first_at) into an array aligned to `stepNames`. */
export function actorStepTimes(
  rows: readonly { event_name: string; first_at: string | Date }[],
  stepNames: readonly string[],
): (number | null)[] {
  const byStep = new Map<string, number>();
  for (const r of rows) {
    byStep.set(r.event_name, new Date(r.first_at).getTime());
  }
  return stepNames.map((name) => byStep.get(name) ?? null);
}
