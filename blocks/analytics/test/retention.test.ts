import { describe, expect, it } from "vitest";
import { buildRetentionMatrix, weeksSince } from "../src/retention.js";

const week = (n: number) => new Date(`2026-01-01T00:00:00Z`).getTime() + n * 7 * 86_400_000;

describe("weeksSince", () => {
  it("is 0 within the same week", () => {
    expect(weeksSince(week(0), week(0) + 3 * 86_400_000)).toBe(0);
  });

  it("counts whole weeks elapsed", () => {
    expect(weeksSince(week(0), week(1))).toBe(1);
    expect(weeksSince(week(0), week(3))).toBe(3);
  });
});

describe("buildRetentionMatrix", () => {
  const cohorts = [{ cohortWeek: "2026-01-05", size: 100 }];

  it("puts week 0 at full retention when the whole cohort is active", () => {
    const [row] = buildRetentionMatrix(
      cohorts,
      [{ cohortWeek: "2026-01-05", weeksSince: 0, activeActors: 100 }],
      3,
    );
    expect(row?.retention[0]).toBe(1);
  });

  it("computes fractions per week offset", () => {
    const [row] = buildRetentionMatrix(
      cohorts,
      [
        { cohortWeek: "2026-01-05", weeksSince: 0, activeActors: 100 },
        { cohortWeek: "2026-01-05", weeksSince: 2, activeActors: 40 },
      ],
      3,
    );
    // week 1 had no activity row -> 0; week 2 -> 0.4
    expect(row?.retention).toEqual([1, 0, 0.4, 0]);
  });

  it("returns zeros, not NaN, for an empty cohort", () => {
    const [row] = buildRetentionMatrix(
      [{ cohortWeek: "2026-01-05", size: 0 }],
      [{ cohortWeek: "2026-01-05", weeksSince: 0, activeActors: 0 }],
      2,
    );
    expect(row?.retention).toEqual([0, 0, 0]);
  });

  it("ignores negative week offsets from backfilled activity", () => {
    const [row] = buildRetentionMatrix(
      cohorts,
      [{ cohortWeek: "2026-01-05", weeksSince: -1, activeActors: 50 }],
      2,
    );
    expect(row?.retention).toEqual([0, 0, 0]);
  });
});
