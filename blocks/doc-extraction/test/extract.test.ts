import { describe, expect, it } from "vitest";
import {
  buildExtractionPrompt,
  extractJsonObject,
  schemaCodeFromKey,
  splitByConfidence,
} from "../src/extract.js";

describe("schemaCodeFromKey", () => {
  it("takes the first path segment after the prefix", () => {
    expect(schemaCodeFromKey("documents/invoice/jan.png", "documents/")).toBe("invoice");
  });
  it("returns null when there is no segment", () => {
    expect(schemaCodeFromKey("documents/", "documents/")).toBeNull();
  });
});

describe("buildExtractionPrompt", () => {
  it("lists each field with its description and asks for per-field confidence", () => {
    const p = buildExtractionPrompt({
      total: { type: "numeric", description: "Grand total", required: true },
      vendor: { type: "text", description: "Vendor name" },
    });
    expect(p.userText).toContain("- total (numeric, required): Grand total");
    expect(p.userText).toContain("- vendor (text): Vendor name");
    expect(p.system).toMatch(/confidence/);
  });
});

describe("extractJsonObject", () => {
  it("parses a bare object", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });
  it("recovers JSON wrapped in code fences and prose", () => {
    const text = 'Here is the result:\n```json\n{"a": 1, "b": 2}\n```\nHope that helps.';
    expect(extractJsonObject(text)).toEqual({ a: 1, b: 2 });
  });
  it("returns null on unparseable input", () => {
    expect(extractJsonObject("no json here")).toBeNull();
    expect(extractJsonObject("[1,2,3]")).toBeNull(); // array, not object
  });
});

describe("splitByConfidence", () => {
  const fields = {
    total: { type: "numeric", required: true },
    tax: { type: "numeric" },
    vendor: { type: "text" },
  };

  it("applies confident fields and routes low-confidence ones to review", () => {
    const parsed = {
      total: { value: 100, confidence: 0.98 },
      tax: { value: 7, confidence: 0.4 }, // below threshold
      vendor: { value: "Acme", confidence: 0.9 },
    };
    const r = splitByConfidence(fields, parsed, 0.8);
    expect(r.status).toBe("needs_review");
    expect(r.review.map((x) => x.field)).toEqual(["tax"]);
    expect(r.values).toEqual({ total: 100, tax: 7, vendor: "Acme" });
  });

  it("routes a missing field to review with confidence 0", () => {
    const r = splitByConfidence(fields, { total: { value: 100, confidence: 0.99 }, vendor: { value: "A", confidence: 0.9 } }, 0.8);
    expect(r.review.find((x) => x.field === "tax")).toEqual({ field: "tax", value: null, confidence: 0 });
  });

  it("is ready when every field clears the threshold", () => {
    const parsed = {
      total: { value: 100, confidence: 0.9 },
      tax: { value: 7, confidence: 0.85 },
      vendor: { value: "Acme", confidence: 0.95 },
    };
    expect(splitByConfidence(fields, parsed, 0.8).status).toBe("ready");
  });

  it("treats a bare value (no confidence object) as unconfirmed", () => {
    const r = splitByConfidence({ total: { type: "numeric" } }, { total: 100 }, 0.8);
    expect(r.review).toHaveLength(1);
    expect(r.values["total"]).toBe(100);
  });
});
