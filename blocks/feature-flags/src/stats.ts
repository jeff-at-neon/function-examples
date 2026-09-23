/**
 * Experiment significance. All pure and unit tested against hand-computed values — this is the
 * block's real substance, and getting the statistics subtly wrong is worse than reporting nothing.
 *
 * The caveat the handler returns is not decoration: repeatedly checking an experiment until it
 * looks significant inflates false positives, which `sequentialAdjust` corrects for crudely and
 * `buildResults` surfaces explicitly.
 */

/** Abramowitz-Stegun 7.1.26 error function; max abs error ~1.5e-7, plenty for a p-value. */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/** Standard normal CDF. */
export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

export interface ZTestResult {
  zScore: number;
  /** Two-tailed p-value. */
  pValue: number;
}

/**
 * Two-proportion z-test with a pooled variance estimate. `n1/x1` is the baseline, `n2/x2` the
 * treatment. A zero denominator (or zero pooled variance, e.g. nobody converted in either arm)
 * yields no signal rather than a NaN/Infinity: `{ zScore: 0, pValue: 1 }`.
 */
export function twoProportionZTest(n1: number, x1: number, n2: number, x2: number): ZTestResult {
  if (n1 <= 0 || n2 <= 0) return { zScore: 0, pValue: 1 };
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const pooled = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (!(se > 0)) return { zScore: 0, pValue: 1 };
  const z = (p2 - p1) / se;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  return { zScore: z, pValue };
}

export interface Interval {
  rate: number;
  low: number;
  high: number;
}

/**
 * Wald (normal-approximation) confidence interval for a single proportion. `z` defaults to 1.96
 * (95%). Clamped to [0, 1]; a zero denominator returns a zero-width interval at 0.
 */
export function waldInterval(subjects: number, conversions: number, z = 1.96): Interval {
  if (subjects <= 0) return { rate: 0, low: 0, high: 0 };
  const rate = conversions / subjects;
  const se = Math.sqrt((rate * (1 - rate)) / subjects);
  return {
    rate,
    low: Math.max(0, rate - z * se),
    high: Math.min(1, rate + z * se),
  };
}

export interface SequentialAdjustment {
  adjustedPValue: number;
  significant: boolean;
  note: string;
}

/**
 * Crude sequential-testing correction (Bonferroni over the number of peeks) at alpha=0.05. As the
 * number of times the experiment has been checked grows, the bar to declare significance rises, so
 * a result that looked significant on the tenth peek probably isn't.
 */
export function sequentialAdjust(pValue: number, peeks: number, alpha = 0.05): SequentialAdjustment {
  const looks = Math.max(1, Math.floor(peeks));
  const adjustedPValue = Math.min(1, pValue * looks);
  return {
    adjustedPValue,
    significant: adjustedPValue < alpha,
    note:
      looks > 1
        ? `p-value Bonferroni-adjusted for ${looks} peeks; sequential testing inflates false positives.`
        : "single look; no sequential correction applied.",
  };
}

export interface VariantStat {
  variant: string;
  metric: string;
  subjects: number;
  conversions: number;
}

export interface Comparison {
  metric: string;
  variant: string;
  baseline: string;
  interval: Interval;
  baselineInterval: Interval;
  zScore: number;
  pValue: number;
  adjustedPValue: number;
  significant: boolean;
}

/**
 * Compare each non-baseline variant against the baseline, per metric. Rows with a metric that has
 * no baseline row are skipped (there is nothing to compare against). `peeks` feeds the sequential
 * correction.
 */
export function buildResults(
  rows: readonly VariantStat[],
  opts: { baseline: string; peeks?: number },
): { comparisons: Comparison[]; note: string } {
  const peeks = opts.peeks ?? 1;
  const byMetric = new Map<string, VariantStat[]>();
  for (const row of rows) {
    const list = byMetric.get(row.metric) ?? [];
    list.push(row);
    byMetric.set(row.metric, list);
  }

  const comparisons: Comparison[] = [];
  for (const [metric, list] of byMetric) {
    const base = list.find((r) => r.variant === opts.baseline);
    if (!base) continue;
    const baselineInterval = waldInterval(base.subjects, base.conversions);
    for (const row of list) {
      if (row.variant === opts.baseline) continue;
      const { zScore, pValue } = twoProportionZTest(
        base.subjects,
        base.conversions,
        row.subjects,
        row.conversions,
      );
      const seq = sequentialAdjust(pValue, peeks);
      comparisons.push({
        metric,
        variant: row.variant,
        baseline: opts.baseline,
        interval: waldInterval(row.subjects, row.conversions),
        baselineInterval,
        zScore,
        pValue,
        adjustedPValue: seq.adjustedPValue,
        significant: seq.significant,
      });
    }
  }

  return {
    comparisons,
    note:
      "Directional unless significant is true. Significance is Bonferroni-adjusted for peeks; " +
      "repeatedly checking until an experiment looks significant inflates false positives.",
  };
}
