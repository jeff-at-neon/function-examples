import { describe, expect, it } from "vitest";
import { buildSelectBatchSql, buildUpdateSql, isBranchAllowed, mergeProgress, ruleKey } from "../src/run.js";

const rule = {
  id: "r1",
  target_schema: "public",
  target_table: "users",
  target_column: "email",
  strategy: "email",
};

describe("isBranchAllowed", () => {
  const pattern = "^(dev|preview|staging|test)";

  it("allows matching branch names", () => {
    expect(isBranchAllowed("dev", pattern)).toBe(true);
    expect(isBranchAllowed("staging-42", pattern)).toBe(true);
  });

  it("refuses production-like and empty names", () => {
    expect(isBranchAllowed("main", pattern)).toBe(false);
    expect(isBranchAllowed("production", pattern)).toBe(false);
    expect(isBranchAllowed(null, pattern)).toBe(false);
    expect(isBranchAllowed("", pattern)).toBe(false);
  });
});

describe("buildUpdateSql", () => {
  it("builds a single-key VALUES-join update, quoting identifiers", () => {
    const sql = buildUpdateSql(rule, ["id"], 2);
    expect(sql).toContain('UPDATE "public"."users" AS tgt');
    expect(sql).toContain('SET "email" = data.new_value');
    expect(sql).toContain("($1, $2), ($3, $4)"); // 1 key + value, two rows
    expect(sql).toContain('tgt."id"::text = data.k0');
  });

  it("ties every column of a composite key", () => {
    const sql = buildUpdateSql(rule, ["tenant", "id"], 1);
    expect(sql).toContain('tgt."tenant"::text = data.k0 AND tgt."id"::text = data.k1');
    expect(sql).toContain("($1, $2, $3)"); // 2 keys + value
  });

  it("rejects a hostile identifier and an empty key", () => {
    expect(() => buildUpdateSql({ ...rule, target_table: "x;drop" }, ["id"], 1)).toThrow(
      /Unsafe SQL identifier/,
    );
    expect(() => buildUpdateSql(rule, [], 1)).toThrow(/at least one key column/);
  });
});

describe("buildSelectBatchSql", () => {
  it("adds a composite tuple cursor only when resuming", () => {
    expect(buildSelectBatchSql(rule, ["id"], false)).toContain("LIMIT $1");
    const cursored = buildSelectBatchSql(rule, ["tenant", "id"], true);
    expect(cursored).toContain('("tenant", "id") > ($1, $2)');
    expect(cursored).toContain("LIMIT $3");
  });
});

describe("mergeProgress", () => {
  it("accumulates rows across batches", () => {
    const key = ruleKey(rule);
    let detail: Record<string, unknown> = {};
    detail = mergeProgress(detail, key, { rowsMasked: 100, done: false, cursor: [100] });
    detail = mergeProgress(detail, key, { rowsMasked: 50, done: true, cursor: [150] });
    expect(detail[key]).toEqual({ rowsMasked: 150, done: true, cursor: [150] });
  });
});
