/**
 * Trigger payload parsing and safety.
 *
 * Conventions §7 and §8 are enforced here so that no individual block has to rediscover
 * the forged-event problem or the write-amplification loop the hard way.
 */

import { timingSafeEqual } from "node:crypto";

/** Header Neon sets on trigger delivery. Identification only — NOT authentication. */
export const TRIGGER_ID_HEADER = "x-neon-trigger-invocation-id";

/**
 * Optional shared secret. Not a Neon feature: the user sets this env var and puts the same
 * value in the trigger's `function_path` query string. Until Neon signs trigger delivery,
 * this is the only way to actually authenticate an event rather than merely recognise it.
 */
export const TRIGGER_SECRET_ENV = "NEON_BLOCKS_TRIGGER_SECRET";

export interface ScheduleEvent {
  readonly type: "schedule";
  readonly scheduledAt: string;
  readonly invocationId: string | undefined;
}

export interface StorageObjectCreatedEvent {
  readonly type: "storage_object_created";
  readonly bucketName: string;
  readonly objectKey: string;
  readonly invocationId: string | undefined;
}

export type TriggerEvent = ScheduleEvent | StorageObjectCreatedEvent;

export class TriggerPayloadError extends Error {
  override readonly name = "TriggerPayloadError";
}

export class TriggerAuthError extends Error {
  override readonly name = "TriggerAuthError";
}

/**
 * Parse a trigger POST body.
 *
 * Deliberately strict about what it extracts. Official docs specify exactly
 * `{ type, data: { bucket_name, object_key } }` for storage events; third-party write-ups
 * claim richer fields (size, content_type, etag) that are NOT documented. We do not read
 * them — blocks HEAD the object instead. Trusting an undocumented field that silently
 * disappears is a worse failure than one extra request.
 */
export function parseTriggerEvent(body: unknown, headers?: Headers): TriggerEvent {
  if (typeof body !== "object" || body === null) {
    throw new TriggerPayloadError("Trigger body is not a JSON object");
  }

  const envelope = body as { type?: unknown; data?: unknown };
  const data = (typeof envelope.data === "object" && envelope.data !== null
    ? envelope.data
    : {}) as Record<string, unknown>;
  const invocationId = headers?.get(TRIGGER_ID_HEADER) ?? undefined;

  switch (envelope.type) {
    case "schedule": {
      const scheduledAt = data["scheduled_at"];
      if (typeof scheduledAt !== "string") {
        throw new TriggerPayloadError("schedule event is missing data.scheduled_at");
      }
      return { type: "schedule", scheduledAt, invocationId };
    }
    case "storage_object_created": {
      const bucketName = data["bucket_name"];
      const objectKey = data["object_key"];
      if (typeof bucketName !== "string" || bucketName === "") {
        throw new TriggerPayloadError("storage event is missing data.bucket_name");
      }
      if (typeof objectKey !== "string" || objectKey === "") {
        throw new TriggerPayloadError("storage event is missing data.object_key");
      }
      return {
        type: "storage_object_created",
        bucketName,
        objectKey: assertSafeObjectKey(objectKey),
        invocationId,
      };
    }
    default:
      throw new TriggerPayloadError(
        `Unsupported trigger type ${JSON.stringify(envelope.type)}. ` +
          `Known types: schedule, storage_object_created.`,
      );
  }
}

/**
 * Reject hostile object keys.
 *
 * Trigger delivery is unauthenticated, so `object_key` is attacker-controlled in the worst
 * case. A block that interpolates it into a path or a tenant lookup without checking is how
 * you get cross-tenant reads.
 */
export function assertSafeObjectKey(key: string): string {
  if (key.length > 1024) {
    throw new TriggerPayloadError("object_key exceeds 1024 bytes");
  }
  if (key.includes("\0")) {
    throw new TriggerPayloadError("object_key contains a null byte");
  }
  // Reject traversal in both raw and percent-encoded form.
  const decoded = safeDecode(key);
  for (const candidate of [key, decoded]) {
    const segments = candidate.split("/");
    if (segments.some((s) => s === ".." || s === ".")) {
      throw new TriggerPayloadError(`object_key contains a path traversal segment: ${key}`);
    }
    if (candidate.startsWith("/")) {
      throw new TriggerPayloadError(`object_key must be relative: ${key}`);
    }
  }
  return key;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // Malformed encoding — the raw checks still apply.
    return value;
  }
}

/**
 * Confirm a request carries a trigger id, and — if a shared secret is configured — that it
 * matches.
 *
 * `requireSecret: true` makes a missing secret a hard error, which is the right default for
 * blocks that mutate data. Without it this function only proves the request *looks* like a
 * trigger.
 */
export function assertTriggerAuthentic(
  request: { headers: Headers; url: string },
  opts: { requireSecret?: boolean; env?: NodeJS.ProcessEnv } = {},
): void {
  const env = opts.env ?? process.env;
  const expected = env[TRIGGER_SECRET_ENV];

  if (!request.headers.get(TRIGGER_ID_HEADER)) {
    throw new TriggerAuthError(
      `Request is missing ${TRIGGER_ID_HEADER}; it did not come from a Neon trigger.`,
    );
  }

  if (!expected) {
    if (opts.requireSecret) {
      throw new TriggerAuthError(
        `${TRIGGER_SECRET_ENV} is not set. Neon does not sign trigger delivery, so this ` +
          `block requires a shared secret: set ${TRIGGER_SECRET_ENV} and append ` +
          `?secret=<value> to the trigger's function_path.`,
      );
    }
    return;
  }

  const provided =
    new URL(request.url).searchParams.get("secret") ??
    request.headers.get("x-neon-blocks-trigger-secret");

  if (!provided || !constantTimeEquals(provided, expected)) {
    throw new TriggerAuthError("Trigger shared secret is missing or does not match.");
  }
}

export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch, which itself leaks length. Compare lengths
  // first and always run a fixed-cost comparison.
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export class LoopHazardError extends Error {
  override readonly name = "LoopHazardError";
}

/**
 * Refuse to start when a block's output would retrigger its own input.
 *
 * Storage triggers have no suffix filter and no negative prefix filter, so "watch bucket X,
 * write to bucket X" is an infinite loop that bills real money. The only safe shapes are a
 * separate output bucket, or an output prefix provably disjoint from the watched prefix.
 *
 * This throws at startup rather than warning, because the failure mode is a runaway cost
 * that a user discovers on their invoice.
 */
export function assertNoLoop(config: {
  inputBucket: string;
  inputPrefix?: string;
  outputBucket: string;
  outputPrefix?: string;
}): void {
  const { inputBucket, outputBucket } = config;
  const inputPrefix = config.inputPrefix ?? "";
  const outputPrefix = config.outputPrefix ?? "";

  if (inputBucket !== outputBucket) return; // Separate buckets: always safe.

  if (outputPrefix === "" || inputPrefix === "") {
    throw new LoopHazardError(
      `Write-amplification loop: input and output both use bucket "${inputBucket}" and at ` +
        `least one prefix is empty, so writes will retrigger this function forever. ` +
        `Use a separate output bucket, or set disjoint non-empty prefixes.`,
    );
  }

  // Disjoint means neither is a prefix of the other. "img/" and "img/thumbs/" is a loop:
  // a write under img/thumbs/ still matches a trigger watching img/.
  if (outputPrefix.startsWith(inputPrefix) || inputPrefix.startsWith(outputPrefix)) {
    throw new LoopHazardError(
      `Write-amplification loop: output prefix "${outputPrefix}" overlaps watched prefix ` +
        `"${inputPrefix}" in bucket "${inputBucket}". Storage triggers have no negative ` +
        `prefix filter, so outputs would retrigger this function. Make the prefixes disjoint ` +
        `or write to a different bucket.`,
    );
  }
}
