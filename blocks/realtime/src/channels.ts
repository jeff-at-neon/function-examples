/**
 * Channel name validation and subscription matching.
 *
 * Channel names arrive from untrusted clients, so they are validated rather than trusted — they
 * end up in SQL predicates, in presence rows, and echoed back to other subscribers.
 */

import { ValidationError } from "@neon-blocks/core";

const CHANNEL_PATTERN = /^[a-zA-Z0-9_:.-]{1,128}$/;

/**
 * Validate one channel name.
 *
 * The allowed set deliberately excludes `*`, `%`, and `_`-as-wildcard concerns: names are matched
 * by equality or explicit prefix, never by LIKE against client input, so a client cannot craft a
 * pattern that subscribes it to everything.
 */
export function assertValidChannel(channel: string): string {
  if (!CHANNEL_PATTERN.test(channel)) {
    throw new ValidationError(
      `Invalid channel "${channel.slice(0, 40)}". Use 1-128 characters from ` +
        `[A-Za-z0-9_:.-] — for example "room:42" or "org.7.notifications".`,
    );
  }
  return channel;
}

/**
 * Parse and validate a subscription request.
 *
 * Enforces a per-connection channel cap: without one, a single request could subscribe to
 * thousands of channels and hold a connection that scans the whole event buffer on every poll.
 */
export function parseChannels(raw: string | null, maxChannels: number): string[] {
  if (!raw || raw.trim() === "") {
    throw new ValidationError(
      'At least one channel is required, e.g. ?channels=room:42 or ?channels=a,b,c',
    );
  }

  const requested = raw
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c !== "");

  if (requested.length === 0) {
    throw new ValidationError(
      "At least one channel is required, e.g. ?channels=room:42 or ?channels=a,b,c",
    );
  }

  // Deduplicate before counting: a client sending ?channels=a,a,a is subscribing to one channel,
  // and rejecting it against a cap of 1 would be wrong. Validation runs first so an invalid name
  // is reported even when it is a duplicate.
  const unique = [...new Set(requested.map(assertValidChannel))];

  if (unique.length > maxChannels) {
    throw new ValidationError(
      `Requested ${unique.length} distinct channels but the limit is ${maxChannels}. ` +
        `Open multiple connections, or raise REALTIME_MAX_CHANNELS_PER_CONNECTION.`,
    );
  }

  return unique;
}

/** Notification payload published by `blocks_realtime.publish`. */
export interface ChannelNotification {
  id: bigint;
  channel: string;
  event: string;
}

/**
 * Parse a NOTIFY payload.
 *
 * Returns null rather than throwing on malformed input: a bad notification must not tear down a
 * live subscriber loop serving many clients.
 */
export function parseNotification(payload: string | undefined): ChannelNotification | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const { id, channel, event } = parsed;
    if (typeof id !== "number" && typeof id !== "string") return null;
    if (typeof channel !== "string" || !CHANNEL_PATTERN.test(channel)) return null;
    return {
      id: BigInt(id),
      channel,
      event: typeof event === "string" ? event : "message",
    };
  } catch {
    return null;
  }
}
