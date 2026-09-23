/**
 * Cohort retention. The matrix assembly — turning cohort sizes and per-offset activity counts into
 * a fraction-retained-by-week grid — is pure and unit tested here; the SQL builder gathers the
 * activity counts.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Whole weeks between two instants (epoch ms). Same week -> 0, seven days later -> 1. */
export function weeksSince(firstSeenMs: number, activeAtMs: number): number {
  return Math.floor((activeAtMs - firstSeenMs) / WEEK_MS);
}

export interface CohortRow {
  cohortWeek: string;
  size: number;
}

export interface ActivityCell {
  cohortWeek: string;
  weeksSince: number;
  activeActors: number;
}

export interface RetentionRow {
  cohortWeek: string;
  size: number;
  /** retention[n] = fraction of the cohort active n weeks after first seen; retention[0] is week 0. */
  retention: number[];
}

/**
 * Assemble the retention matrix. For each cohort, `retention[n]` is the fraction of its members
 * active in week n. An empty cohort yields zeros rather than NaN. Negative offsets (activity dated
 * before first-seen, which a late-arriving backfill can produce) are ignored.
 */
export function buildRetentionMatrix(
  cohorts: readonly CohortRow[],
  activity: readonly ActivityCell[],
  maxWeeks: number,
): RetentionRow[] {
  const byWeek = new Map<string, Map<number, number>>();
  for (const cell of activity) {
    if (cell.weeksSince < 0) continue;
    const m = byWeek.get(cell.cohortWeek) ?? new Map<number, number>();
    m.set(cell.weeksSince, cell.activeActors);
    byWeek.set(cell.cohortWeek, m);
  }

  return cohorts.map((c) => {
    const cells = byWeek.get(c.cohortWeek) ?? new Map<number, number>();
    const retention: number[] = [];
    for (let w = 0; w <= maxWeeks; w++) {
      const active = cells.get(w) ?? 0;
      retention.push(c.size > 0 ? active / c.size : 0);
    }
    return { cohortWeek: c.cohortWeek, size: c.size, retention };
  });
}

/** Query returning distinct active actors per (cohort_week, weeks-since-first-seen). */
export function buildRetentionSql(): string {
  return `SELECT ac.cohort_week::text AS cohort_week,
                 floor(
                   extract(epoch FROM (date_trunc('week', s.started_at) - ac.cohort_week::timestamptz))
                   / ${WEEK_MS / 1000}
                 )::int AS weeks_since,
                 count(DISTINCT ac.actor_ref) AS active_actors
          FROM blocks_analytics.actor_cohorts ac
          JOIN blocks_analytics.sessions s ON s.actor_ref = ac.actor_ref
          WHERE ac.cohort_week >= date_trunc('week', now() - make_interval(weeks => $1::int))::date
          GROUP BY ac.cohort_week, weeks_since`;
}
