import { describe, expect, it } from "vitest";
import { bucketOf, variantFor } from "../src/bucketing.js";

describe("bucketOf", () => {
  it("is deterministic and in range 0..9999", () => {
    const b = bucketOf("flag-a", "user-1");
    expect(b).toBe(bucketOf("flag-a", "user-1"));
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(10_000);
  });

  // Hashing the subject alone would correlate every experiment; the flag key must change the
  // bucket, or a user in treatment for one test is in treatment for all of them.
  it("changes with the flag key for the same subject", () => {
    expect(bucketOf("flag-a", "user-1")).not.toBe(bucketOf("flag-b", "user-1"));
  });
});

describe("variantFor", () => {
  it("returns null for a subject outside the rollout", () => {
    // rolloutPct 10 -> gate at bucket 1000; a bucket of 5000 is outside.
    expect(variantFor(5000, { control: 50, treatment: 50 }, 10)).toBeNull();
  });

  it("assigns a variant inside the rollout", () => {
    expect(variantFor(0, { control: 50, treatment: 50 }, 100)).toBe("control");
    // bucket just under the top of a full rollout lands in the last variant.
    expect(variantFor(9999, { control: 50, treatment: 50 }, 100)).toBe("treatment");
  });

  it("splits by weight across the rollout range", () => {
    // 100% rollout, 50/50: bucket 4999 -> control, 5000 -> treatment.
    expect(variantFor(4999, { control: 50, treatment: 50 }, 100)).toBe("control");
    expect(variantFor(5000, { control: 50, treatment: 50 }, 100)).toBe("treatment");
  });

  it("returns null when no variant has positive weight", () => {
    expect(variantFor(0, { control: 0, treatment: 0 }, 100)).toBeNull();
  });
});
