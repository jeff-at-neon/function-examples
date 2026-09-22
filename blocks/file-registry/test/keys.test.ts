import { describe, expect, it } from "vitest";
import {
  assertKeyBelongsToTenant,
  buildObjectKey,
  parseTenantFromKey,
  sanitizeFilename,
} from "../src/keys.js";

describe("buildObjectKey", () => {
  it("builds prefix/tenant/id/filename", () => {
    expect(
      buildObjectKey({ prefix: "uploads/", tenant: "acme", id: "abc123", filename: "report.pdf" }),
    ).toBe("uploads/acme/abc123/report.pdf");
  });

  it("adds a missing trailing slash to the prefix", () => {
    expect(
      buildObjectKey({ prefix: "uploads", tenant: "acme", id: "x", filename: "a.txt" }),
    ).toBe("uploads/acme/x/a.txt");
  });

  it("supports an empty prefix", () => {
    expect(buildObjectKey({ prefix: "", tenant: "acme", id: "x", filename: "a.txt" })).toBe(
      "acme/x/a.txt",
    );
  });

  // The charset excludes dots entirely, so `..` is not expressible in a tenant or id segment.
  it("rejects traversal and separators in the tenant", () => {
    for (const tenant of ["..", "a/b", "a.b", "", "a b", "../../etc"]) {
      expect(() =>
        buildObjectKey({ prefix: "uploads/", tenant, id: "x", filename: "a.txt" }),
      ).toThrow(/Invalid tenant/);
    }
  });

  it("rejects traversal in the id", () => {
    expect(() =>
      buildObjectKey({ prefix: "uploads/", tenant: "acme", id: "../evil", filename: "a.txt" }),
    ).toThrow(/Invalid id/);
  });

  it("rejects an over-length tenant", () => {
    expect(() =>
      buildObjectKey({ prefix: "u/", tenant: "a".repeat(65), id: "x", filename: "f" }),
    ).toThrow(/Invalid tenant/);
  });

  it("rejects keys over the 1024-byte trigger prefix limit", () => {
    expect(() =>
      buildObjectKey({
        prefix: "uploads/",
        tenant: "acme",
        id: "abc",
        filename: `${"a".repeat(120)}.txt`.repeat(1),
      }),
    ).not.toThrow();

    expect(() =>
      buildObjectKey({ prefix: "x".repeat(1_100) + "/", tenant: "a", id: "b", filename: "c" }),
    ).toThrow(/over the 1024 limit/);
  });
});

describe("sanitizeFilename", () => {
  // Never throws: the filename is cosmetic because the id segment already guarantees uniqueness.
  it("keeps only the final path segment, discarding any directory components", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Users\\a\\file.txt")).toBe("file.txt");
    expect(sanitizeFilename("a/b/c/deep.txt")).toBe("deep.txt");
  });

  it("removes leading dots so no hidden or traversal segment survives", () => {
    expect(sanitizeFilename(".hidden")).toBe("hidden");
    expect(sanitizeFilename("..")).toBe("file");
    expect(sanitizeFilename("...x")).toBe("x");
  });

  it("replaces unexpected characters and collapses runs", () => {
    expect(sanitizeFilename("my file (1).pdf")).toBe("my-file-1-.pdf");
    expect(sanitizeFilename("a###b")).toBe("a-b");
  });

  it("falls back to a placeholder rather than an empty segment", () => {
    expect(sanitizeFilename("")).toBe("file");
    expect(sanitizeFilename("///")).toBe("file");
    expect(sanitizeFilename("###")).toBe("-");
  });

  it("truncates very long names", () => {
    expect(sanitizeFilename("a".repeat(500))).toHaveLength(128);
  });

  it("preserves unicode-free ordinary names untouched", () => {
    expect(sanitizeFilename("Q3_Report-final.v2.pdf")).toBe("Q3_Report-final.v2.pdf");
  });
});

describe("parseTenantFromKey", () => {
  it("extracts the tenant under the expected prefix", () => {
    expect(parseTenantFromKey("uploads/acme/abc/f.pdf", "uploads/")).toBe("acme");
  });

  it("tolerates a prefix given without a trailing slash", () => {
    expect(parseTenantFromKey("uploads/acme/abc/f.pdf", "uploads")).toBe("acme");
  });

  // This is the check that makes a forged, unauthenticated trigger POST harmless: without it a
  // registry row could be created pointing anywhere in the bucket.
  it("returns null for keys outside the prefix", () => {
    expect(parseTenantFromKey("other/acme/abc/f.pdf", "uploads/")).toBeNull();
    expect(parseTenantFromKey("uploads2/acme/f.pdf", "uploads/")).toBeNull();
    expect(parseTenantFromKey("f.pdf", "uploads/")).toBeNull();
  });

  it("returns null when the tenant segment is malformed", () => {
    expect(parseTenantFromKey("uploads//abc/f.pdf", "uploads/")).toBeNull();
    expect(parseTenantFromKey("uploads/a.b/abc/f.pdf", "uploads/")).toBeNull();
    expect(parseTenantFromKey(`uploads/${"a".repeat(65)}/f.pdf`, "uploads/")).toBeNull();
  });

  it("is case-sensitive, matching storage trigger prefix semantics", () => {
    expect(parseTenantFromKey("Uploads/acme/f.pdf", "uploads/")).toBeNull();
  });
});

describe("assertKeyBelongsToTenant", () => {
  it("passes for a matching tenant", () => {
    expect(() =>
      assertKeyBelongsToTenant("uploads/acme/abc/f.pdf", "acme", "uploads/"),
    ).not.toThrow();
  });

  it("rejects another tenant's key", () => {
    expect(() =>
      assertKeyBelongsToTenant("uploads/other/abc/f.pdf", "acme", "uploads/"),
    ).toThrow(/does not belong to the requesting tenant/);
  });

  it("rejects a key outside the registry prefix", () => {
    expect(() => assertKeyBelongsToTenant("etc/passwd", "acme", "uploads/")).toThrow(
      /not under the registry prefix/,
    );
  });

  // A prefix-confusion attack: "acme-evil" starts with "acme" but is a different tenant.
  it("does not treat a tenant as a prefix of another", () => {
    expect(() =>
      assertKeyBelongsToTenant("uploads/acme-evil/abc/f.pdf", "acme", "uploads/"),
    ).toThrow(/does not belong/);
  });
});
