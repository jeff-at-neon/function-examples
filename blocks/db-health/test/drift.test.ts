import { describe, expect, it } from "vitest";
import { buildCatalogSql, diffCatalogs, type Column } from "../src/drift.js";

const col = (table: string, column: string, type = "text"): Column => ({
  table_schema: "public",
  table_name: table,
  column_name: column,
  data_type: type,
});

describe("diffCatalogs", () => {
  it("reports nothing for identical catalogs", () => {
    const cat = [col("users", "id"), col("users", "email")];
    expect(diffCatalogs(cat, cat)).toEqual([]);
  });

  it("warns on a column present in the parent but missing here (migration not applied)", () => {
    const current = [col("users", "id")];
    const parent = [col("users", "id"), col("users", "email")];
    const findings = diffCatalogs(current, parent);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "warn", objectName: "public.users.email" });
    expect(findings[0]?.detail).toMatch(/missing here/);
  });

  it("flags a column present here but not the parent as info (not promoted)", () => {
    const current = [col("users", "id"), col("users", "nickname")];
    const parent = [col("users", "id")];
    const findings = diffCatalogs(current, parent);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "info", objectName: "public.users.nickname" });
  });

  it("warns on a data-type mismatch", () => {
    const current = [col("users", "age", "integer")];
    const parent = [col("users", "age", "bigint")];
    const findings = diffCatalogs(current, parent);
    expect(findings[0]).toMatchObject({ severity: "warn" });
    expect(findings[0]?.detail).toMatch(/Type differs/);
  });
});

describe("buildCatalogSql", () => {
  it("excludes system and block schemas", () => {
    const sql = buildCatalogSql();
    expect(sql).toMatch(/information_schema\.columns/);
    expect(sql).toMatch(/NOT LIKE 'blocks_%'/);
  });
});
