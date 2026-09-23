import { describe, expect, it } from "vitest";
import { verifyLinkage } from "../src/chain.js";

describe("verifyLinkage", () => {
  it("accepts an intact chain", () => {
    const entries = [
      { id: 1, prev_hash: null, entry_hash: "h1" },
      { id: 2, prev_hash: "h1", entry_hash: "h2" },
      { id: 3, prev_hash: "h2", entry_hash: "h3" },
    ];
    expect(verifyLinkage(entries)).toEqual({ ok: true, brokenAt: null });
  });

  it("detects a removed middle entry", () => {
    // entry 2 deleted: entry 3 still points at h2 but the previous entry is now h1
    const entries = [
      { id: 1, prev_hash: null, entry_hash: "h1" },
      { id: 3, prev_hash: "h2", entry_hash: "h3" },
    ];
    expect(verifyLinkage(entries)).toEqual({ ok: false, brokenAt: 3 });
  });

  it("detects an edited entry that breaks its successor's link", () => {
    const entries = [
      { id: 1, prev_hash: null, entry_hash: "h1" },
      { id: 2, prev_hash: "h1", entry_hash: "tampered" },
      { id: 3, prev_hash: "h2", entry_hash: "h3" }, // expects prev h2, but got 'tampered'
    ];
    expect(verifyLinkage(entries)).toEqual({ ok: false, brokenAt: 3 });
  });

  it("accepts an empty chain", () => {
    expect(verifyLinkage([])).toEqual({ ok: true, brokenAt: null });
  });
});
