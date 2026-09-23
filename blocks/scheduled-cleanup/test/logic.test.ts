import { describe, expect, it } from "vitest";
import { parseRegister, toByKind, totalExpired } from "../src/logic.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

describe("parseRegister", () => {
  it("applies the default TTL when no expiry is given", () => {
    const reg = parseRegister({ kind: "trial", reference: "user_1" }, 3600, NOW);
    expect(reg.kind).toBe("trial");
    expect(reg.reference).toBe("user_1");
    expect(reg.expiresAt.toISOString()).toBe("2026-01-01T01:00:00.000Z");
  });

  it("honors an explicit ttlSeconds", () => {
    const reg = parseRegister({ kind: "cart", reference: "c1", ttlSeconds: 60 }, 3600, NOW);
    expect(reg.expiresAt.toISOString()).toBe("2026-01-01T00:01:00.000Z");
  });

  it("honors an explicit expiresAt", () => {
    const reg = parseRegister(
      { kind: "session", reference: "s1", expiresAt: "2026-02-01T00:00:00.000Z" },
      3600,
      NOW,
    );
    expect(reg.expiresAt.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("rejects a missing kind or reference", () => {
    expect(() => parseRegister({ reference: "x" }, 3600, NOW)).toThrow();
    expect(() => parseRegister({ kind: "trial" }, 3600, NOW)).toThrow();
  });

  it("rejects an invalid date and a non-positive ttl", () => {
    expect(() => parseRegister({ kind: "t", reference: "r", expiresAt: "not-a-date" }, 3600, NOW)).toThrow();
    expect(() => parseRegister({ kind: "t", reference: "r", ttlSeconds: 0 }, 3600, NOW)).toThrow();
  });

  it("rejects a non-object body", () => {
    expect(() => parseRegister("nope", 3600, NOW)).toThrow();
  });
});

describe("toByKind / totalExpired", () => {
  it("folds count rows into a breakdown and sums them", () => {
    const byKind = toByKind([
      { kind: "trial", n: "3" },
      { kind: "cart", n: 2 },
    ]);
    expect(byKind).toEqual({ trial: 3, cart: 2 });
    expect(totalExpired(byKind)).toBe(5);
  });

  it("is zero for an empty run", () => {
    expect(totalExpired(toByKind([]))).toBe(0);
  });
});
