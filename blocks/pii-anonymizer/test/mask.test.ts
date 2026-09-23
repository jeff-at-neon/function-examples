import { describe, expect, it } from "vitest";
import { maskValue } from "../src/mask.js";

const SALT = "test-salt";

describe("maskValue", () => {
  it("is deterministic for the same input and salt", () => {
    expect(maskValue("a@b.com", SALT, "email")).toBe(maskValue("a@b.com", SALT, "email"));
  });

  it("changes with the salt", () => {
    expect(maskValue("a@b.com", "salt1", "email")).not.toBe(maskValue("a@b.com", "salt2", "email"));
  });

  it("preserves format per strategy", () => {
    expect(maskValue("a@b.com", SALT, "email")).toMatch(/^user_[0-9a-f]{12}@example\.test$/);
    expect(maskValue("617-555-0100", SALT, "phone")).toMatch(/^\+1555\d+$/);
    expect(maskValue("1.2.3.4", SALT, "ip")).toMatch(/^203\.0\.113\.\d{1,3}$/);
    expect(maskValue("x", SALT, "uuid")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(maskValue("x", SALT, "redact")).toBe("[REDACTED]");
    expect(maskValue("x", SALT, "null_out")).toBe("");
    expect(maskValue("x", SALT, "anything-else")).toMatch(/^masked_[0-9a-f]{16}$/);
  });

  it("keeps a masked IP inside the documentation range", () => {
    const octet = Number(maskValue("10.0.0.1", SALT, "ip").split(".")[3]);
    expect(octet).toBeGreaterThanOrEqual(0);
    expect(octet).toBeLessThan(256);
  });
});
