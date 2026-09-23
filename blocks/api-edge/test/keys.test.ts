import { describe, expect, it } from "vitest";
import { generateKey, hashKey } from "../src/keys.js";

describe("hashKey", () => {
  it("is deterministic for the same input", () => {
    expect(hashKey("nb_live_abc")).toBe(hashKey("nb_live_abc"));
  });

  it("is a 64-char hex SHA-256 digest", () => {
    expect(hashKey("anything")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs for different inputs", () => {
    expect(hashKey("a")).not.toBe(hashKey("b"));
  });
});

describe("generateKey", () => {
  it("prefixes the plaintext with the configured prefix", () => {
    expect(generateKey("nb_live").key.startsWith("nb_live_")).toBe(true);
  });

  it("stores only the hash of the emitted plaintext (round-trips)", () => {
    const g = generateKey("nb_test");
    expect(g.keyHash).toBe(hashKey(g.key));
  });

  it("derives keyPrefix as a leading slice of the plaintext", () => {
    const g = generateKey("nb_live");
    expect(g.key.startsWith(g.keyPrefix)).toBe(true);
    expect(g.keyPrefix.length).toBe("nb_live".length + 9);
  });

  it("produces a fresh secret each call", () => {
    expect(generateKey("nb_live").key).not.toBe(generateKey("nb_live").key);
  });
});
