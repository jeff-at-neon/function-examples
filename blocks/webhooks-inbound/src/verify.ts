/**
 * Inbound webhook signature verification.
 *
 * This file is the block. Everyone needs it; everyone gets it subtly wrong, in ways that don't
 * show up in testing because a broken verifier usually still accepts *legitimate* requests. The
 * four classic mistakes, all of which are handled below:
 *
 *   1. verifying against the parsed-and-re-serialized body instead of the raw bytes — JSON key
 *      order and whitespace are not preserved, so the signature never matches
 *   2. using `===` on the digest, which leaks timing information
 *   3. ignoring the timestamp, which permits unlimited replay of a captured request
 *   4. accepting the first of several signature candidates instead of all of them, which breaks
 *      key rotation
 *
 * Pure functions over raw bytes, so each provider's scheme can be tested exhaustively offline.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export type Provider = "stripe" | "github" | "shopify" | "slack" | "clerk" | "generic";

export interface VerifyInput {
  /** The **raw** request body. Never a re-serialized object. */
  rawBody: string;
  headers: Headers;
  /** Provider signing secret. */
  secret: string;
  /** Reject requests older than this. 0 disables the check (not recommended). */
  toleranceSeconds: number;
  /** Injectable for deterministic tests. */
  now?: Date;
}

export type VerifyResult =
  | { ok: true; eventId: string | null; timestamp: Date | null }
  | { ok: false; reason: string };

/** Constant-time string comparison that does not leak length either. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    // Still run a comparison so the timing profile does not reveal a length mismatch.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

function hmacHex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

function hmacBase64(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("base64");
}

/**
 * Stripe: `Stripe-Signature: t=<ts>,v1=<sig>,v1=<sig2>`.
 *
 * Signed payload is `<timestamp>.<raw body>`. Multiple `v1` values appear during secret rotation,
 * so every candidate must be checked — accepting only the first breaks rotation, and the failure
 * arrives at 3am when the old secret expires.
 */
export function verifyStripe(input: VerifyInput): VerifyResult {
  const header = input.headers.get("stripe-signature");
  if (!header) return { ok: false, reason: "missing Stripe-Signature header" };

  const parts = header.split(",").map((p) => p.trim());
  const timestampRaw = parts.find((p) => p.startsWith("t="))?.slice(2);
  const signatures = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));

  if (!timestampRaw) return { ok: false, reason: "Stripe-Signature has no timestamp" };
  if (signatures.length === 0) return { ok: false, reason: "Stripe-Signature has no v1 signature" };

  const timestampSeconds = Number(timestampRaw);
  if (!Number.isFinite(timestampSeconds)) {
    return { ok: false, reason: "Stripe-Signature timestamp is not a number" };
  }

  const drift = checkTimestamp(timestampSeconds * 1000, input);
  if (drift) return drift;

  const expected = hmacHex(input.secret, `${timestampRaw}.${input.rawBody}`);
  if (!signatures.some((candidate) => safeEqual(candidate, expected))) {
    return { ok: false, reason: "no Stripe signature matched" };
  }

  return {
    ok: true,
    eventId: extractJsonString(input.rawBody, "id"),
    timestamp: new Date(timestampSeconds * 1000),
  };
}

/** GitHub: `X-Hub-Signature-256: sha256=<hex>` over the raw body. No timestamp is provided. */
export function verifyGithub(input: VerifyInput): VerifyResult {
  const header = input.headers.get("x-hub-signature-256");
  if (!header) return { ok: false, reason: "missing X-Hub-Signature-256 header" };
  if (!header.startsWith("sha256=")) {
    return { ok: false, reason: "X-Hub-Signature-256 is not sha256-prefixed" };
  }

  const expected = hmacHex(input.secret, input.rawBody);
  if (!safeEqual(header.slice(7), expected)) {
    return { ok: false, reason: "GitHub signature did not match" };
  }

  // GitHub signs no timestamp, so replay protection relies entirely on delivery-id dedupe.
  return { ok: true, eventId: input.headers.get("x-github-delivery"), timestamp: null };
}

/** Shopify: `X-Shopify-Hmac-Sha256: <base64>` over the raw body. */
export function verifyShopify(input: VerifyInput): VerifyResult {
  const header = input.headers.get("x-shopify-hmac-sha256");
  if (!header) return { ok: false, reason: "missing X-Shopify-Hmac-Sha256 header" };

  const expected = hmacBase64(input.secret, input.rawBody);
  if (!safeEqual(header, expected)) {
    return { ok: false, reason: "Shopify HMAC did not match" };
  }

  return { ok: true, eventId: input.headers.get("x-shopify-webhook-id"), timestamp: null };
}

/**
 * Slack: `X-Slack-Signature: v0=<hex>` over `v0:<timestamp>:<raw body>`.
 *
 * Slack explicitly documents a five-minute replay window, which is why the timestamp check here is
 * not optional in practice.
 */
export function verifySlack(input: VerifyInput): VerifyResult {
  const signature = input.headers.get("x-slack-signature");
  const timestampRaw = input.headers.get("x-slack-request-timestamp");
  if (!signature) return { ok: false, reason: "missing X-Slack-Signature header" };
  if (!timestampRaw) return { ok: false, reason: "missing X-Slack-Request-Timestamp header" };

  const timestampSeconds = Number(timestampRaw);
  if (!Number.isFinite(timestampSeconds)) {
    return { ok: false, reason: "Slack timestamp is not a number" };
  }

  const drift = checkTimestamp(timestampSeconds * 1000, input);
  if (drift) return drift;

  const expected = `v0=${hmacHex(input.secret, `v0:${timestampRaw}:${input.rawBody}`)}`;
  if (!safeEqual(signature, expected)) {
    return { ok: false, reason: "Slack signature did not match" };
  }

  return { ok: true, eventId: null, timestamp: new Date(timestampSeconds * 1000) };
}

/**
 * Clerk / Svix: `svix-signature: v1,<base64> v1,<base64>` over `<id>.<timestamp>.<raw body>`.
 *
 * Space-separated rather than comma-separated, and each entry is itself comma-separated — an easy
 * format to mis-parse. Multiple entries again mean rotation.
 */
export function verifyClerk(input: VerifyInput): VerifyResult {
  const signatureHeader = input.headers.get("svix-signature");
  const id = input.headers.get("svix-id");
  const timestampRaw = input.headers.get("svix-timestamp");

  if (!signatureHeader) return { ok: false, reason: "missing svix-signature header" };
  if (!id) return { ok: false, reason: "missing svix-id header" };
  if (!timestampRaw) return { ok: false, reason: "missing svix-timestamp header" };

  const timestampSeconds = Number(timestampRaw);
  if (!Number.isFinite(timestampSeconds)) {
    return { ok: false, reason: "svix-timestamp is not a number" };
  }

  const drift = checkTimestamp(timestampSeconds * 1000, input);
  if (drift) return drift;

  // Svix secrets are prefixed `whsec_` and the remainder is base64 — the raw bytes are the key,
  // not the printable string. Signing with the prefixed string produces a mismatch that looks
  // like a wrong secret.
  const secretBytes = input.secret.startsWith("whsec_")
    ? Buffer.from(input.secret.slice(6), "base64")
    : Buffer.from(input.secret, "utf8");

  const expected = createHmac("sha256", secretBytes)
    .update(`${id}.${timestampRaw}.${input.rawBody}`, "utf8")
    .digest("base64");

  const candidates = signatureHeader
    .split(" ")
    .map((entry) => entry.split(",")[1])
    .filter((value): value is string => typeof value === "string");

  if (candidates.length === 0) return { ok: false, reason: "svix-signature had no v1 entries" };
  if (!candidates.some((candidate) => safeEqual(candidate, expected))) {
    return { ok: false, reason: "no svix signature matched" };
  }

  return { ok: true, eventId: id, timestamp: new Date(timestampSeconds * 1000) };
}

/** Generic HMAC-SHA256 hex in a configurable header, for providers not listed above. */
export function verifyGeneric(
  input: VerifyInput & { signatureHeader: string; prefix?: string },
): VerifyResult {
  const header = input.headers.get(input.signatureHeader.toLowerCase());
  if (!header) return { ok: false, reason: `missing ${input.signatureHeader} header` };

  const provided = input.prefix && header.startsWith(input.prefix)
    ? header.slice(input.prefix.length)
    : header;

  if (!safeEqual(provided, hmacHex(input.secret, input.rawBody))) {
    return { ok: false, reason: "signature did not match" };
  }
  return { ok: true, eventId: null, timestamp: null };
}

/**
 * Reject stale and far-future timestamps.
 *
 * Without this, a captured request can be replayed indefinitely — the signature stays valid
 * forever because nothing in it expires. Future-dated requests are rejected too, since clock skew
 * beyond tolerance means one side is misconfigured.
 */
function checkTimestamp(timestampMs: number, input: VerifyInput): VerifyResult | null {
  if (input.toleranceSeconds <= 0) return null;

  const nowMs = (input.now ?? new Date()).getTime();
  const driftSeconds = Math.abs(nowMs - timestampMs) / 1000;

  if (driftSeconds > input.toleranceSeconds) {
    return {
      ok: false,
      reason:
        `timestamp is ${Math.round(driftSeconds)}s outside the ${input.toleranceSeconds}s ` +
        `tolerance; this is replay protection, so check clock skew before widening it`,
    };
  }
  return null;
}

/**
 * Pull a top-level string field out of raw JSON without parsing it.
 *
 * Parsing would be simpler, but the raw body must stay byte-identical for verification and this
 * runs before we are willing to trust the payload at all. Best-effort: returns null rather than
 * throwing on anything unexpected.
 */
export function extractJsonString(rawBody: string, field: string): string | null {
  const match = new RegExp(`"${field}"\\s*:\\s*"([^"\\\\]*)"`).exec(rawBody);
  return match?.[1] ?? null;
}

export interface VerifyOptions {
  provider: Provider;
  rawBody: string;
  headers: Headers;
  secret: string;
  toleranceSeconds: number;
  now?: Date;
  signatureHeader?: string;
  signaturePrefix?: string;
}

/** Dispatch to the right provider verifier. */
export function verifyWebhook(opts: VerifyOptions): VerifyResult {
  const base: VerifyInput = {
    rawBody: opts.rawBody,
    headers: opts.headers,
    secret: opts.secret,
    toleranceSeconds: opts.toleranceSeconds,
    ...(opts.now ? { now: opts.now } : {}),
  };

  switch (opts.provider) {
    case "stripe":
      return verifyStripe(base);
    case "github":
      return verifyGithub(base);
    case "shopify":
      return verifyShopify(base);
    case "slack":
      return verifySlack(base);
    case "clerk":
      return verifyClerk(base);
    case "generic":
      return verifyGeneric({
        ...base,
        signatureHeader: opts.signatureHeader ?? "x-signature",
        ...(opts.signaturePrefix ? { prefix: opts.signaturePrefix } : {}),
      });
    default: {
      // Exhaustiveness guard: adding a Provider without a case is a compile error, not a runtime
      // "unsupported provider" that silently accepts nothing.
      const never: never = opts.provider;
      return { ok: false, reason: `unsupported provider ${String(never)}` };
    }
  }
}
