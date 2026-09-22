/**
 * The event envelope. This type is the repo's most important compatibility surface.
 *
 * Blocks consume `BlockEvent`, never a platform trigger payload. When Neon ships native
 * row-event triggers, a new transport produces the same envelope and no consumer changes.
 * Every field here must be expressible by *both* the outbox transport and a plausible
 * native-trigger transport — anything outbox-specific belongs in `meta`, not at the top level.
 */

export interface BlockEvent<P = unknown> {
  /** Stable per-event id. Consumers dedupe on this. */
  readonly id: string;
  /**
   * Dotted, past-tense type: `order.status_changed`, `file.created`.
   *
   * Consumers subscribe by exact type or by `prefix.*` wildcard.
   */
  readonly type: string;
  /**
   * What the event is about — usually a primary key. Used for per-subject ordering and for
   * debouncing a hot row.
   */
  readonly subject: string;
  readonly payload: P;
  /** When the source-of-truth change happened, not when it was delivered. */
  readonly occurredAt: Date;
  /** Which transport produced this, for debugging mixed-mode deployments. */
  readonly source: EventSource;
  /** Transport-specific detail. Consumers must tolerate its absence. */
  readonly meta?: Readonly<Record<string, unknown>>;
}

export type EventSource = "outbox" | "native_row_trigger" | "direct";

export interface PublishRequest<P = unknown> {
  type: string;
  subject: string;
  payload: P;
  occurredAt?: Date;
  /**
   * Caller-supplied dedupe key. Two publishes with the same key produce one event.
   *
   * Without this, an app that retries a failed HTTP request double-publishes, and the
   * consumer's own idempotency is the only thing standing between that and a double charge.
   */
  idempotencyKey?: string;
  meta?: Record<string, unknown>;
}

/** Match an event type against a subscription pattern: exact, `prefix.*`, or `*`. */
export function matchesPattern(type: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern === type) return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1); // keep the trailing dot
    return type.startsWith(prefix);
  }
  return false;
}

/**
 * Validate an event type name.
 *
 * Enforced at publish time so a typo surfaces immediately rather than as an event no
 * consumer ever matches — a genuinely hard bug to spot, because nothing errors.
 */
export function assertValidEventType(type: string): string {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(type)) {
    throw new Error(
      `Invalid event type ${JSON.stringify(type)}. Use lowercase dotted segments, ` +
        `e.g. "order.status_changed".`,
    );
  }
  return type;
}
