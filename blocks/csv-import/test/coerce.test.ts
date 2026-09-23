import { describe, expect, it } from "vitest";
import { buildRejectedCsv, coerceValue, mapHeaders, validateRow } from "../src/coerce.js";
import { buildInsertSql } from "../src/merge.js";
import { parseCsv } from "../src/parse.js";
import { definitionCodeFromKey } from "../src/import.js";

describe("coerceValue", () => {
  it("keeps a leading-zero zip as text", () => {
    expect(coerceValue("02134", "text")).toEqual({ value: "02134" });
  });

  it("coerces declared integers and rejects non-integers", () => {
    expect(coerceValue("42", "int")).toEqual({ value: 42 });
    expect(coerceValue("4.5", "int")).toHaveProperty("error");
    expect(coerceValue("02134", "int")).toEqual({ value: 2134 }); // only when declared int
  });

  it("coerces booleans by common spellings", () => {
    expect(coerceValue("yes", "bool")).toEqual({ value: true });
    expect(coerceValue("0", "bool")).toEqual({ value: false });
    expect(coerceValue("maybe", "bool")).toHaveProperty("error");
  });

  it("rejects an invalid date and an unknown type", () => {
    expect(coerceValue("not-a-date", "date")).toHaveProperty("error");
    expect(coerceValue("x", "geography")).toHaveProperty("error");
  });
});

const columnMap = {
  Email: { column: "email", type: "text", required: true },
  Age: { column: "age", type: "int" },
  Country: { column: "country", type: "text", default: "US" },
};

describe("mapHeaders", () => {
  it("maps known headers by position and ignores unknown ones", () => {
    const m = mapHeaders(["Email", "Extra", "Age"], columnMap);
    expect(m.map((x) => x.header)).toEqual(["Email", "Age"]);
    expect(m.map((x) => x.index)).toEqual([0, 2]);
  });
});

describe("validateRow", () => {
  const mapping = mapHeaders(["Email", "Age", "Country"], columnMap);

  it("collects multiple errors in one pass rather than throwing on the first", () => {
    const { errors } = validateRow(["", "notnum", ""], mapping, 2);
    expect(errors).toHaveLength(2); // missing required email + bad int age
    expect(errors.map((e) => e.column).sort()).toEqual(["Age", "Email"]);
  });

  it("applies a default for an empty optional column", () => {
    const { values, errors } = validateRow(["a@b.com", "30", ""], mapping, 2);
    expect(errors).toHaveLength(0);
    expect(values).toEqual({ email: "a@b.com", age: 30, country: "US" });
  });
});

describe("buildRejectedCsv", () => {
  it("appends line + reasons and re-parses cleanly", () => {
    const csv = buildRejectedCsv(
      ["Email", "Age"],
      [{ line: 2, cells: ["", "x,y"], errors: [{ line: 2, column: "Email", reason: "required value is missing" }] }],
    );
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual(["Email", "Age", "_line", "_errors"]);
    expect(rows[1]?.[1]).toBe("x,y"); // comma preserved through the report round-trip
    expect(rows[1]?.[2]).toBe("2");
  });
});

describe("buildInsertSql", () => {
  const def = { target_schema: "public", target_table: "customers", conflict_keys: ["email"] };

  it("upserts on the conflict keys, quoting identifiers", () => {
    const sql = buildInsertSql(def, ["email", "age"], 2);
    expect(sql).toContain('INSERT INTO "public"."customers" ("email", "age")');
    expect(sql).toContain("($1, $2), ($3, $4)");
    expect(sql).toContain('ON CONFLICT ("email") DO UPDATE SET "age" = EXCLUDED."age"');
  });

  it("is a plain insert with no conflict keys", () => {
    const sql = buildInsertSql({ ...def, conflict_keys: [] }, ["email"], 1);
    expect(sql).not.toContain("ON CONFLICT");
  });

  it("rejects a hostile identifier", () => {
    expect(() => buildInsertSql({ ...def, target_table: "x;drop" }, ["email"], 1)).toThrow(
      /Unsafe SQL identifier/,
    );
  });
});

describe("definitionCodeFromKey", () => {
  it("takes the first path segment after the prefix", () => {
    expect(definitionCodeFromKey("imports/customers/jan.csv", "imports/")).toBe("customers");
  });

  it("returns null when there is no segment", () => {
    expect(definitionCodeFromKey("imports/", "imports/")).toBeNull();
  });
});
