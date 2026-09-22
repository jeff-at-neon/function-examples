import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertSafeEndpointUrl,
  DEFAULT_CIRCUIT,
  isDelivered,
  isRetryable,
  parseRetryAfter,
  shouldDeliver,
  signPayload,
  type EndpointHealth,
} from "../src/sign.js";

const NOW = new Date("2026-09-22T12:00:00Z");
const TS = Math.floor(NOW.getTime() / 1000);

describe("signPayload", () => {
  const payload = '{"event":"order.created"}';

  it("produces the documented header set", () => {
    const headers = signPayload({ payload, secrets: ["s3cret"], timestamp: NOW, eventId: "evt_1" });
    expect(headers["x-webhook-id"]).toBe("evt_1");
    expect(headers["x-webhook-timestamp"]).toBe(String(TS));
    expect(headers["x-webhook-signature"]).toMatch(/^v1,/);
    expect(headers["content-type"]).toBe("application/json");
  });

  it("signs eventId.timestamp.payload, matching the Svix scheme", () => {
    const headers = signPayload({ payload, secrets: ["s3cret"], timestamp: NOW, eventId: "evt_1" });
    const expected = createHmac("sha256", "s3cret")
      .update(`evt_1.${TS}.${payload}`, "utf8")
      .digest("base64");
    expect(headers["x-webhook-signature"]).toBe(`v1,${expected}`);
  });

  // Rotation needs an overlap window: we sign with both, the customer verifies with either, and
  // neither side needs a synchronised cutover.
  it("emits one signature per secret so rotation needs no flag day", () => {
    const headers = signPayload({
      payload,
      secrets: ["new", "old"],
      timestamp: NOW,
      eventId: "evt_1",
    });
    const parts = headers["x-webhook-signature"].split(" ");
    expect(parts).toHaveLength(2);
    expect(parts.every((p) => p.startsWith("v1,"))).toBe(true);
  });

  // Same trap block 6 documents for inbound: the decoded bytes are the key, not the printable
  // string. Getting it wrong means every customer's verification fails, looking like a bad secret.
  it("decodes a whsec_ prefixed secret to bytes before signing", () => {
    const raw = Buffer.from("some-key-bytes").toString("base64");
    const headers = signPayload({
      payload,
      secrets: [`whsec_${raw}`],
      timestamp: NOW,
      eventId: "evt_1",
    });
    const expected = createHmac("sha256", Buffer.from(raw, "base64"))
      .update(`evt_1.${TS}.${payload}`, "utf8")
      .digest("base64");
    expect(headers["x-webhook-signature"]).toBe(`v1,${expected}`);
  });

  // Otherwise a valid body could be replayed as a different event.
  it("binds the signature to the event id", () => {
    const a = signPayload({ payload, secrets: ["s"], timestamp: NOW, eventId: "evt_1" });
    const b = signPayload({ payload, secrets: ["s"], timestamp: NOW, eventId: "evt_2" });
    expect(a["x-webhook-signature"]).not.toBe(b["x-webhook-signature"]);
  });

  it("binds the signature to the timestamp", () => {
    const a = signPayload({ payload, secrets: ["s"], timestamp: NOW, eventId: "e" });
    const b = signPayload({
      payload,
      secrets: ["s"],
      timestamp: new Date(NOW.getTime() + 1000),
      eventId: "e",
    });
    expect(a["x-webhook-signature"]).not.toBe(b["x-webhook-signature"]);
  });

  it("refuses to sign with no secret", () => {
    expect(() => signPayload({ payload, secrets: [], timestamp: NOW, eventId: "e" })).toThrow(
      /At least one signing secret/,
    );
  });
});

describe("shouldDeliver", () => {
  const healthy: EndpointHealth = {
    consecutiveFailures: 0,
    circuitOpenedAt: null,
    disabledAt: null,
  };

  it("delivers to a healthy endpoint", () => {
    expect(shouldDeliver(healthy, NOW)).toEqual({ deliver: true, trial: false });
  });

  it("delivers below the failure threshold", () => {
    expect(shouldDeliver({ ...healthy, consecutiveFailures: 4 }, NOW).deliver).toBe(true);
  });

  // The isolation property: without a breaker, 10,000 queued events for a black-holing endpoint each
  // burn a full connection timeout and everyone else's webhooks arrive late.
  it("opens the circuit at the threshold", () => {
    const result = shouldDeliver(
      { consecutiveFailures: 5, circuitOpenedAt: NOW, disabledAt: null },
      NOW,
    );
    expect(result.deliver).toBe(false);
    if (!result.deliver) expect(result.retryAfterMs).toBe(DEFAULT_CIRCUIT.cooldownMs);
  });

  it("reports the remaining cooldown so the caller can schedule precisely", () => {
    const openedAt = new Date(NOW.getTime() - 120_000);
    const result = shouldDeliver({ consecutiveFailures: 5, circuitOpenedAt: openedAt, disabledAt: null }, NOW);
    expect(result.deliver).toBe(false);
    if (!result.deliver) expect(result.retryAfterMs).toBe(DEFAULT_CIRCUIT.cooldownMs - 120_000);
  });

  it("allows one trial delivery after the cooldown (half-open)", () => {
    const openedAt = new Date(NOW.getTime() - DEFAULT_CIRCUIT.cooldownMs - 1);
    expect(shouldDeliver({ consecutiveFailures: 5, circuitOpenedAt: openedAt, disabledAt: null }, NOW)).toEqual({
      deliver: true,
      trial: true,
    });
  });

  it("treats a missing circuitOpenedAt at threshold as open rather than trusting it", () => {
    const result = shouldDeliver({ consecutiveFailures: 10, circuitOpenedAt: null, disabledAt: null }, NOW);
    expect(result.deliver).toBe(false);
  });

  // A disabled endpoint is gone, not flaky. Automatic retry would cost money to deliver to nobody.
  it("never delivers to a disabled endpoint and schedules no retry", () => {
    const result = shouldDeliver(
      { consecutiveFailures: 200, circuitOpenedAt: NOW, disabledAt: NOW },
      NOW,
    );
    expect(result.deliver).toBe(false);
    if (!result.deliver) expect(result.retryAfterMs).toBeNull();
  });
});

describe("isDelivered", () => {
  it("accepts any 2xx", () => {
    for (const status of [200, 201, 202, 204, 299]) expect(isDelivered(status)).toBe(true);
  });

  // A redirect on a webhook endpoint is a misconfiguration, and following it could deliver signed
  // payloads somewhere the customer never authorised.
  it("rejects 3xx rather than following the redirect", () => {
    for (const status of [301, 302, 307, 308]) expect(isDelivered(status)).toBe(false);
  });

  it("rejects 4xx and 5xx", () => {
    expect(isDelivered(404)).toBe(false);
    expect(isDelivered(500)).toBe(false);
  });
});

describe("isRetryable", () => {
  it("retries 5xx", () => {
    for (const status of [500, 502, 503, 504]) expect(isRetryable(status)).toBe(true);
  });

  it("retries 408 and 429", () => {
    expect(isRetryable(408)).toBe(true);
    expect(isRetryable(429)).toBe(true);
  });

  it("does not retry ordinary 4xx", () => {
    for (const status of [400, 401, 403, 404, 422]) expect(isRetryable(status)).toBe(false);
  });

  // The customer is explicitly saying this endpoint no longer exists. Retrying for days is rude and
  // expensive.
  it("treats 410 Gone as permanent", () => {
    expect(isRetryable(410)).toBe(false);
  });
});

describe("parseRetryAfter", () => {
  // A customer returning 429 with Retry-After is telling us their rate limit; overriding it with our
  // own backoff is how you get permanently throttled.
  it("parses delta-seconds", () => {
    expect(parseRetryAfter("120", NOW)).toBe(120_000);
    expect(parseRetryAfter("0", NOW)).toBe(0);
  });

  it("parses an HTTP date", () => {
    const future = new Date(NOW.getTime() + 60_000).toUTCString();
    expect(parseRetryAfter(future, NOW)).toBeLessThanOrEqual(60_000);
  });

  it("treats a past date as ready now", () => {
    expect(parseRetryAfter(new Date(NOW.getTime() - 60_000).toUTCString(), NOW)).toBe(0);
  });

  // A hostile or broken header must not park a job for a week.
  it("caps at one hour", () => {
    expect(parseRetryAfter("999999", NOW)).toBe(3_600_000);
  });

  it("returns null for absent or unparseable values", () => {
    expect(parseRetryAfter(null, NOW)).toBeNull();
    expect(parseRetryAfter("soon", NOW)).toBeNull();
    expect(parseRetryAfter("-5", NOW)).toBeNull();
  });
});

describe("assertSafeEndpointUrl", () => {
  it("accepts an ordinary https URL", () => {
    expect(assertSafeEndpointUrl("https://api.example.com/hooks").hostname).toBe("api.example.com");
  });

  // Signed payloads over plaintext are readable in transit, which defeats the signature's purpose.
  it("requires https", () => {
    expect(() => assertSafeEndpointUrl("http://api.example.com")).toThrow(/must use https/);
  });

  // We make requests to customer-supplied URLs, which is SSRF by construction.
  it("rejects loopback and non-routable hosts", () => {
    for (const url of [
      "https://localhost/h",
      "https://127.0.0.1/h",
      "https://0.0.0.0/h",
      "https://svc.internal/h",
      "https://box.local/h",
      "https://[::1]/h",
    ]) {
      expect(() => assertSafeEndpointUrl(url)).toThrow();
    }
  });

  it("rejects private ranges", () => {
    for (const url of ["https://10.0.0.1/h", "https://192.168.1.1/h", "https://172.16.0.1/h"]) {
      expect(() => assertSafeEndpointUrl(url)).toThrow(/private or link-local/);
    }
  });

  // The one that matters most: reaching the cloud metadata endpoint can expose instance credentials.
  it("rejects the cloud metadata address", () => {
    expect(() => assertSafeEndpointUrl("https://169.254.169.254/latest/meta-data/")).toThrow(
      /private or link-local/,
    );
  });

  it("rejects IPv6 unique-local addresses", () => {
    expect(() => assertSafeEndpointUrl("https://[fd00::1]/h")).toThrow(/loopback or unique-local/);
  });

  it("allows public addresses just outside private ranges", () => {
    expect(() => assertSafeEndpointUrl("https://172.32.0.1/h")).not.toThrow();
    expect(() => assertSafeEndpointUrl("https://11.0.0.1/h")).not.toThrow();
  });

  it("rejects malformed URLs", () => {
    expect(() => assertSafeEndpointUrl("not a url")).toThrow(/not a valid URL/);
  });
});
