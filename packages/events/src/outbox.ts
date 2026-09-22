/**
 * Outbox transport — the one that works today.
 *
 * Producers insert into `blocks_core.outbox_events`; a cron-driven drain claims batches with
 * `FOR UPDATE SKIP LOCKED` and hands them to consumers. At-least-once, which is the same
 * guarantee a native row trigger would give.
 */

import type { Queryable } from "@neon-blocks/core";
import { assertValidEventType, type BlockEvent, type PublishRequest } from "./envelope.js";
import type { ClaimOptions, EventTransport } from "./transport.js";

/**
 * A claimed outbox row. The index signature satisfies `Queryable`'s row constraint — `pg`
 * returns arbitrary column sets, so row types are structural rather than exact.
 */
interface OutboxRow {
  [column: string]: unknown;
  id: string;
  event_type: string;
  subject: string;
  payload: unknown;
  occurred_at: Date;
  attempts: number;
  meta: Record<string, unknown> | null;
}

export const outboxTransport: EventTransport = {
  name: "outbox",
  available: true,

  async publish(db: Queryable, request: PublishRequest): Promise<string> {
    assertValidEventType(request.type);

    // ON CONFLICT on the idempotency key makes a retried publish a no-op. The RETURNING
    // clause is empty on conflict, so we re-select to give the caller the original id —
    // callers need a stable id to correlate, including on the duplicate path.
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO blocks_core.outbox_events
         (event_type, subject, payload, occurred_at, idempotency_key, meta)
       VALUES ($1, $2, $3::jsonb, COALESCE($4, now()), $5, $6::jsonb)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        request.type,
        request.subject,
        JSON.stringify(request.payload ?? null),
        request.occurredAt ?? null,
        request.idempotencyKey ?? null,
        JSON.stringify(request.meta ?? {}),
      ],
    );

    const inserted = rows[0]?.id;
    if (inserted) return inserted;

    const existing = await db.query<{ id: string }>(
      `SELECT id FROM blocks_core.outbox_events WHERE idempotency_key = $1`,
      [request.idempotencyKey],
    );
    const id = existing.rows[0]?.id;
    if (!id) {
      // Neither inserted nor found: the conflict target didn't apply, which means a caller
      // passed no idempotency key and the insert was skipped for another reason.
      throw new Error(
        "Outbox publish neither inserted nor matched an existing row. " +
          "This usually means a unique constraint other than idempotency_key was violated.",
      );
    }
    return id;
  },

  async claim(db: Queryable, opts: ClaimOptions): Promise<readonly BlockEvent[]> {
    // SKIP LOCKED is what makes overlapping drains safe: a second invocation walks past rows
    // the first is holding rather than blocking on them or double-processing.
    const { rows } = await db.query<OutboxRow>(
      `WITH claimed AS (
         SELECT id
         FROM blocks_core.outbox_events
         WHERE delivered_at IS NULL
           AND (retry_at IS NULL OR retry_at <= now())
           AND ($2::text[] IS NULL OR event_type = ANY($2::text[]))
         ORDER BY occurred_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE blocks_core.outbox_events o
       SET attempts = o.attempts + 1,
           claimed_at = now(),
           claimed_by = $3
       FROM claimed
       WHERE o.id = claimed.id
       RETURNING o.id, o.event_type, o.subject, o.payload, o.occurred_at, o.attempts, o.meta`,
      [opts.limit, opts.types ?? null, opts.consumer],
    );

    return rows.map((row) => ({
      id: row.id,
      type: row.event_type,
      subject: row.subject,
      payload: row.payload,
      occurredAt: row.occurred_at,
      source: "outbox" as const,
      meta: { ...(row.meta ?? {}), attempts: row.attempts },
    }));
  },

  async ack(db: Queryable, eventIds: readonly string[]): Promise<void> {
    if (eventIds.length === 0) return;
    await db.query(
      `UPDATE blocks_core.outbox_events
       SET delivered_at = now(), last_error = NULL, retry_at = NULL
       WHERE id = ANY($1::uuid[])`,
      [eventIds],
    );
  },

  async fail(db: Queryable, eventId: string, error: string, retryAt: Date | null): Promise<void> {
    // retryAt === null means "no more retries" — the row stays undelivered with an error and
    // is picked up by the dead-letter view rather than being retried forever.
    await db.query(
      `UPDATE blocks_core.outbox_events
       SET last_error = $2, retry_at = $3, dead_lettered_at = CASE WHEN $3::timestamptz IS NULL THEN now() ELSE NULL END
       WHERE id = $1`,
      [eventId, error.slice(0, 2000), retryAt],
    );
  },
};
