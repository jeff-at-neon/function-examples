/**
 * Transport selection.
 *
 * See docs/ROW_EVENTS.md. The `native_row_trigger` transport is a deliberate stub: it throws
 * a clear "not available on this platform yet" error rather than silently degrading, because
 * a reactive block that appears configured but never fires is far worse than one that
 * refuses to start.
 */

import type { BlockEvent, PublishRequest } from "./envelope.js";
import type { Queryable } from "@neon-blocks/core";

export interface EventTransport {
  readonly name: "outbox" | "native_row_trigger";
  /** True when this transport can be used on the current platform. */
  readonly available: boolean;
  publish(db: Queryable, request: PublishRequest): Promise<string>;
  /**
   * Claim a batch of undelivered events for processing.
   *
   * Claiming rather than reading: two overlapping drains must not both process the same
   * event. The outbox transport uses `FOR UPDATE SKIP LOCKED` for this.
   */
  claim(db: Queryable, opts: ClaimOptions): Promise<readonly BlockEvent[]>;
  ack(db: Queryable, eventIds: readonly string[]): Promise<void>;
  fail(db: Queryable, eventId: string, error: string, retryAt: Date | null): Promise<void>;
}

export interface ClaimOptions {
  /** Max events to claim. Bounded so one drain can't hold an invocation open indefinitely. */
  limit: number;
  /** Only claim these types. Omit for all. */
  types?: readonly string[];
  /** Consumer identity, recorded for debugging stuck events. */
  consumer: string;
}

export const NATIVE_TRANSPORT_ENV = "NEON_BLOCKS_EVENT_TRANSPORT";

export class TransportUnavailableError extends Error {
  override readonly name = "TransportUnavailableError";
}

/**
 * Pick a transport from the environment, defaulting to the one that actually works today.
 */
export function resolveTransport(
  transports: { outbox: EventTransport; native: EventTransport },
  env: NodeJS.ProcessEnv = process.env,
): EventTransport {
  const requested = env[NATIVE_TRANSPORT_ENV] ?? "outbox";

  switch (requested) {
    case "outbox":
      return transports.outbox;
    case "native":
    case "native_row_trigger": {
      if (!transports.native.available) {
        throw new TransportUnavailableError(
          `${NATIVE_TRANSPORT_ENV}=${requested} but Neon has not shipped database row-event ` +
            `triggers yet (only "schedule" and "storage_object_created" exist). ` +
            `Unset ${NATIVE_TRANSPORT_ENV} to use the outbox transport, which provides the ` +
            `same at-least-once semantics with cron-interval latency. ` +
            `See docs/ROW_EVENTS.md.`,
        );
      }
      return transports.native;
    }
    default:
      throw new Error(
        `Unknown ${NATIVE_TRANSPORT_ENV} value ${JSON.stringify(requested)}. ` +
          `Expected "outbox" or "native".`,
      );
  }
}
