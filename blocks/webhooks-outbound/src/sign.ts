/**
 * Outbound signing and delivery policy.
 *
 * The mirror of block 6: here *we* are the provider, so we must produce signatures our customers can
 * verify — and produce them in a scheme that supports secret rotation, because customers will need
 * to rotate without downtime and cannot coordinate a flag day with us.
 *
 * The scheme is deliberately Stripe/Svix-shaped rather than novel. Customers already have libraries
 * and documentation for verifying it, and inventing a scheme means every customer writes new code.
 */

import { createHmac } from "node:crypto";

export interface SignOptions {
  /** Raw body, exactly as it will be transmitted. */
  payload: string;
  /**
   * Signing secrets, newest first.
   *
   * Plural because rotation requires an overlap window: we sign with both, the customer verifies
   * with either, and neither side needs a synchronised cutover.
   */
  secrets: readonly string[];
  timestamp: Date;
  /** Included in the signed content so a body cannot be replayed against a different event. */
  eventId: string;
}

export interface SignedHeaders {
  "x-webhook-id": string;
  "x-webhook-timestamp": string;
  "x-webhook-signature": string;
  "content-type": string;
}

/**
 * Build delivery headers.
 *
 * Signed content is `<eventId>.<timestamp>.<payload>`. All three matter: the timestamp bounds replay,
 * and the event id stops a valid body being replayed as a different event.
 */
export function signPayload(opts: SignOptions): SignedHeaders {
  if (opts.secrets.length === 0) {
    throw new Error("At least one signing secret is required to sign a webhook");
  }

  const timestampSeconds = Math.floor(opts.timestamp.getTime() / 1000);
  const signedContent = `${opts.eventId}.${timestampSeconds}.${opts.payload}`;

  // Space-separated `v1,<sig>` entries — the Svix format, so customers can use an existing library.
  const signatures = opts.secrets.map(
    (secret) => `v1,${createHmac("sha256", normalizeSecret(secret)).update(signedContent, "utf8").digest("base64")}`,
  );

  return {
    "x-webhook-id": opts.eventId,
    "x-webhook-timestamp": String(timestampSeconds),
    "x-webhook-signature": signatures.join(" "),
    "content-type": "application/json",
  };
}

/**
 * Accept both `whsec_<base64>` and raw secrets.
 *
 * The prefixed form's decoded bytes are the key, not the printable string — the same trap block 6
 * documents for inbound verification, and getting it wrong here means every customer's verification
 * fails in a way that looks like a wrong secret.
 */
function normalizeSecret(secret: string): Buffer {
  return secret.startsWith("whsec_")
    ? Buffer.from(secret.slice(6), "base64")
    : Buffer.from(secret, "utf8");
}

export interface EndpointHealth {
  consecutiveFailures: number;
  circuitOpenedAt: Date | null;
  disabledAt: Date | null;
}

export interface CircuitPolicy {
  /** Consecutive failures before the circuit opens. */
  failureThreshold: number;
  /** How long it stays open before a trial delivery is allowed. */
  cooldownMs: number;
  /** Consecutive failures before the endpoint is disabled entirely and needs manual re-enabling. */
  disableThreshold: number;
}

export const DEFAULT_CIRCUIT: CircuitPolicy = {
  failureThreshold: 5,
  cooldownMs: 300_000, // 5 minutes
  // ~200 failures is days of retries. Past that the endpoint is gone, not flaky, and continuing
  // costs us money to deliver to nobody.
  disableThreshold: 200,
};

export type DeliveryDecision =
  | { deliver: true; trial: boolean }
  | { deliver: false; reason: string; retryAfterMs: number | null };

/**
 * Whether to attempt delivery to an endpoint right now.
 *
 * The purpose is isolation: one customer's dead endpoint must not consume the delivery budget for
 * every other customer. Without a breaker, 10,000 queued events for a black-holing endpoint each
 * burn a full connection timeout, and everyone else's webhooks arrive late.
 */
export function shouldDeliver(
  health: EndpointHealth,
  now: Date,
  policy: CircuitPolicy = DEFAULT_CIRCUIT,
): DeliveryDecision {
  if (health.disabledAt) {
    return {
      deliver: false,
      reason: `endpoint disabled after ${health.consecutiveFailures} consecutive failures`,
      // No automatic retry: a disabled endpoint requires someone to look at it.
      retryAfterMs: null,
    };
  }

  if (health.consecutiveFailures < policy.failureThreshold) {
    return { deliver: true, trial: false };
  }

  if (!health.circuitOpenedAt) {
    // Threshold reached but the circuit was never recorded as open. Treat as open now rather than
    // trusting inconsistent state.
    return { deliver: false, reason: "circuit open", retryAfterMs: policy.cooldownMs };
  }

  const elapsed = now.getTime() - health.circuitOpenedAt.getTime();
  if (elapsed >= policy.cooldownMs) {
    // Half-open: allow exactly one trial delivery. Success closes the circuit; failure reopens it.
    return { deliver: true, trial: true };
  }

  return {
    deliver: false,
    reason: `circuit open after ${health.consecutiveFailures} consecutive failures`,
    retryAfterMs: policy.cooldownMs - elapsed,
  };
}

/**
 * Whether a response counts as delivered.
 *
 * Any 2xx succeeds. 3xx does **not** — a redirect on a webhook endpoint is a misconfiguration, and
 * following it could deliver signed payloads somewhere the customer did not authorise.
 */
export function isDelivered(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Whether a failed delivery is worth retrying.
 *
 * 410 Gone is treated as permanent and terminal: the customer is explicitly saying this endpoint no
 * longer exists, and retrying for days afterwards is both rude and expensive.
 */
export function isRetryable(status: number): boolean {
  if (status === 408 || status === 429) return true;
  if (status === 410) return false;
  if (status >= 400 && status < 500) return false;
  return status >= 500;
}

/**
 * Honour a `Retry-After` header.
 *
 * A customer returning 429 with `Retry-After` is telling us their rate limit; ignoring it and
 * applying our own backoff is how you get permanently throttled.
 */
export function parseRetryAfter(header: string | null, now: Date): number | null {
  if (!header) return null;

  const trimmed = header.trim();

  // Handle anything numeric-looking here and never fall through to the date parser. `new Date("-5")`
  // parses as May 2001 — a past date, which would be read as "retry immediately" rather than as the
  // malformed header it is.
  if (/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    // Cap at an hour: a hostile or broken header must not park a job for a week.
    return Math.min(seconds * 1000, 3_600_000);
  }

  const date = new Date(trimmed);
  if (!Number.isNaN(date.getTime())) {
    const delta = date.getTime() - now.getTime();
    return delta > 0 ? Math.min(delta, 3_600_000) : 0;
  }

  return null;
}

/**
 * Reject endpoint URLs that could be used to reach internal services.
 *
 * Customers supply these URLs and we make requests to them, which is server-side request forgery by
 * construction. A URL pointing at localhost or a metadata endpoint turns our webhook sender into a
 * proxy into our own network.
 *
 * DNS-level protection is still required — a hostname resolving to 169.254.169.254 passes this check
 * — so this is necessary but not sufficient, and the README says so.
 */
export function assertSafeEndpointUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Endpoint URL is not a valid URL: ${raw.slice(0, 100)}`);
  }

  if (url.protocol !== "https:") {
    // Signed payloads over plaintext would be readable in transit, defeating the signature's purpose.
    throw new Error(`Endpoint URL must use https, got "${url.protocol}"`);
  }

  const host = url.hostname.toLowerCase();

  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    throw new Error(`Endpoint URL host "${host}" is not routable from outside`);
  }

  // Literal private and link-local ranges. The link-local check matters most: 169.254.169.254 is the
  // cloud metadata endpoint, and reaching it can expose instance credentials.
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    const isPrivate =
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      a === 0;
    if (isPrivate) {
      throw new Error(`Endpoint URL host "${host}" is a private or link-local address`);
    }
  }

  // IPv6 loopback and unique-local. new URL() keeps brackets on IPv6 hosts.
  if (host === "[::1]" || host.startsWith("[fd") || host.startsWith("[fc")) {
    throw new Error(`Endpoint URL host "${host}" is a loopback or unique-local address`);
  }

  return url;
}
