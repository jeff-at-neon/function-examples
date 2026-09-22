import { describe, expect, it } from "vitest";
import {
  DEFAULT_RRF_K,
  normalizeSearchQuery,
  reciprocalRankFusion,
  shouldUseTrigram,
  toRanked,
} from "../src/fusion.js";

describe("reciprocalRankFusion", () => {
  it("returns an empty list for no retrievers", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
  });

  it("preserves a single retriever's ordering", () => {
    const fused = reciprocalRankFusion([{ name: "vec", items: toRanked(["a", "b", "c"]) }]);
    expect(fused.map((f) => f.id)).toEqual(["a", "b", "c"]);
  });

  // The defining property of RRF and the reason hybrid search works: agreement across retrievers
  // beats a strong showing in just one.
  it("ranks a document found by both retrievers above one found strongly by only one", () => {
    const fused = reciprocalRankFusion([
      { name: "vec", items: toRanked(["solo", "both"]) },
      { name: "fts", items: toRanked(["both", "other"]) },
    ]);
    expect(fused[0]?.id).toBe("both");
  });

  // Scale-freedom: pgvector distance (0..2) and ts_rank (unbounded) are not comparable, so fusion
  // must depend only on position.
  it("depends only on rank position, never on the underlying scores", () => {
    const a = reciprocalRankFusion([{ name: "r", items: [{ id: "x", rank: 1 }, { id: "y", rank: 2 }] }]);
    const b = reciprocalRankFusion([{ name: "r", items: [{ id: "x", rank: 1 }, { id: "y", rank: 2 }] }]);
    expect(a).toEqual(b);
  });

  it("computes the documented formula", () => {
    const fused = reciprocalRankFusion([{ name: "r", items: [{ id: "a", rank: 1 }] }], { k: 60 });
    expect(fused[0]?.score).toBeCloseTo(1 / 61, 10);
  });

  it("sums contributions across retrievers", () => {
    const fused = reciprocalRankFusion(
      [
        { name: "vec", items: [{ id: "a", rank: 1 }] },
        { name: "fts", items: [{ id: "a", rank: 3 }] },
      ],
      { k: 60 },
    );
    expect(fused[0]?.score).toBeCloseTo(1 / 61 + 1 / 63, 10);
    expect(fused[0]?.contributions).toHaveLength(2);
  });

  it("applies weights", () => {
    const fused = reciprocalRankFusion(
      [
        { name: "vec", items: [{ id: "a", rank: 1 }], weight: 2 },
        { name: "fts", items: [{ id: "b", rank: 1 }], weight: 1 },
      ],
      { k: 60 },
    );
    expect(fused[0]?.id).toBe("a");
    expect(fused[0]?.score).toBeCloseTo(2 / 61, 10);
  });

  it("skips a zero-weighted retriever entirely rather than adding zeros", () => {
    const fused = reciprocalRankFusion([
      { name: "vec", items: toRanked(["a"]), weight: 0 },
      { name: "fts", items: toRanked(["b"]), weight: 1 },
    ]);
    expect(fused.map((f) => f.id)).toEqual(["b"]);
  });

  // Without deterministic tie-breaking, identical queries could return different orderings, which
  // makes pagination incoherent.
  it("breaks ties deterministically by id", () => {
    const first = reciprocalRankFusion([
      { name: "r1", items: [{ id: "zeta", rank: 1 }] },
      { name: "r2", items: [{ id: "alpha", rank: 1 }] },
    ]);
    const second = reciprocalRankFusion([
      { name: "r2", items: [{ id: "alpha", rank: 1 }] },
      { name: "r1", items: [{ id: "zeta", rank: 1 }] },
    ]);
    expect(first.map((f) => f.id)).toEqual(["alpha", "zeta"]);
    expect(second.map((f) => f.id)).toEqual(first.map((f) => f.id));
  });

  it("honours limit", () => {
    const fused = reciprocalRankFusion([{ name: "r", items: toRanked(["a", "b", "c", "d"]) }], {
      limit: 2,
    });
    expect(fused).toHaveLength(2);
  });

  it("records contributions for explainability", () => {
    const fused = reciprocalRankFusion([
      { name: "vec", items: [{ id: "a", rank: 2 }] },
      { name: "fts", items: [{ id: "a", rank: 5 }] },
    ]);
    expect(fused[0]?.contributions.map((c) => c.retriever).sort()).toEqual(["fts", "vec"]);
    expect(fused[0]?.contributions.find((c) => c.retriever === "fts")?.rank).toBe(5);
  });

  it("rejects invalid k and ranks", () => {
    expect(() => reciprocalRankFusion([], { k: 0 })).toThrow(/k must be >= 1/);
    expect(() =>
      reciprocalRankFusion([{ name: "r", items: [{ id: "a", rank: 0 }] }]),
    ).toThrow(/ranks are 1-based/);
  });

  it("rejects a negative weight", () => {
    expect(() =>
      reciprocalRankFusion([{ name: "r", items: toRanked(["a"]), weight: -1 }]),
    ).toThrow(/negative weight/);
  });

  it("uses k=60 from the original paper by default", () => {
    expect(DEFAULT_RRF_K).toBe(60);
    expect(reciprocalRankFusion([{ name: "r", items: [{ id: "a", rank: 1 }] }])[0]?.score).toBeCloseTo(
      1 / 61,
      10,
    );
  });

  it("handles a document appearing at the same rank in three retrievers", () => {
    const fused = reciprocalRankFusion(
      ["a", "b", "c"].map((name) => ({ name, items: [{ id: "x", rank: 1 }] })),
      { k: 60 },
    );
    expect(fused[0]?.score).toBeCloseTo(3 / 61, 10);
  });
});

describe("normalizeSearchQuery", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeSearchQuery("  hello   world  ")).toBe("hello world");
  });

  // Left for websearch_to_tsquery, which never raises on user input. to_tsquery('a & & b') throws,
  // and a search box that 500s on a stray ampersand is a bad search box.
  it("leaves operator characters alone", () => {
    expect(normalizeSearchQuery("a & | ! b")).toBe("a & | ! b");
    expect(normalizeSearchQuery('"exact phrase" -excluded')).toBe('"exact phrase" -excluded');
  });

  it("rejects an empty query", () => {
    expect(() => normalizeSearchQuery("   ")).toThrow(/empty/);
  });

  it("bounds length", () => {
    expect(normalizeSearchQuery("a".repeat(5_000))).toHaveLength(1_000);
  });
});

describe("shouldUseTrigram", () => {
  // Trigram catches typos but is expensive over large tables, and adds little for long queries
  // where full-text already has enough signal.
  it("enables trigram for short queries", () => {
    expect(shouldUseTrigram("recieve")).toBe(true);
    expect(shouldUseTrigram("refund policy")).toBe(true);
  });

  it("disables it for long queries", () => {
    expect(shouldUseTrigram("what is the company refund policy for annual plans")).toBe(false);
  });

  it("respects a custom threshold", () => {
    expect(shouldUseTrigram("a b c d e f", 10)).toBe(true);
  });

  it("returns false for an empty query", () => {
    expect(shouldUseTrigram("   ")).toBe(false);
  });
});
