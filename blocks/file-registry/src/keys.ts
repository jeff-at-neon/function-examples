/**
 * Object key construction and tenant parsing.
 *
 * Pure, and the most security-relevant code in the block. Keys are the tenant boundary: if a
 * client can influence a key into another tenant's prefix, it can read and overwrite their files.
 * Both directions matter — building a key from client input, and parsing a key that arrived on an
 * unauthenticated trigger POST.
 */

import { ValidationError } from "@neon-blocks/core";

/** Segment charset. Deliberately narrow — no dots, so no `..` traversal is expressible at all. */
const SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface KeyParts {
  prefix: string;
  tenant: string;
  /** Opaque unique id for this upload. */
  id: string;
  /** Sanitized original filename, used only for the trailing segment. */
  filename: string;
}

/**
 * Build a storage key from validated parts.
 *
 * Layout: `<prefix><tenant>/<id>/<filename>`. The id segment means two uploads of the same
 * filename by the same tenant never collide, so a second upload cannot silently overwrite a first.
 */
export function buildObjectKey(parts: KeyParts): string {
  assertSegment(parts.tenant, "tenant");
  assertSegment(parts.id, "id");

  const prefix = parts.prefix === "" || parts.prefix.endsWith("/") ? parts.prefix : `${parts.prefix}/`;
  const key = `${prefix}${parts.tenant}/${parts.id}/${sanitizeFilename(parts.filename)}`;

  if (key.length > 1024) {
    // Matches the storage trigger prefix limit; a longer key is not addressable by a trigger.
    throw new ValidationError(`Object key would be ${key.length} bytes, over the 1024 limit`);
  }
  return key;
}

function assertSegment(value: string, label: string): void {
  if (!SEGMENT_PATTERN.test(value)) {
    throw new ValidationError(
      `Invalid ${label} "${value.slice(0, 40)}". Use 1-64 characters from [A-Za-z0-9_-].`,
    );
  }
}

/**
 * Make a client-supplied filename safe for use as the final key segment.
 *
 * Never throws: a bad filename should not block an upload, since the filename is cosmetic — the id
 * segment above it already guarantees uniqueness. Strips directory components and collapses
 * anything unexpected.
 */
export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? "";
  const cleaned = base
    // Leading dots would produce hidden files and, worse, `..` as a whole segment.
    .replace(/^\.+/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .slice(0, 128);

  return cleaned === "" || cleaned === "." ? "file" : cleaned;
}

/**
 * Extract the tenant from a key, verifying it sits under the expected prefix.
 *
 * This is the check that makes a forged trigger POST harmless. Delivery is unauthenticated, so an
 * attacker can name any key; without confirming the prefix, a registry row could be created
 * pointing anywhere in the bucket.
 */
export function parseTenantFromKey(key: string, expectedPrefix: string): string | null {
  const prefix =
    expectedPrefix === "" || expectedPrefix.endsWith("/") ? expectedPrefix : `${expectedPrefix}/`;

  if (!key.startsWith(prefix)) return null;

  const remainder = key.slice(prefix.length);
  const tenant = remainder.split("/")[0];
  if (!tenant || !SEGMENT_PATTERN.test(tenant)) return null;

  return tenant;
}

/**
 * Confirm a key belongs to a given tenant.
 *
 * Used on read and delete paths. Takes the expected tenant explicitly rather than inferring it, so
 * a caller cannot accidentally authorize against the key it was handed.
 */
export function assertKeyBelongsToTenant(
  key: string,
  tenant: string,
  expectedPrefix: string,
): void {
  const parsed = parseTenantFromKey(key, expectedPrefix);
  if (parsed === null) {
    throw new ValidationError(
      `Object key "${key.slice(0, 80)}" is not under the registry prefix "${expectedPrefix}"`,
    );
  }
  if (parsed !== tenant) {
    // Deliberately vague to the caller; the specifics are logged, not returned.
    throw new ValidationError("Object key does not belong to the requesting tenant");
  }
}
