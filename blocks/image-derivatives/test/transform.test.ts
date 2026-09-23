import { describe, expect, it } from "vitest";
import { derivativeKeyFor, parseTransform } from "../src/transform.js";

const widths = [64, 128, 256, 512];
const q = (s: string) => new URLSearchParams(s);

describe("parseTransform", () => {
  it("accepts an allowlisted width with defaults", () => {
    expect(parseTransform(q("w=256"), widths)).toEqual({ width: 256, height: null, format: "webp", fit: "cover" });
  });

  // The cost-amplification guard: arbitrary widths are refused.
  it("rejects a width not on the allowlist", () => {
    expect(() => parseTransform(q("w=257"), widths)).toThrow(/not permitted/);
  });

  it("requires a width", () => {
    expect(() => parseTransform(q("f=png"), widths)).toThrow(/width\) is required/);
  });

  it("validates height, format, and fit", () => {
    expect(() => parseTransform(q("w=128&h=99999"), widths)).toThrow(/between 1 and 8192/);
    expect(() => parseTransform(q("w=128&f=tiff"), widths)).toThrow(/one of webp/);
    expect(() => parseTransform(q("w=128&fit=squish"), widths)).toThrow(/one of cover/);
  });
});

describe("derivativeKeyFor", () => {
  it("includes basename, dimensions, fit, and an etag prefix", () => {
    const key = derivativeKeyFor("derived/", "uploads/photos/cat.jpg", "abcdef1234567890", {
      width: 256,
      height: null,
      format: "webp",
      fit: "cover",
    });
    expect(key).toBe("derived/cat-w256-cover-abcdef12.webp");
  });

  it("encodes height when present", () => {
    const key = derivativeKeyFor("d/", "a.png", "0011223344", { width: 100, height: 50, format: "png", fit: "fill" });
    expect(key).toBe("d/a-w100h50-fill-00112233.png");
  });
});
