/**
 * Presence tracking.
 *
 * Presence is TTL-based, never explicitly-terminated, because a closing browser tab sends
 * nothing. A design that waits for an unsubscribe shows ghosts forever; one that expires on
 * silence is eventually correct, which is the achievable guarantee.
 */

import { createLogger, type Logger, type Queryable } from "@neon-blocks/core";

export interface JoinOptions {
  connectionId: string;
  channel: string;
  actor: string;
  metadata?: Record<string, unknown>;
}

/** Record or refresh a presence row. Also serves as the heartbeat. */
export async function join(db: Queryable, opts: JoinOptions): Promise<void> {
  await db.query(
    `INSERT INTO blocks_realtime.presence (connection_id, channel, actor, metadata)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (connection_id) DO UPDATE
       SET last_seen_at = now(),
           channel = EXCLUDED.channel,
           metadata = EXCLUDED.metadata`,
    [opts.connectionId, opts.channel, opts.actor, JSON.stringify(opts.metadata ?? {})],
  );
}

export async function leave(db: Queryable, connectionId: string): Promise<void> {
  await db.query(`DELETE FROM blocks_realtime.presence WHERE connection_id = $1`, [connectionId]);
}

export interface PresenceEntry {
  actor: string;
  connectionId: string;
  metadata: Record<string, unknown>;
  connectedAt: Date;
  lastSeenAt: Date;
}

/**
 * Who is currently on a channel.
 *
 * Filters by TTL in the query rather than trusting the sweeper to have run: a five-minute cron
 * means up to five minutes of ghosts otherwise, and the read is cheap.
 */
export async function listPresence(
  db: Queryable,
  channel: string,
  ttlSeconds: number,
): Promise<PresenceEntry[]> {
  interface Row {
    [column: string]: unknown;
    connection_id: string;
    actor: string;
    metadata: Record<string, unknown>;
    connected_at: Date;
    last_seen_at: Date;
  }

  const { rows } = await db.query<Row>(
    `SELECT connection_id, actor, metadata, connected_at, last_seen_at
     FROM blocks_realtime.presence
     WHERE channel = $1
       AND last_seen_at > now() - make_interval(secs => $2::double precision)
     ORDER BY connected_at`,
    [channel, ttlSeconds],
  );

  return rows.map((row) => ({
    actor: row.actor,
    connectionId: row.connection_id,
    metadata: row.metadata,
    connectedAt: row.connected_at,
    lastSeenAt: row.last_seen_at,
  }));
}

export interface SweepResult {
  presenceExpired: number;
  eventsPruned: number;
  warnings: string[];
}

/**
 * Cron sweeper: expire stale presence and prune the event buffer.
 *
 * The buffer is a replay window, not an event log — the queue block owns durable eventing. Left
 * unpruned it grows without bound and every reconnect scan gets slower.
 */
export async function sweep(
  db: Queryable,
  opts: { presenceTtlSeconds: number; eventRetentionMinutes: number; logger?: Logger },
): Promise<SweepResult> {
  const log = opts.logger ?? createLogger({ block: "realtime", op: "sweep" });
  const warnings: string[] = [];

  const { rowCount: presenceExpired } = await db.query(
    `DELETE FROM blocks_realtime.presence
     WHERE last_seen_at < now() - make_interval(secs => $1::double precision)`,
    [opts.presenceTtlSeconds],
  );

  const { rowCount: eventsPruned } = await db.query(
    `DELETE FROM blocks_realtime.events
     WHERE id IN (
       SELECT id FROM blocks_realtime.events
       WHERE created_at < now() - make_interval(mins => $1::int)
       LIMIT 50000
     )`,
    [opts.eventRetentionMinutes],
  );

  if ((eventsPruned ?? 0) >= 50_000) {
    // §10, no silent caps. Hitting the limit means the buffer is growing faster than it is
    // pruned, and a five-minute cron will never catch up.
    warnings.push(
      `pruned the maximum 50000 events in one pass; the buffer is growing faster than the ` +
        `sweeper drains it. Lower REALTIME_EVENT_RETENTION_MINUTES or publish less.`,
    );
    log.capped("event prune batch filled", { pruned: eventsPruned });
  }

  const result = {
    presenceExpired: presenceExpired ?? 0,
    eventsPruned: eventsPruned ?? 0,
    warnings,
  };
  for (const warning of warnings) log.warn(warning);
  log.info("sweep complete", result);
  return result;
}
