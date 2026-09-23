/**
 * Deterministic masking primitive. Pure and unit tested, because determinism (the same input always
 * masks to the same output) is the property joins depend on, and format preservation is what keeps
 * the masked branch usable for testing.
 */

import { createHmac } from "node:crypto";

/**
 * HMAC rather than a plain hash: hashing an email is trivially reversible with a dictionary, because
 * there are only so many plausible emails. Determinism is deliberate — the same input must always
 * produce the same output, or joins break and a bug that only reproduces for one customer stops
 * reproducing at all.
 */
export function maskValue(value: string, salt: string, strategy: string): string {
  const digest = createHmac("sha256", salt).update(value).digest("hex");

  switch (strategy) {
    case "email":
      // Format-preserving: a masked email that is not a valid email makes the branch unusable.
      return `user_${digest.slice(0, 12)}@example.test`;
    case "phone":
      // Keeps the +1 555 prefix so number parsers still accept it.
      return `+1555${parseInt(digest.slice(0, 7), 16) % 10_000_000}`.slice(0, 12);
    case "name":
      return `Person ${digest.slice(0, 8)}`;
    case "address":
      return `${parseInt(digest.slice(0, 4), 16) % 9999} Test Street`;
    case "ip":
      // 203.0.113.0/24 is the reserved documentation range, so a masked IP cannot be a real host.
      return `203.0.113.${parseInt(digest.slice(0, 2), 16) % 256}`;
    case "uuid":
      return [
        digest.slice(0, 8),
        digest.slice(8, 12),
        `4${digest.slice(13, 16)}`,
        `8${digest.slice(17, 20)}`,
        digest.slice(20, 32),
      ].join("-");
    case "redact":
      return "[REDACTED]";
    case "null_out":
      return "";
    default:
      return `masked_${digest.slice(0, 16)}`;
  }
}
