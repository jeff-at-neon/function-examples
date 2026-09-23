import { describe, expect, it } from "vitest";
import { rateDecision, retryAfterSeconds, windowStart } from "../src/verify.js";

describe("windowStart", () => {
  it("floors to the window boundary", () => {
    const now = new Date("2026-01-01T00:00:37.500Z");
    expect(windowStart(now, 60).toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("is stable for every instant within a window", () => {
    const a = windowStart(new Date("2026-01-01T00:00:01Z"), 60);
    const b = windowStart(new Date("2026-01-01T00:00:59Z"), 60);
    expect(a.getTime()).toBe(b.getTime());
  });

  it("advances to the next window at the boundary", () => {
    const a = windowStart(new Date("2026-01-01T00:00:59Z"), 60);
    const b = windowStart(new Date("2026-01-01T00:01:00Z"), 60);
    expect(b.getTime()).toBeGreaterThan(a.getTime());
  });
});

describe("rateDecision", () => {
  it("allows the request that reaches exactly the limit", () => {
    expect(rateDecision(1000, 1000)).toEqual({ allowed: true, remaining: 0 });
  });

  it("blocks the request past the limit", () => {
    expect(rateDecision(1001, 1000).allowed).toBe(false);
  });

  it("reports remaining budget below the limit", () => {
    expect(rateDecision(1, 1000)).toEqual({ allowed: true, remaining: 999 });
  });

  it("never reports negative remaining", () => {
    expect(rateDecision(1500, 1000).remaining).toBe(0);
  });
});

describe("retryAfterSeconds", () => {
  it("counts the seconds left in the window", () => {
    const start = new Date("2026-01-01T00:00:00Z");
    const now = new Date("2026-01-01T00:00:15Z");
    expect(retryAfterSeconds(now, start, 60)).toBe(45);
  });

  it("is at least 1 even at the very end of a window", () => {
    const start = new Date("2026-01-01T00:00:00Z");
    const now = new Date("2026-01-01T00:00:59.999Z");
    expect(retryAfterSeconds(now, start, 60)).toBeGreaterThanOrEqual(1);
  });
});
