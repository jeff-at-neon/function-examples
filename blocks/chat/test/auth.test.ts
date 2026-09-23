import { describe, expect, it } from "vitest";
import { authenticate, parseBearer, verifyApiKey } from "../src/auth.js";

describe("parseBearer", () => {
  it("extracts a token from a Bearer header", () => {
    expect(parseBearer("Bearer abc123")).toBe("abc123");
    expect(parseBearer("bearer abc123")).toBe("abc123");
  });

  it("returns null for a missing or malformed header", () => {
    expect(parseBearer(null)).toBe(null);
    expect(parseBearer("abc123")).toBe(null);
    expect(parseBearer("Bearer ")).toBe(null);
  });
});

describe("verifyApiKey", () => {
  it("accepts a matching key", () => {
    expect(verifyApiKey("s3cret", "s3cret")).toBe(true);
  });

  it("rejects a wrong key", () => {
    expect(verifyApiKey("nope", "s3cret")).toBe(false);
  });

  it("never accepts when no key is configured", () => {
    expect(verifyApiKey("", "")).toBe(false);
    expect(verifyApiKey("anything", "")).toBe(false);
  });
});

describe("authenticate", () => {
  it("authenticates via the shared key", async () => {
    const result = await authenticate("Bearer s3cret", { apiKey: "s3cret", authBaseUrl: "" });
    expect(result).toEqual({ subject: "shared-key", mode: "apikey" });
  });

  it("returns null without a token", async () => {
    expect(await authenticate(null, { apiKey: "s3cret", authBaseUrl: "" })).toBe(null);
  });

  it("returns null for a wrong key when JWT is not configured", async () => {
    expect(await authenticate("Bearer wrong", { apiKey: "s3cret", authBaseUrl: "" })).toBe(null);
  });

  it("returns null (does not throw) when JWT verification is unimplemented", async () => {
    expect(await authenticate("Bearer jwt.token.here", { apiKey: "", authBaseUrl: "https://auth.example.com" })).toBe(
      null,
    );
  });
});
