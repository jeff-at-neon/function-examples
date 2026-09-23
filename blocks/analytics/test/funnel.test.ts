import { describe, expect, it } from "vitest";
import { actorStepTimes, computeFunnel } from "../src/funnel.js";

// Helper: build epoch-ms timestamps a few minutes apart.
const t = (min: number) => new Date(`2026-01-01T00:${String(min).padStart(2, "0")}:00Z`).getTime();

describe("computeFunnel", () => {
  it("counts an actor who did every step in order", () => {
    const counts = computeFunnel([[t(0), t(1), t(2)]], 3);
    expect(counts).toEqual([1, 1, 1]);
  });

  // The core rule: doing all steps in the WRONG order is not a conversion.
  it("drops an actor who did a later step before an earlier one", () => {
    // checkout (step 2) at t0, add_to_cart (step 1) at t1 -> out of order at step 1
    const counts = computeFunnel([[t(0), t(2), t(1)]], 3);
    expect(counts).toEqual([1, 1, 0]);
  });

  it("drops an actor who skipped a middle step", () => {
    const counts = computeFunnel([[t(0), null, t(2)]], 3);
    expect(counts).toEqual([1, 0, 0]);
  });

  it("excludes steps outside the conversion window", () => {
    // steps at 0 and 2 days; window of 1 day -> second step excluded
    const day = 86_400_000;
    const counts = computeFunnel([[0, 2 * day]], 2, 1 * day);
    expect(counts).toEqual([1, 0]);
  });

  it("aggregates across actors", () => {
    const counts = computeFunnel(
      [
        [t(0), t(1), t(2)], // full
        [t(0), t(1), null], // drops at step 3
        [t(0), null, null], // drops at step 2
      ],
      3,
    );
    expect(counts).toEqual([3, 2, 1]);
  });
});

describe("actorStepTimes", () => {
  it("aligns event rows to the step order, null for missing", () => {
    const times = actorStepTimes(
      [
        { event_name: "checkout", first_at: "2026-01-01T00:02:00Z" },
        { event_name: "view", first_at: "2026-01-01T00:00:00Z" },
      ],
      ["view", "add_to_cart", "checkout"],
    );
    expect(times[0]).toBe(t(0));
    expect(times[1]).toBeNull();
    expect(times[2]).toBe(t(2));
  });
});
