/**
 * API key generation and hashing. Pure and dependency-free so it can be unit tested without a
 * database — the security property that matters (plaintext exists exactly once, only its hash is
 * stored) is enforced here.
 */

import { createHash, randomBytes } from "node:crypto";

/** SHA-256 of a key, hex-encoded. The only form of the key that ever touches the database. */
export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export interface GeneratedKey {
  /** The plaintext key. Shown to the caller exactly once; never stored or logged. */
  key: string;
  /** SHA-256 of `key`. This is what the row stores. */
  keyHash: string;
  /** A short, safe-to-display leading slice used for lookup and in the UI. */
  keyPrefix: string;
}

/**
 * Mint a new key: 32 bytes of CSPRNG output, base64url so it is copy-pasteable without escaping.
 * The prefix is long enough to be selective on lookup, short enough to be safe to display.
 */
export function generateKey(prefix: string): GeneratedKey {
  const secret = randomBytes(32).toString("base64url");
  const key = `${prefix}_${secret}`;
  return {
    key,
    keyHash: hashKey(key),
    keyPrefix: key.slice(0, prefix.length + 9),
  };
}
