import { describe, expect, it } from "vitest";
import {
  assembleExportDoc,
  buildAnonymizeSql,
  buildEraseSql,
  buildSubjectSelectSql,
  filterHeld,
  summarizeCounts,
} from "../src/subject.js";

const link = { target_schema: "public", target_table: "users", subject_column: "email", handling: "erase" };

describe("SQL builders", () => {
  it("quote identifiers and bind the subject ref", () => {
    expect(buildSubjectSelectSql(link)).toBe('SELECT * FROM "public"."users" WHERE "email" = $1');
    expect(buildEraseSql(link)).toBe('DELETE FROM "public"."users" WHERE "email" = $1');
    expect(buildAnonymizeSql(link)).toContain("SET \"email\" = '[erased]'");
  });

  it("reject a hostile identifier", () => {
    expect(() => buildSubjectSelectSql({ ...link, target_table: "x;drop" })).toThrow(
      /Unsafe SQL identifier/,
    );
  });
});

describe("assembleExportDoc / summarizeCounts", () => {
  it("keys export data by table", () => {
    const doc = assembleExportDoc([
      { table: "public.users", rows: [{ email: "a@b.com" }] },
      { table: "public.orders", rows: [] },
    ]);
    expect(Object.keys(doc)).toEqual(["public.users", "public.orders"]);
  });

  it("sums counts per table", () => {
    expect(summarizeCounts([{ table: "public.users", count: 3 }, { table: "public.users", count: 2 }])).toEqual(
      { "public.users": 5 },
    );
  });
});

describe("filterHeld", () => {
  it("excludes a subject under an active hold", () => {
    expect(filterHeld(["a", "b", "c"], [{ subject_ref: "b" }])).toEqual(["a", "c"]);
  });

  it("suppresses the entire purge under a global (null subject) hold", () => {
    expect(filterHeld(["a", "b"], [{ subject_ref: null }])).toEqual([]);
  });

  it("passes everything through with no holds", () => {
    expect(filterHeld(["a", "b"], [])).toEqual(["a", "b"]);
  });
});
