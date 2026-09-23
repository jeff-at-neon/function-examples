import { describe, expect, it } from "vitest";
import {
  distanceToSimilarity,
  meetsThreshold,
  promptHash,
  tokensSaved,
} from "../src/similarity.js";

describe("distanceToSimilarity", () => {
  it("maps distance 0 to similarity 1", () => {
    expect(distanceToSimilarity(0)).toBe(1);
  });

  it("maps distance 0.1 to similarity 0.9", () => {
    expect(distanceToSimilarity(0.1)).toBeCloseTo(0.9, 10);
  });
});

describe("meetsThreshold", () => {
  it("accepts a candidate exactly on the threshold", () => {
    // distance 0.05 -> similarity 0.95, threshold 0.95
    expect(meetsThreshold(0.05, 0.95)).toBe(true);
  });

  it("rejects a candidate just below the threshold", () => {
    expect(meetsThreshold(0.06, 0.95)).toBe(false);
  });
});

describe("tokensSaved", () => {
  it("sums prompt and completion tokens", () => {
    expect(tokensSaved({ promptTokens: 30, completionTokens: 120 })).toBe(150);
  });

  it("treats missing counts as zero", () => {
    expect(tokensSaved({})).toBe(0);
    expect(tokensSaved({ promptTokens: null, completionTokens: 10 })).toBe(10);
  });
});

describe("promptHash", () => {
  it("is deterministic", () => {
    expect(promptHash("t1", "gpt", "hi")).toBe(promptHash("t1", "gpt", "hi"));
  });

  // Scoping is the security property: the same prompt must key differently across tenants and
  // across models, or a hit leaks one tenant's answer or serves a weaker model's response.
  it("changes when the namespace changes", () => {
    expect(promptHash("t1", "gpt", "hi")).not.toBe(promptHash("t2", "gpt", "hi"));
  });

  it("changes when the model changes", () => {
    expect(promptHash("t1", "gpt-4", "hi")).not.toBe(promptHash("t1", "gpt-5", "hi"));
  });
});
