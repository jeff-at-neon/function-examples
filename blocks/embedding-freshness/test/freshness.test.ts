import { describe, expect, it } from "vitest";
import {
  buildCandidateSql,
  buildRowText,
  contentHash,
  diffRows,
  nextWatermark,
} from "../src/freshness.js";

describe("buildRowText / contentHash", () => {
  it("hashes only the declared text columns, in order", () => {
    const a = buildRowText({ title: "Hi", body: "There", views: 1 }, ["title", "body"]);
    const b = buildRowText({ title: "Hi", body: "There", views: 999 }, ["title", "body"]);
    // an unrelated column changing must not change the hash — that would pay for a needless re-embed
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it("changes the hash when a text column changes", () => {
    const a = contentHash(buildRowText({ title: "Hi" }, ["title"]));
    const b = contentHash(buildRowText({ title: "Hello" }, ["title"]));
    expect(a).not.toBe(b);
  });

  it("treats null columns as empty", () => {
    expect(buildRowText({ title: null }, ["title"])).toBe("");
  });
});

describe("nextWatermark", () => {
  const t = (s: string) => `2026-01-01T00:00:${s}Z`;

  it("advances to the highest row examined, not now()", () => {
    const wm = nextWatermark([t("10"), t("30"), t("20")], t("05"));
    expect(wm).toBe(new Date(t("30")).toISOString());
  });

  // Regression for the skip-forever bug: with nothing examined, the watermark must not move.
  it("stays put on an empty batch", () => {
    expect(nextWatermark([], t("05"))).toBe(new Date(t("05")).toISOString());
  });

  it("never moves backwards below the current watermark", () => {
    expect(nextWatermark([t("01")], t("20"))).toBe(new Date(t("20")).toISOString());
  });

  it("advances from a -infinity default", () => {
    expect(nextWatermark([t("10")], "-infinity")).toBe(new Date(t("10")).toISOString());
  });

  // A row modified mid-scan (after the max examined) is not covered by the new watermark, so the
  // next scan's `updated_column > watermark` still catches it.
  it("leaves a later-than-examined row uncovered", () => {
    const wm = nextWatermark([t("10"), t("20")], t("05"));
    expect(new Date(t("30")).getTime()).toBeGreaterThan(new Date(wm).getTime());
  });
});

describe("diffRows", () => {
  it("re-embeds rows with no stored hash or a changed hash, keeps matches", () => {
    const { toReembed, unchanged } = diffRows(
      [
        { rowKey: "1", contentHash: "aaa" }, // unchanged
        { rowKey: "2", contentHash: "new" }, // changed
        { rowKey: "3", contentHash: "ccc" }, // never embedded
      ],
      new Map([
        ["1", "aaa"],
        ["2", "old"],
      ]),
    );
    expect(unchanged).toEqual(["1"]);
    expect(toReembed.map((c) => c.rowKey).sort()).toEqual(["2", "3"]);
  });
});

describe("buildCandidateSql", () => {
  const base = {
    code: "docs",
    source_schema: "public",
    source_table: "articles",
    key_column: "id",
    text_columns: ["title", "body"],
    updated_column: "updated_at",
    vector_schema: "public",
    vector_table: "articles",
    vector_column: "embedding",
    watermark: "-infinity",
  };

  it("quotes legal identifiers", () => {
    const sql = buildCandidateSql(base);
    expect(sql).toContain('"public"."articles"');
    expect(sql).toContain('"title"');
    expect(sql).toContain('"updated_at"');
  });

  it("rejects a hostile identifier rather than escaping it", () => {
    expect(() => buildCandidateSql({ ...base, source_table: 'weird";drop' })).toThrow(
      /Unsafe SQL identifier/,
    );
    expect(() => buildCandidateSql({ ...base, text_columns: ["a b"] })).toThrow(
      /Unsafe SQL identifier/,
    );
  });

  it("refuses an outbox-only source", () => {
    expect(() => buildCandidateSql({ ...base, updated_column: null })).toThrow(/outbox-driven/);
  });
});
