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
  /**
   * When the tick was scheduled, ISO-8601. Schedule deliveries carry no body, so this is the
   * receive time unless the platform supplies `data.scheduled_at`; treat it as advisory, not exact.
   */
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
 * The delivery envelope (confirmed against a live Neon trigger) is:
 *
 *   { version, invocation_id, trigger: { type, id, name }, data: { … } }
 *
 * The discriminator lives at **`trigger.type`** — NOT top level. A storage delivery carries
 *   `trigger.type: "storage_object_created"` with `data: { bucket_name, object_key }`; a schedule
 * delivery carries `trigger.type: "schedule"`. We read `trigger.type` first and fall back to a
 * top-level `type` for robustness. For storage we extract only the documented `data` fields —
 * blocks HEAD the object for size/content-type rather than trust undocumented extras. A missing
 * discriminator is treated as a schedule (a bare cron tick may arrive with an empty body); only a
 * present-but-unrecognized type is an error.
 */
export function parseTriggerEvent(body: unknown, headers?: Headers): TriggerEvent {
  const envelope = (typeof body === "object" && body !== null ? body : {}) as {
    type?: unknown;
    trigger?: unknown;
    data?: unknown;
    scheduled_at?: unknown;
    invocation_id?: unknown;
  };
  const data = (typeof envelope.data === "object" && envelope.data !== null
    ? envelope.data
    : {}) as Record<string, unknown>;
  const trigger = (typeof envelope.trigger === "object" && envelope.trigger !== null
    ? envelope.trigger
    : {}) as { type?: unknown };
  // Discriminator is nested under `trigger.type`; accept a top-level `type` as a fallback.
  const type = trigger.type ?? envelope.type;
  // The header is the trusted invocation id; the body carries a copy as a fallback.
  const invocationId =
    headers?.get(TRIGGER_ID_HEADER) ??
    (typeof envelope.invocation_id === "string" ? envelope.invocation_id : undefined);

  if (type === "storage_object_created") {
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

  // An explicit "schedule", or a missing discriminator (a bare cron tick may arrive with an empty
  // body), is a schedule. scheduled_at is optional: use it if provided, else fall back to now.
  if (type === undefined || type === null || type === "schedule") {
    const scheduledAt =
      typeof data["scheduled_at"] === "string"
        ? (data["scheduled_at"] as string)
        : typeof envelope.scheduled_at === "string"
          ? envelope.scheduled_at
          : new Date().toISOString();
    return { type: "schedule", scheduledAt, invocationId };
  }

  throw new TriggerPayloadError(
    `Unsupported trigger type ${JSON.stringify(type)}. ` +
      `Known types: schedule, storage_object_created.`,
  );
}

/**
 * Read a trigger delivery straight off the Request and parse it.
 *
 * Prefer this over `parseTriggerEvent(await request.json(), …)`: a scheduled tick may arrive with
 * an **empty body**, and `Request.json()` throws on empty input — so calling it directly turns a
 * normal cron delivery into a 500 before parsing ever happens. This reads the body as text and
 * treats empty as `{}` (a schedule), only rejecting a non-empty body that is not valid JSON.
 */
export async function parseTriggerRequest(request: Request): Promise<TriggerEvent> {
  const raw = await request.text();
  let body: unknown = {};
  if (raw.trim() !== "") {
    try {
      body = JSON.parse(raw);
    } catch {
      throw new TriggerPayloadError("Trigger body is not valid JSON");
    }
  }
  return parseTriggerEvent(body, request.headers);
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
