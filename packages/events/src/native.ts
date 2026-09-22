/**
 * Native row-trigger transport — a placeholder that documents the migration target.
 *
 * Neon's Functions GA post described the intended trigger surface as covering "cron
 * schedules, storage events, and database/auth events". Only the first two have shipped. When
 * the third does, this file is where it lands, and the only change visible to a block is that
 * events arrive in about a second instead of on the cron interval.
 *
 * It is a hard error rather than a fallback on purpose: silently degrading to polling when an
 * operator explicitly asked for native delivery hides a platform assumption that should be
 * surfaced loudly.
 */

import type { Queryable } from "@neon-blocks/core";
import type { BlockEvent, PublishRequest } from "./envelope.js";
import type { ClaimOptions, EventTransport } from "./transport.js";

const NOT_YET = () => {
  throw new Error(
    "The native_row_trigger transport is not available: Neon has not shipped database " +
      "row-event triggers. Use the outbox transport. See docs/ROW_EVENTS.md for what changes " +
      "when they land.",
  );
};

export const nativeRowTriggerTransport: EventTransport = {
  name: "native_row_trigger",

  /**
   * Flip to true when Neon ships row events. Everything below then needs a real
   * implementation, and `blocks_core.attach_outbox_trigger` becomes the thing to retire.
   */
  available: false,

  publish: (_db: Queryable, _request: PublishRequest): Promise<string> => NOT_YET(),
  claim: (_db: Queryable, _opts: ClaimOptions): Promise<readonly BlockEvent[]> => NOT_YET(),
  ack: (_db: Queryable, _ids: readonly string[]): Promise<void> => NOT_YET(),
  fail: (_db: Queryable, _id: string, _err: string, _retryAt: Date | null): Promise<void> =>
    NOT_YET(),
};
