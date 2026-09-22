/**
 * Consumer registry and the drain loop.
 *
 * This is the seam between "an event exists" and "a block reacts to it". Blocks register
 * handlers by pattern; the drain claims a bounded batch, dispatches, and records per-event
 * outcomes so one poison event can't stall the stream.
 */

import { backoffMs, createLogger, type Logger, type Queryable } from "@neon-blocks/core";
import { matchesPattern, type BlockEvent } from "./envelope.js";
import type { EventTransport } from "./transport.js";

export type EventHandler<P = unknown> = (event: BlockEvent<P>) => Promise<void>;

interface Registration {
  pattern: string;
  handler: EventHandler;
  name: string;
}

export interface DrainResult {
  claimed: number;
  delivered: number;
  failed: number;
  unmatched: number;
  /** True when the batch filled, i.e. more work is waiting right now. */
  saturated: boolean;
}

export interface DrainOptions {
  limit?: number;
  consumer?: string;
  maxAttempts?: number;
  logger?: Logger;
  /** Injectable for deterministic tests. */
  now?: () => Date;
}

export class EventConsumer {
  #registrations: Registration[] = [];
  readonly #transport: EventTransport;
  readonly #logger: Logger;

  constructor(transport: EventTransport, logger: Logger = createLogger({ pkg: "events" })) {
    this.#transport = transport;
    this.#logger = logger;
  }

  /**
   * Subscribe to a type pattern: exact (`order.created`), prefixed (`order.*`), or `*`.
   */
  on<P = unknown>(pattern: string, name: string, handler: EventHandler<P>): this {
    this.#registrations.push({ pattern, name, handler: handler as EventHandler });
    return this;
  }

  /** Types this consumer cares about, for narrowing the claim query. Null means all. */
  subscribedTypes(): readonly string[] | null {
    if (this.#registrations.some((r) => r.pattern === "*" || r.pattern.endsWith(".*"))) {
      // Wildcards can't be expressed as an equality filter, so claim everything and filter
      // in-process. Narrowing further would need LIKE, which defeats the index.
      return null;
    }
    return this.#registrations.map((r) => r.pattern);
  }

  /**
   * Claim and dispatch one batch.
   *
   * Handlers for a single event run sequentially, and a throw from one does not prevent the
   * others from running — but the event is only acked if *every* matched handler succeeded.
   * That means at-least-once per handler, so handlers must be idempotent (convention §6).
   */
  async drain(db: Queryable, opts: DrainOptions = {}): Promise<DrainResult> {
    const limit = opts.limit ?? 100;
    const maxAttempts = opts.maxAttempts ?? 8;
    const consumer = opts.consumer ?? "blocks_drain";
    const now = opts.now ?? (() => new Date());
    const log = opts.logger ?? this.#logger;

    const events = await this.#transport.claim(db, { limit, consumer, types: this.subscribedTypes() ?? undefined });
    const result: DrainResult = {
      claimed: events.length,
      delivered: 0,
      failed: 0,
      unmatched: 0,
      saturated: events.length >= limit,
    };
    if (events.length === 0) return result;

    const acked: string[] = [];

    for (const event of events) {
      const matched = this.#registrations.filter((r) => matchesPattern(event.type, r.pattern));

      if (matched.length === 0) {
        // No consumer wants this. Ack it: leaving it claimed-but-undelivered would make the
        // outbox grow forever and the backlog metric lie.
        result.unmatched++;
        acked.push(event.id);
        log.debug("event had no matching handler", { eventId: event.id, type: event.type });
        continue;
      }

      const errors: string[] = [];
      for (const registration of matched) {
        try {
          await registration.handler(event);
        } catch (err) {
          errors.push(
            `${registration.name}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (errors.length === 0) {
        acked.push(event.id);
        result.delivered++;
        continue;
      }

      result.failed++;
      const attempts = Number(event.meta?.["attempts"] ?? 1);
      const giveUp = attempts >= maxAttempts;
      const retryAt = giveUp ? null : new Date(now().getTime() + backoffMs(attempts));

      await this.#transport.fail(db, event.id, errors.join("; "), retryAt);

      if (giveUp) {
        log.error("event dead-lettered", {
          eventId: event.id,
          type: event.type,
          attempts,
          errors,
        });
      } else {
        log.warn("event failed, will retry", {
          eventId: event.id,
          type: event.type,
          attempts,
          retryAt: retryAt?.toISOString(),
          errors,
        });
      }
    }

    await this.#transport.ack(db, acked);

    if (result.saturated) {
      // Convention §10: a full batch means the drain is behind. Say so — a sweeper that
      // silently processes 100 of 10,000 events looks perfectly healthy.
      log.capped("drain batch filled; backlog remains", { limit, claimed: result.claimed });
    }

    return result;
  }
}
