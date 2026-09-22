import { describe, expect, it } from "vitest";
import { isDerivative, isWatched, jobsForKind, parseRoutes } from "../src/routes.js";
import { assertNoLoop, LoopHazardError } from "@neon-blocks/core";

describe("parseRoutes", () => {
  it("parses a route table", () => {
    expect(parseRoutes('{"image":["vision.tag"],"pdf":["rag.ingest","doc.extract"]}')).toEqual({
      image: ["vision.tag"],
      pdf: ["rag.ingest", "doc.extract"],
    });
  });

  it("accepts an empty table", () => {
    expect(parseRoutes("{}")).toEqual({});
  });

  // A typo like "images" silently routes nothing while the router keeps reporting success — the
  // worst class of config bug, so it must fail loudly at startup.
  it("rejects unknown kinds", () => {
    expect(() => parseRoutes('{"images":["a.b"]}')).toThrow(/unknown kind "images"/);
    expect(() => parseRoutes('{"IMAGE":["a.b"]}')).toThrow(/unknown kind/);
  });

  it("lists the valid kinds in the error, so the fix is obvious", () => {
    expect(() => parseRoutes('{"typo":["a.b"]}')).toThrow(/image, pdf, document/);
  });

  it("rejects malformed JSON and non-objects", () => {
    expect(() => parseRoutes("{image:[]}")).toThrow(/not valid JSON/);
    expect(() => parseRoutes("[]")).toThrow(/must be a JSON object/);
    expect(() => parseRoutes('"x"')).toThrow(/must be a JSON object/);
  });

  it("requires an array of job types", () => {
    expect(() => parseRoutes('{"image":"vision.tag"}')).toThrow(/must be an array/);
    expect(() => parseRoutes('{"image":[1]}')).toThrow(/must be an array/);
    expect(() => parseRoutes('{"image":[""]}')).toThrow(/must be an array/);
  });

  // Validated here so an invalid type fails at startup rather than at enqueue time, by which point
  // the object has already been consumed.
  it("rejects job types the queue would reject", () => {
    expect(() => parseRoutes('{"image":["Vision.Tag"]}')).toThrow(/invalid job type/);
    expect(() => parseRoutes('{"image":["vision tag"]}')).toThrow(/invalid job type/);
    expect(() => parseRoutes('{"image":["1bad"]}')).toThrow(/invalid job type/);
  });
});

describe("jobsForKind", () => {
  const routes = parseRoutes('{"image":["vision.tag"]}');

  it("returns configured jobs", () => {
    expect(jobsForKind(routes, "image")).toEqual(["vision.tag"]);
  });

  // Empty is a deliberate outcome recorded as "unrouted", not an error.
  it("returns empty for an unconfigured kind", () => {
    expect(jobsForKind(routes, "pdf")).toEqual([]);
    expect(jobsForKind(routes, "unknown")).toEqual([]);
  });
});

describe("isWatched", () => {
  it("matches keys under the prefix", () => {
    expect(isWatched("uploads/a/b.png", "uploads/")).toBe(true);
    expect(isWatched("uploads/a/b.png", "uploads")).toBe(true);
  });

  it("rejects keys outside it", () => {
    expect(isWatched("other/a.png", "uploads/")).toBe(false);
    // Prefix confusion: "uploads2/" starts with "uploads" but is a different location.
    expect(isWatched("uploads2/a.png", "uploads/")).toBe(false);
  });

  it("matches everything when the prefix is empty", () => {
    expect(isWatched("anything.png", "")).toBe(true);
  });
});

describe("isDerivative", () => {
  // This is the guard against an infinite, billable loop: there is no negative prefix filter on
  // storage triggers, so a derivative written into the watched bucket comes straight back here.
  it("recognises output at the top level", () => {
    expect(isDerivative("derived/thumb.jpg", "derived/")).toBe(true);
  });

  it("recognises output nested under the watched prefix", () => {
    // The dangerous case: the key begins with the watched prefix, so a naive startsWith check
    // against the output prefix would miss it and the loop would run forever.
    expect(isDerivative("uploads/tenant/derived/thumb.jpg", "derived/")).toBe(true);
  });

  it("does not match ordinary uploads", () => {
    expect(isDerivative("uploads/tenant/photo.jpg", "derived/")).toBe(false);
  });

  it("does not match a prefix that merely shares a stem", () => {
    expect(isDerivative("uploads/derived-notes.txt", "derived/")).toBe(false);
  });

  it("tolerates a prefix given without a trailing slash", () => {
    expect(isDerivative("derived/x.jpg", "derived")).toBe(true);
  });

  it("is inert when no output prefix is configured", () => {
    expect(isDerivative("anything", "")).toBe(false);
  });
});

describe("assertNoLoop", () => {
  it("allows separate buckets unconditionally", () => {
    expect(() =>
      assertNoLoop({ inputBucket: "in", outputBucket: "out", inputPrefix: "", outputPrefix: "" }),
    ).not.toThrow();
  });

  it("allows disjoint prefixes in one bucket", () => {
    expect(() =>
      assertNoLoop({
        inputBucket: "b",
        outputBucket: "b",
        inputPrefix: "uploads/",
        outputPrefix: "derived/",
      }),
    ).not.toThrow();
  });

  it("refuses to start when either prefix is empty in a shared bucket", () => {
    expect(() =>
      assertNoLoop({
        inputBucket: "b",
        outputBucket: "b",
        inputPrefix: "",
        outputPrefix: "derived/",
      }),
    ).toThrow(LoopHazardError);
  });

  // "uploads/" and "uploads/thumbs/" is a loop: a write under uploads/thumbs/ still matches a
  // trigger watching uploads/.
  it("refuses nested prefixes, which still match the trigger", () => {
    expect(() =>
      assertNoLoop({
        inputBucket: "b",
        outputBucket: "b",
        inputPrefix: "uploads/",
        outputPrefix: "uploads/thumbs/",
      }),
    ).toThrow(/overlaps watched prefix/);
  });

  it("explains why, since the failure mode is a runaway bill", () => {
    expect(() =>
      assertNoLoop({
        inputBucket: "b",
        outputBucket: "b",
        inputPrefix: "u/",
        outputPrefix: "u/d/",
      }),
    ).toThrow(/no negative prefix filter/);
  });
});
