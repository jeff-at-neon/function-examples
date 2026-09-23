import { describe, expect, it } from "vitest";
import { compactionWindow, shouldCompact, tokenReduction } from "../src/compact.js";
import { estimateTokens } from "../src/tokens.js";

describe("estimateTokens", () => {
  it("is ceil(length/4) and 0 for empty", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("shouldCompact", () => {
  it("requires being over threshold AND having uncompacted turns", () => {
    expect(shouldCompact(30_000, 24_000, 50, 0)).toBe(true);
    expect(shouldCompact(10_000, 24_000, 50, 0)).toBe(false); // under threshold
    expect(shouldCompact(30_000, 24_000, 10, 10)).toBe(false); // nothing uncompacted
  });
});

describe("compactionWindow", () => {
  it("summarizes from just past the watermark up to the recent tail", () => {
    // 50 turns, none compacted, keep last 10 -> summarize turns 1..40
    expect(compactionWindow(50, 0, 10)).toEqual({ fromTurn: 1, toTurn: 40 });
  });

  it("starts after the already-compacted turns (summarizes the head, never drops it)", () => {
    // already compacted through 40, now 60 turns, keep 10 -> summarize 41..50
    expect(compactionWindow(60, 40, 10)).toEqual({ fromTurn: 41, toTurn: 50 });
  });

  it("returns null when only the recent tail remains", () => {
    // 15 turns, keep 10, nothing compacted -> would summarize 1..5; but if 8 already compacted:
    expect(compactionWindow(15, 8, 10)).toBeNull(); // toTurn 5 < fromTurn 9
    expect(compactionWindow(10, 0, 10)).toBeNull(); // toTurn 0 < fromTurn 1
  });

  it("keeps exactly keepRecentTurns verbatim", () => {
    const w = compactionWindow(100, 0, 10);
    expect(w).not.toBeNull();
    // turns (toTurn+1)..100 = 91..100 = 10 turns kept
    expect(100 - (w!.toTurn)).toBe(10);
  });
});

describe("tokenReduction", () => {
  it("is the savings, never negative", () => {
    expect(tokenReduction(1000, 200)).toBe(800);
    expect(tokenReduction(100, 500)).toBe(0);
  });
});
