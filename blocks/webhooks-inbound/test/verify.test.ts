import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  extractJsonString,
  safeEqual,
  verifyWebhook,
  type Provider,
} from "../src/verify.js";

const SECRET = "whsec_test_secret_value";
const NOW = new Date("2026-09-22T12:00:00Z");
const TS = Math.floor(NOW.getTime() / 1000);

const hex = (secret: string, payload: string): string =>
  createHmac("sha256", secret).update(payload, "utf8").digest("hex");
const b64 = (secret: string | Buffer, payload: string): string =>
  createHmac("sha256", secret).update(payload, "utf8").digest("base64");

const headers = (entries: Record<string, string>): Headers => new Headers(entries);

const verify = (provider: Provider, rawBody: string, hdrs: Headers, secret = SECRET) =>
  verifyWebhook({ provider, rawBody, headers: hdrs, secret, toleranceSeconds: 300, now: NOW });

describe("safeEqual", () => {
  it("compares equal strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
  });

  it("rejects different strings and differing lengths without throwing", () => {
    expect(safeEqual("abc", "abd")).toBe(false);
    // timingSafeEqual throws on length mismatch, so this must be handled explicitly.
    expect(safeEqual("abc", "abcdef")).toBe(false);
    expect(safeEqual("", "a")).toBe(false);
  });
});

describe("Stripe", () => {
  const body = '{"id":"evt_123","type":"charge.succeeded"}';

  it("accepts a valid signature", () => {
    const sig = hex(SECRET, `${TS}.${body}`);
    const result = verify("stripe", body, headers({ "stripe-signature": `t=${TS},v1=${sig}` }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.eventId).toBe("evt_123");
      expect(result.timestamp?.getTime()).toBe(TS * 1000);
    }
  });

  // Rotation: multiple v1 values are sent while both secrets are live. Accepting only the first
  // breaks at 3am when the old secret expires.
  it("accepts when any candidate signature matches, for key rotation", () => {
    const good = hex(SECRET, `${TS}.${body}`);
    const result = verify(
      "stripe",
      body,
      headers({ "stripe-signature": `t=${TS},v1=${"0".repeat(64)},v1=${good}` }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a wrong signature", () => {
    const result = verify("stripe", body, headers({ "stripe-signature": `t=${TS},v1=${"a".repeat(64)}` }));
    expect(result).toEqual({ ok: false, reason: "no Stripe signature matched" });
  });

  // The #1 real-world mistake: verifying against the parsed-and-re-serialized body. The provider
  // signed specific bytes; JSON.stringify does not reproduce the original whitespace, so the
  // signature cannot match. Sending a raw body with indentation makes the difference explicit.
  it("rejects when the body was re-serialized rather than kept byte-identical", () => {
    const rawFromProvider = '{\n  "id": "evt_123",\n  "type": "charge.succeeded"\n}';
    const signedOverRaw = hex(SECRET, `${TS}.${rawFromProvider}`);

    const reSerialized = JSON.stringify(JSON.parse(rawFromProvider));
    expect(reSerialized).not.toBe(rawFromProvider); // the bytes really did change

    expect(
      verify("stripe", reSerialized, headers({ "stripe-signature": `t=${TS},v1=${signedOverRaw}` }))
        .ok,
    ).toBe(false);

    // The same signature verifies fine against the original bytes.
    expect(
      verify("stripe", rawFromProvider, headers({ "stripe-signature": `t=${TS},v1=${signedOverRaw}` }))
        .ok,
    ).toBe(true);
  });

  it("rejects a stale timestamp, which is replay protection", () => {
    const oldTs = TS - 3_600;
    const sig = hex(SECRET, `${oldTs}.${body}`);
    const result = verify("stripe", body, headers({ "stripe-signature": `t=${oldTs},v1=${sig}` }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/outside the 300s tolerance/);
  });

  it("rejects a far-future timestamp too", () => {
    const futureTs = TS + 3_600;
    const sig = hex(SECRET, `${futureTs}.${body}`);
    const result = verify("stripe", body, headers({ "stripe-signature": `t=${futureTs},v1=${sig}` }));
    expect(result.ok).toBe(false);
  });

  it("reports malformed headers distinctly", () => {
    expect(verify("stripe", body, headers({}))).toEqual({
      ok: false,
      reason: "missing Stripe-Signature header",
    });
    expect(verify("stripe", body, headers({ "stripe-signature": "v1=abc" })).ok).toBe(false);
    expect(verify("stripe", body, headers({ "stripe-signature": `t=${TS}` })).ok).toBe(false);
    expect(verify("stripe", body, headers({ "stripe-signature": "t=abc,v1=x" })).ok).toBe(false);
  });
});

describe("GitHub", () => {
  const body = '{"action":"opened"}';

  it("accepts a valid signature and returns the delivery id", () => {
    const result = verify(
      "github",
      body,
      headers({
        "x-hub-signature-256": `sha256=${hex(SECRET, body)}`,
        "x-github-delivery": "d-1",
      }),
    );
    expect(result).toEqual({ ok: true, eventId: "d-1", timestamp: null });
  });

  it("requires the sha256= prefix", () => {
    const result = verify("github", body, headers({ "x-hub-signature-256": hex(SECRET, body) }));
    expect(result).toEqual({ ok: false, reason: "X-Hub-Signature-256 is not sha256-prefixed" });
  });

  it("rejects a signature made with the wrong secret", () => {
    const result = verify(
      "github",
      body,
      headers({ "x-hub-signature-256": `sha256=${hex("other", body)}` }),
    );
    expect(result.ok).toBe(false);
  });
});

describe("Shopify", () => {
  const body = '{"order":1}';

  it("accepts a valid base64 HMAC", () => {
    const result = verify(
      "shopify",
      body,
      headers({ "x-shopify-hmac-sha256": b64(SECRET, body), "x-shopify-webhook-id": "w-9" }),
    );
    expect(result).toEqual({ ok: true, eventId: "w-9", timestamp: null });
  });

  // A hex digest is the same bytes in a different encoding; accepting it would be a bug.
  it("rejects a hex digest where base64 is required", () => {
    const result = verify("shopify", body, headers({ "x-shopify-hmac-sha256": hex(SECRET, body) }));
    expect(result.ok).toBe(false);
  });
});

describe("Slack", () => {
  const body = "token=x&team_id=T1";

  it("accepts a valid signature over v0:timestamp:body", () => {
    const sig = `v0=${hex(SECRET, `v0:${TS}:${body}`)}`;
    const result = verify(
      "slack",
      body,
      headers({ "x-slack-signature": sig, "x-slack-request-timestamp": String(TS) }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a signature computed without the v0 prefix scheme", () => {
    const wrong = `v0=${hex(SECRET, `${TS}:${body}`)}`;
    const result = verify(
      "slack",
      body,
      headers({ "x-slack-signature": wrong, "x-slack-request-timestamp": String(TS) }),
    );
    expect(result.ok).toBe(false);
  });

  it("enforces the replay window Slack documents", () => {
    const oldTs = TS - 600;
    const sig = `v0=${hex(SECRET, `v0:${oldTs}:${body}`)}`;
    const result = verify(
      "slack",
      body,
      headers({ "x-slack-signature": sig, "x-slack-request-timestamp": String(oldTs) }),
    );
    expect(result.ok).toBe(false);
  });
});

describe("Clerk / Svix", () => {
  const body = '{"type":"user.created"}';
  const id = "msg_123";
  // The whsec_ prefix is stripped and the remainder base64-decoded; signing with the printable
  // string produces a mismatch that looks like a wrong secret.
  const keyBytes = Buffer.from(SECRET.slice(6), "base64");

  it("accepts a valid signature over id.timestamp.body", () => {
    const sig = b64(keyBytes, `${id}.${TS}.${body}`);
    const result = verify(
      "clerk",
      body,
      headers({
        "svix-id": id,
        "svix-timestamp": String(TS),
        "svix-signature": `v1,${sig}`,
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.eventId).toBe(id);
  });

  // Svix uses space-separated entries, each itself comma-separated — easy to mis-parse.
  it("accepts any of several space-separated entries", () => {
    const good = b64(keyBytes, `${id}.${TS}.${body}`);
    const result = verify(
      "clerk",
      body,
      headers({
        "svix-id": id,
        "svix-timestamp": String(TS),
        "svix-signature": `v1,AAAA v1,${good}`,
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects when the id is not part of the signed payload", () => {
    const sig = b64(keyBytes, `${TS}.${body}`);
    const result = verify(
      "clerk",
      body,
      headers({ "svix-id": id, "svix-timestamp": String(TS), "svix-signature": `v1,${sig}` }),
    );
    expect(result.ok).toBe(false);
  });

  it("requires all three svix headers", () => {
    expect(verify("clerk", body, headers({ "svix-id": id })).ok).toBe(false);
    expect(verify("clerk", body, headers({ "svix-timestamp": String(TS) })).ok).toBe(false);
  });
});

describe("generic", () => {
  const body = '{"a":1}';

  it("verifies a configurable header", () => {
    const result = verifyWebhook({
      provider: "generic",
      rawBody: body,
      headers: headers({ "x-signature": hex(SECRET, body) }),
      secret: SECRET,
      toleranceSeconds: 0,
      signatureHeader: "X-Signature",
    });
    expect(result.ok).toBe(true);
  });

  it("strips a configured prefix", () => {
    const result = verifyWebhook({
      provider: "generic",
      rawBody: body,
      headers: headers({ "x-sig": `sha256=${hex(SECRET, body)}` }),
      secret: SECRET,
      toleranceSeconds: 0,
      signatureHeader: "X-Sig",
      signaturePrefix: "sha256=",
    });
    expect(result.ok).toBe(true);
  });
});

describe("extractJsonString", () => {
  // Used before the payload is trusted, so it must not parse and must not throw.
  it("pulls a top-level string field from raw JSON", () => {
    expect(extractJsonString('{"id":"evt_1","x":2}', "id")).toBe("evt_1");
    expect(extractJsonString('{ "id" : "evt_2" }', "id")).toBe("evt_2");
  });

  it("returns null when absent or not a string", () => {
    expect(extractJsonString('{"x":1}', "id")).toBeNull();
    expect(extractJsonString('{"id":123}', "id")).toBeNull();
    expect(extractJsonString("not json at all", "id")).toBeNull();
  });
});
