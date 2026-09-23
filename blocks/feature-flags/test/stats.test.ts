import { describe, expect, it } from "vitest";
import {
  buildResults,
  normalCdf,
  sequentialAdjust,
  twoProportionZTest,
  waldInterval,
} from "../src/stats.js";

describe("normalCdf", () => {
  it("is 0.5 at zero and symmetric", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 4);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
  });
});

describe("twoProportionZTest", () => {
  // Hand-computed: control 100/1000 (0.10) vs treatment 150/1000 (0.15).
  // pooled p = 0.125, SE = sqrt(0.125*0.875*(2/1000)) = 0.014790, z = 0.05/0.014790 = 3.381.
  it("matches a hand-computed z and p", () => {
    const { zScore, pValue } = twoProportionZTest(1000, 100, 1000, 150);
    expect(zScore).toBeCloseTo(3.381, 2);
    expect(pValue).toBeLessThan(0.001);
    expect(pValue).toBeGreaterThan(0.0001);
  });

  it("reports no signal for equal proportions", () => {
    const { zScore, pValue } = twoProportionZTest(500, 50, 500, 50);
    expect(zScore).toBeCloseTo(0, 10);
    // The erf approximation carries ~1e-7 error, so p is 1 to within that, not to 1e-10.
    expect(pValue).toBeCloseTo(1, 6);
  });

  it("guards zero denominators without NaN/Infinity", () => {
    expect(twoProportionZTest(0, 0, 100, 10)).toEqual({ zScore: 0, pValue: 1 });
    // Nobody converted in either arm -> zero pooled variance -> no signal.
    expect(twoProportionZTest(100, 0, 100, 0)).toEqual({ zScore: 0, pValue: 1 });
  });
});

describe("waldInterval", () => {
  it("brackets the observed rate", () => {
    const iv = waldInterval(1000, 150);
    expect(iv.rate).toBeCloseTo(0.15, 10);
    expect(iv.low).toBeLessThan(iv.rate);
    expect(iv.high).toBeGreaterThan(iv.rate);
    // rate 0.15, SE ~0.01129, 1.96*SE ~0.02213
    expect(iv.low).toBeCloseTo(0.1279, 3);
    expect(iv.high).toBeCloseTo(0.1721, 3);
  });

  it("clamps to [0,1] and handles a zero denominator", () => {
    const extreme = waldInterval(10, 10); // rate 1.0
    expect(extreme.high).toBe(1);
    expect(waldInterval(0, 0)).toEqual({ rate: 0, low: 0, high: 0 });
  });
});

describe("sequentialAdjust", () => {
  it("leaves a single look unchanged", () => {
    const a = sequentialAdjust(0.01, 1);
    expect(a.adjustedPValue).toBeCloseTo(0.01, 10);
    expect(a.significant).toBe(true);
  });

  it("raises the bar as peeks increase", () => {
    const one = sequentialAdjust(0.01, 1);
    const ten = sequentialAdjust(0.01, 10);
    expect(ten.adjustedPValue).toBeGreaterThan(one.adjustedPValue);
    // 0.01 * 10 = 0.10, no longer < 0.05
    expect(ten.significant).toBe(false);
  });

  it("clamps the adjusted p-value at 1", () => {
    expect(sequentialAdjust(0.5, 100).adjustedPValue).toBe(1);
  });
});

describe("buildResults", () => {
  it("compares each variant to the baseline per metric", () => {
    const { comparisons } = buildResults(
      [
        { variant: "control", metric: "signup", subjects: 1000, conversions: 100 },
        { variant: "treatment", metric: "signup", subjects: 1000, conversions: 150 },
      ],
      { baseline: "control" },
    );
    expect(comparisons).toHaveLength(1);
    expect(comparisons[0]?.variant).toBe("treatment");
    expect(comparisons[0]?.significant).toBe(true);
  });

  it("skips a metric with no baseline row", () => {
    const { comparisons } = buildResults(
      [{ variant: "treatment", metric: "signup", subjects: 1000, conversions: 150 }],
      { baseline: "control" },
    );
    expect(comparisons).toHaveLength(0);
  });
});
