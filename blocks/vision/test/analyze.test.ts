import { describe, expect, it } from "vitest";
import {
  buildPrompt,
  extractJsonObject,
  normalizeColors,
  normalizeTags,
  parseAnalysis,
} from "../src/analyze.js";

describe("buildPrompt", () => {
  it("requests only the wanted fields", () => {
    const { system } = buildPrompt({ imageUrl: "https://x/y.jpg", want: ["tags"] });
    expect(system).toContain('"tags"');
    expect(system).not.toContain('"ocrText"');
  });

  // One call for every field, because image tokens dominate the cost — five separate calls means
  // paying for the image five times.
  it("asks for every field in a single call", () => {
    const { system } = buildPrompt({
      imageUrl: "https://x/y.jpg",
      want: ["tags", "caption", "altText", "ocr", "colors"],
    });
    for (const field of ["tags", "caption", "altText", "ocrText", "dominantColors"]) {
      expect(system).toContain(`"${field}"`);
    }
  });

  // Alt text substitutes for the image; a caption adds to it. Models conflate them unless told not
  // to, so the instruction is explicit.
  it("instructs alt text distinctly from caption, including the decorative case", () => {
    const { system } = buildPrompt({ imageUrl: "https://x/y.jpg", want: ["altText"] });
    expect(system).toMatch(/screen-reader/);
    expect(system).toMatch(/empty string/);
    expect(system).toMatch(/Do not begin with "image of"/);
  });

  it("uses high detail for OCR, where small text matters", () => {
    const withOcr = buildPrompt({ imageUrl: "https://x/y.jpg", want: ["ocr"] });
    const withoutOcr = buildPrompt({ imageUrl: "https://x/y.jpg", want: ["tags"] });

    const detailOf = (p: ReturnType<typeof buildPrompt>) =>
      p.parts.find((part) => part.type === "image_url")?.type === "image_url"
        ? (p.parts.find((part) => part.type === "image_url") as { imageUrl: { detail?: string } })
            .imageUrl.detail
        : undefined;

    expect(detailOf(withOcr)).toBe("high");
    expect(detailOf(withoutOcr)).toBe("auto");
  });

  it("includes caller context when supplied", () => {
    const { parts } = buildPrompt({
      imageUrl: "https://x/y.jpg",
      want: ["altText"],
      context: "product listing for a bicycle",
    });
    expect(parts[0]).toMatchObject({ type: "text" });
    expect((parts[0] as { text: string }).text).toContain("bicycle");
  });

  it("respects maxTags", () => {
    const { system } = buildPrompt({ imageUrl: "https://x/y.jpg", want: ["tags"], maxTags: 5 });
    expect(system).toContain("up to 5");
  });
});

describe("extractJsonObject", () => {
  it("parses clean JSON", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  // Every one of these is a real thing models do, and failing an ingestion over a stray fence
  // would be absurd.
  it("strips markdown fences", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject("```\n{\"a\":1}\n```")).toEqual({ a: 1 });
  });

  it("ignores leading and trailing prose", () => {
    expect(extractJsonObject('Here is the analysis:\n{"a":1}\nHope that helps!')).toEqual({ a: 1 });
  });

  // A regex-based extractor truncates here; brace scanning with string awareness does not.
  it("handles braces inside string values", () => {
    expect(extractJsonObject('{"caption":"a sign reading {open}"}')).toEqual({
      caption: "a sign reading {open}",
    });
  });

  it("handles escaped quotes inside strings", () => {
    expect(extractJsonObject('{"caption":"he said \\"hi\\""}')).toEqual({
      caption: 'he said "hi"',
    });
  });

  it("handles nested objects", () => {
    expect(extractJsonObject('{"a":{"b":{"c":1}}}')).toEqual({ a: { b: { c: 1 } } });
  });

  it("returns null when there is no object", () => {
    expect(extractJsonObject("I cannot analyse this image.")).toBeNull();
    expect(extractJsonObject("")).toBeNull();
    expect(extractJsonObject("[1,2,3]")).toBeNull();
  });

  it("returns null for unbalanced or malformed JSON", () => {
    expect(extractJsonObject('{"a":1')).toBeNull();
    expect(extractJsonObject('{"a":}')).toBeNull();
  });
});

describe("normalizeTags", () => {
  it("normalizes an array", () => {
    expect(normalizeTags(["Dog", " Park ", "GRASS"])).toEqual(["dog", "park", "grass"]);
  });

  it("accepts a comma-separated string, which models sometimes return instead", () => {
    expect(normalizeTags("dog, park, grass")).toEqual(["dog", "park", "grass"]);
  });

  // Storing both "Dog" and "dog" makes facet counts wrong.
  it("deduplicates case-insensitively", () => {
    expect(normalizeTags(["Dog", "dog", "DOG"])).toEqual(["dog"]);
  });

  it("skips non-strings rather than failing the whole analysis", () => {
    expect(normalizeTags(["dog", null, 42, undefined, "cat"])).toEqual(["dog", "cat"]);
  });

  it("collapses internal whitespace", () => {
    expect(normalizeTags(["golden   retriever"])).toEqual(["golden retriever"]);
  });

  it("returns empty for unusable input", () => {
    expect(normalizeTags(null)).toEqual([]);
    expect(normalizeTags({})).toEqual([]);
    expect(normalizeTags(["", "   "])).toEqual([]);
  });

  it("caps the count", () => {
    expect(normalizeTags(Array.from({ length: 100 }, (_, i) => `tag${i}`), 5)).toHaveLength(5);
  });
});

describe("normalizeColors", () => {
  it("keeps valid hex colours, lowercased", () => {
    expect(normalizeColors(["#FF0000", "#00ff00"])).toEqual(["#ff0000", "#00ff00"]);
  });

  // #f00 and #ff0000 are the same colour and must not become two distinct stored values.
  it("expands shorthand hex so values are comparable", () => {
    expect(normalizeColors(["#f00"])).toEqual(["#ff0000"]);
  });

  it("accepts colours without the leading hash", () => {
    expect(normalizeColors(["ff0000"])).toEqual(["#ff0000"]);
  });

  it("drops invalid entries", () => {
    expect(normalizeColors(["red", "#ggg", "#ff00", 42, null])).toEqual([]);
  });

  it("returns empty for non-arrays", () => {
    expect(normalizeColors("#ff0000")).toEqual([]);
  });
});

describe("parseAnalysis", () => {
  it("parses a complete response", () => {
    const analysis = parseAnalysis(
      JSON.stringify({
        tags: ["dog", "park"],
        caption: "A dog running in a park.",
        altText: "A golden retriever mid-stride on grass",
        ocrText: null,
        dominantColors: ["#4a7c2f"],
        confidence: 0.9,
      }),
      "gpt-5-mini",
    );

    expect(analysis).toMatchObject({
      tags: ["dog", "park"],
      caption: "A dog running in a park.",
      altText: "A golden retriever mid-stride on grass",
      ocrText: null,
      dominantColors: ["#4a7c2f"],
      confidence: 0.9,
      model: "gpt-5-mini",
    });
  });

  // alt="" is correct markup for a decorative image and is NOT the same as no alt attribute.
  // Collapsing it to null is an accessibility regression.
  it("preserves an empty alt text, which means decorative", () => {
    const analysis = parseAnalysis('{"altText":""}', "m");
    expect(analysis.altText).toBe("");
    expect(analysis.altText).not.toBeNull();
  });

  it("strips redundant alt-text prefixes that screen readers already announce", () => {
    expect(parseAnalysis('{"altText":"Image of a red bicycle"}', "m").altText).toBe(
      "a red bicycle",
    );
    expect(parseAnalysis('{"altText":"A photo showing two cats"}', "m").altText).toBe("two cats");
  });

  it("normalizes confidence reported as a percentage", () => {
    expect(parseAnalysis('{"confidence":85}', "m").confidence).toBeCloseTo(0.85, 5);
    expect(parseAnalysis('{"confidence":0.85}', "m").confidence).toBeCloseTo(0.85, 5);
  });

  it("clamps out-of-range confidence", () => {
    expect(parseAnalysis('{"confidence":-5}', "m").confidence).toBe(0);
    expect(parseAnalysis('{"confidence":"not a number"}', "m").confidence).toBeNull();
  });

  it("tolerates missing fields", () => {
    const analysis = parseAnalysis('{"tags":["a"]}', "m");
    expect(analysis.caption).toBeNull();
    expect(analysis.dominantColors).toEqual([]);
  });

  it("throws a retryable error when no JSON is present", () => {
    expect(() => parseAnalysis("I cannot help with that.", "m")).toThrow(/did not return a JSON/);
    try {
      parseAnalysis("nope", "m");
    } catch (err) {
      // Retryable: usually a transient formatting lapse, not a permanent failure.
      expect((err as { retryable: boolean }).retryable).toBe(true);
    }
  });
});
