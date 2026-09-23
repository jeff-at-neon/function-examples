import { describe, expect, it } from "vitest";
import { buildImagePrompt, decide, extractScores, parseThresholds } from "../src/classify.js";

describe("parseThresholds", () => {
  it("parses a JSON object of 0..1 numbers", () => {
    expect(parseThresholds('{"adult":0.5,"hate":0.4}')).toEqual({ adult: 0.5, hate: 0.4 });
  });
  it("rejects malformed JSON, non-objects, and out-of-range values", () => {
    expect(() => parseThresholds("{bad}")).toThrow(/not valid JSON/);
    expect(() => parseThresholds("[0.5]")).toThrow(/must be a JSON object/);
    expect(() => parseThresholds('{"adult":1.5}')).toThrow(/in \[0, 1\]/);
  });
});

describe("extractScores", () => {
  it("parses and clamps scores, tolerating fences", () => {
    expect(extractScores('```json\n{"adult":0.9,"hate":1.4,"violence":-0.2}\n```')).toEqual({
      adult: 0.9,
      hate: 1,
      violence: 0,
    });
  });
  it("returns {} on unparseable input", () => {
    expect(extractScores("no json")).toEqual({});
  });
});

describe("decide (fail-closed, per-category)", () => {
  const thresholds = { adult: 0.5, violence: 0.6, hate: 0.4 };

  it("blocks when any category meets its threshold", () => {
    const d = decide({ adult: 0.9, violence: 0.1, hate: 0.1 }, thresholds);
    expect(d).toEqual({ status: "blocked", decision: "block", flagged: ["adult"] });
  });

  it("approves when every category is comfortably clear", () => {
    expect(decide({ adult: 0.1, violence: 0.1, hate: 0.1 }, thresholds).status).toBe("approved");
  });

  it("escalates a borderline score just below the threshold", () => {
    // hate 0.35 is within 0.1 of its 0.4 threshold -> needs_review, not approved
    const d = decide({ adult: 0.1, violence: 0.1, hate: 0.35 }, thresholds);
    expect(d.status).toBe("needs_review");
    expect(d.decision).toBe("escalate");
  });

  it("treats a missing category score as 0", () => {
    expect(decide({}, thresholds).status).toBe("approved");
  });

  it("is exclusive-safe at the exact threshold (>= blocks)", () => {
    expect(decide({ adult: 0.5 }, { adult: 0.5 }).status).toBe("blocked");
  });
});

describe("buildImagePrompt", () => {
  it("lists the configured categories and asks for JSON only", () => {
    const p = buildImagePrompt({ adult: 0.5, hate: 0.4 });
    expect(p.userText).toContain("adult, hate");
    expect(p.system).toMatch(/JSON/);
  });
});
