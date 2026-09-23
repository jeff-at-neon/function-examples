import { describe, expect, it } from "vitest";
import { assembleContext, selectRetrieved, type RetrievedTurn } from "../src/context.js";

const r = (turn_index: number, distance: number): RetrievedTurn => ({
  turn_index,
  role: "user",
  content: `turn ${turn_index}`,
  distance,
});

describe("selectRetrieved", () => {
  it("ranks nearest first and honors k", () => {
    const picked = selectRetrieved([r(1, 0.5), r(2, 0.1), r(3, 0.3)], 2, new Set());
    expect(picked.map((p) => p.turn_index)).toEqual([2, 3]);
  });

  it("excludes turns already in the recent window", () => {
    const picked = selectRetrieved([r(1, 0.1), r(2, 0.2)], 5, new Set([1]));
    expect(picked.map((p) => p.turn_index)).toEqual([2]);
  });
});

describe("assembleContext", () => {
  it("orders summaries by range and recent turns ascending", () => {
    const out = assembleContext({
      summaries: [
        { from_turn: 10, to_turn: 20, summary: "b", token_count: 5 },
        { from_turn: 1, to_turn: 9, summary: "a", token_count: 5 },
      ],
      retrieved: [r(12, 0.1)],
      recent: [
        { turn_index: 30, role: "user", content: "y" },
        { turn_index: 25, role: "user", content: "x" },
      ],
    });
    expect(out.summaries.map((s) => s.from_turn)).toEqual([1, 10]);
    expect(out.recentTurns.map((t) => t.turn_index)).toEqual([25, 30]);
    expect(out.retrievedTurns).toHaveLength(1);
  });
});
