/**
 * Caller authentication.
 *
 * A Neon Function has a public HTTPS URL, so an agent/chat endpoint must authenticate every request
 * itself: there is no app backend in front of it to gate access. Two paths are supported, and one
 * of them must accept the request or it is rejected:
 *
 *   1. Shared secret  — 'Authorization: Bearer <CHAT_API_KEY>', constant-time compared. Zero-config.
 *   2. Neon Auth JWT  — a bearer token verified against NEON_AUTH_BASE_URL's JWKS. The token
 *                       subject scopes the conversation. Verification is a marked TODO seam.
 */

import { constantTimeEquals } from "@neon-blocks/core";

export interface AuthResult {
  /** Stable identifier for the caller. Used as the conversation tenant. */
  subject: string;
  mode: "apikey" | "jwt";
}

/** Pull the token out of an Authorization header, or null if absent/malformed. */
export function parseBearer(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

/** Constant-time compare a presented token against the configured shared secret. */
export function verifyApiKey(presented: string, expected: string): boolean {
  if (expected === "") return false;
  return constantTimeEquals(presented, expected);
}

/**
 * Verify a Neon Auth JWT against its JWKS and return the subject.
 *
 * TODO(chat): implement JWKS verification. The shape:
 *   - fetch `${authBaseUrl}/.well-known/jwks.json` (cache the keys at module scope)
 *   - verify the token signature, issuer, audience, and expiry
 *   - return payload.sub
 * Left as a seam so the block stays dependency-free at scaffold depth; the shared-key path above
 * gives a working, protected endpoint in the meantime. Throwing here (rather than returning) keeps
 * an unimplemented verifier from silently accepting tokens.
 */
export async function verifyJwt(_token: string, _authBaseUrl: string): Promise<string> {
  throw new Error(
    "JWT verification is not implemented yet (TODO seam in src/auth.ts). Use CHAT_API_KEY for now.",
  );
}

/**
 * Authenticate a request against both configured paths.
 *
 * Returns the caller identity, or null when no path accepts it. The handler turns null into a 401.
 */
export async function authenticate(
  authorization: string | null,
  opts: { apiKey: string; authBaseUrl: string },
): Promise<AuthResult | null> {
  const token = parseBearer(authorization);
  if (!token) return null;

  if (opts.apiKey !== "" && verifyApiKey(token, opts.apiKey)) {
    return { subject: "shared-key", mode: "apikey" };
  }

  if (opts.authBaseUrl !== "") {
    try {
      const subject = await verifyJwt(token, opts.authBaseUrl);
      return { subject, mode: "jwt" };
    } catch {
      return null;
    }
  }

  return null;
}
