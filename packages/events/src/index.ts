import type { Queryable } from "@neon-blocks/core";
import { outboxTransport } from "./outbox.js";
import { nativeRowTriggerTransport } from "./native.js";
import { resolveTransport, type EventTransport } from "./transport.js";
import type { PublishRequest } from "./envelope.js";

export {
  type BlockEvent,
  type PublishRequest,
  type EventSource,
  matchesPattern,
  assertValidEventType,
} from "./envelope.js";
export {
  resolveTransport,
  TransportUnavailableError,
  NATIVE_TRANSPORT_ENV,
  type EventTransport,
  type ClaimOptions,
} from "./transport.js";
export { outboxTransport } from "./outbox.js";
export { nativeRowTriggerTransport } from "./native.js";
export {
  EventConsumer,
  type EventHandler,
  type DrainResult,
  type DrainOptions,
} from "./consumer.js";

/** The transport configured for this deployment. Defaults to the outbox. */
export function activeTransport(env?: NodeJS.ProcessEnv): EventTransport {
  return resolveTransport({ outbox: outboxTransport, native: nativeRowTriggerTransport }, env);
}

/**
 * Publish an event.
 *
 * The one call app code and blocks use. Which transport carries it is not the caller's
 * concern — that indirection is the whole point (docs/ROW_EVENTS.md).
 */
export function publish(db: Queryable, request: PublishRequest): Promise<string> {
  return activeTransport().publish(db, request);
}
