import { describe, expect, it } from "vitest";
import { parseCreate, parsePagination, parsePatch } from "../src/validate.js";

describe("parseCreate", () => {
  it("accepts a title and defaults done to false", () => {
    expect(parseCreate({ title: "buy milk" })).toEqual({ title: "buy milk", done: false });
  });

  it("trims the title and keeps an explicit done", () => {
    expect(parseCreate({ title: "  tidy up  ", done: true })).toEqual({ title: "tidy up", done: true });
  });

  it("rejects a missing, empty, or non-string title", () => {
    expect(() => parseCreate({})).toThrow();
    expect(() => parseCreate({ title: "" })).toThrow();
    expect(() => parseCreate({ title: "   " })).toThrow();
    expect(() => parseCreate({ title: 42 })).toThrow();
  });

  it("rejects a non-boolean done", () => {
    expect(() => parseCreate({ title: "x", done: "yes" })).toThrow();
  });

  it("rejects a non-object body", () => {
    expect(() => parseCreate([1, 2])).toThrow();
    expect(() => parseCreate("nope")).toThrow();
  });
});

describe("parsePatch", () => {
  it("accepts a partial update", () => {
    expect(parsePatch({ done: true })).toEqual({ done: true });
    expect(parsePatch({ title: "renamed" })).toEqual({ title: "renamed" });
  });

  it("requires at least one field", () => {
    expect(() => parsePatch({})).toThrow();
  });
});

describe("parsePagination", () => {
  it("defaults to the page size and offset 0", () => {
    expect(parsePagination(new URLSearchParams(""), 50)).toEqual({ limit: 50, offset: 0 });
  });

  it("clamps limit to the page size rather than rejecting", () => {
    expect(parsePagination(new URLSearchParams("limit=999"), 50)).toEqual({ limit: 50, offset: 0 });
  });

  it("clamps limit up to at least 1", () => {
    expect(parsePagination(new URLSearchParams("limit=0"), 50).limit).toBe(1);
  });

  it("reads offset", () => {
    expect(parsePagination(new URLSearchParams("limit=10&offset=20"), 50)).toEqual({ limit: 10, offset: 20 });
  });

  it("rejects a non-integer limit", () => {
    expect(() => parsePagination(new URLSearchParams("limit=abc"), 50)).toThrow();
  });
});
