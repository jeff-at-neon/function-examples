import { describe, expect, it } from "vitest";
import { csvEscape, parseCsv, toCsv } from "../src/parse.js";

describe("parseCsv (RFC 4180)", () => {
  it("keeps a quoted comma as one field", () => {
    expect(parseCsv('"a,b",c')).toEqual([["a,b", "c"]]);
  });

  it("keeps an embedded newline inside a quoted field", () => {
    expect(parseCsv('"line1\nline2",x')).toEqual([["line1\nline2", "x"]]);
  });

  it("unescapes doubled quotes", () => {
    expect(parseCsv('"she said ""hi"""')).toEqual([['she said "hi"']]);
  });

  it("handles CRLF and LF line endings", () => {
    expect(parseCsv("a,b\r\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(parseCsv("a,b\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("does not add an empty row for a trailing newline", () => {
    expect(parseCsv("a,b\n")).toEqual([["a", "b"]]);
  });

  it("preserves empty fields between commas", () => {
    expect(parseCsv("a,,b")).toEqual([["a", "", "b"]]);
  });

  it("parses an empty string as no rows", () => {
    expect(parseCsv("")).toEqual([]);
  });
});

describe("csvEscape / toCsv round-trip", () => {
  it("quotes fields with commas, quotes, or newlines", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('a"b')).toBe('"a""b"');
    expect(csvEscape("plain")).toBe("plain");
  });

  it("round-trips through parseCsv", () => {
    const rows = [
      ["name", "note"],
      ['O"Brien', "a, b\nc"],
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});
