import { describe, expect, it } from "vitest";
import { extractJson, requireObject, StructuredParseError, validateStructured } from "../src/structured.js";

describe("extractJson", () => {
  it("parses a bare JSON object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("unwraps a fenced code block", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("recovers an object embedded in prose", () => {
    expect(extractJson('Sure! Here it is: {"a":1} Enjoy.')).toEqual({ a: 1 });
  });

  it("throws when there is no JSON", () => {
    expect(() => extractJson("no json here")).toThrow(StructuredParseError);
  });
});

describe("requireObject", () => {
  it("accepts a plain object", () => {
    expect(requireObject({ a: 1 })).toEqual({ a: 1 });
  });

  it("rejects arrays and primitives", () => {
    expect(() => requireObject([1, 2])).toThrow(StructuredParseError);
    expect(() => requireObject("x")).toThrow(StructuredParseError);
    expect(() => requireObject(null)).toThrow(StructuredParseError);
  });
});

describe("validateStructured", () => {
  it("parses then runs the validator", () => {
    const validate = (v: unknown): { n: number } => {
      const o = requireObject(v);
      if (typeof o["n"] !== "number") throw new StructuredParseError("n must be a number");
      return { n: o["n"] };
    };
    expect(validateStructured('{"n":42}', validate)).toEqual({ n: 42 });
    expect(() => validateStructured('{"n":"nope"}', validate)).toThrow(StructuredParseError);
  });
});
