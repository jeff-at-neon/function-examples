/**
 * The SSE stream: a dedicated LISTEN connection bridged to a ReadableStream.
 *
 * This is the block that justifies the whole catalog's "next to your data" claim. Neon Functions
 * are long-running with native SSE and WebSocket support, so a held connection sits in *waiting*
 * Capacity-Hours at $0.025/hour — a quarter of the active rate — while Postgres itself does the
 * fan-out via NOTIFY. Competitors need Redis plus a separate always-on service to match this.
 *
 * Connection discipline matters more than throughput here:
 *   * one dedicated client per stream, checked out of the pool and NOT shared — a connection in
 *     LISTEN mode cannot be safely reused for queries by another request
 *   * a hard lifetime cap, so a connection cannot be held forever across deploys
 *   * release on every exit path, including client disconnect, which is the leak that quietly
 *     exhausts a pool
 */

import type { Pool, PoolClient } from "pg";
import { createLogger, type Logger } from "@neon-blocks/core";
import { parseNotification } from "./channels.js";
import { encodeSseFrame, sseHeartbeat } from "./sse.js";

/** Postgres channel every publish notifies. Fixed, not per-logical-channel. */
export const PG_CHANNEL = "blocks_realtime";

export interface StreamOptions {
  pool: Pool;
  channels: readonly string[];
  /** Resume point from Last-Event-ID. Events after this cursor are replayed on connect. */
  since: bigint | null;
  maxConnectionSeconds: number;
  heartbeatSeconds: number;
  /** Presence row to maintain, if the client identified itself. */
  presence?: { connectionId: string; actor: string; metadata: Record<string, unknown> };
  logger?: Logger;
  /** Aborts when the HTTP client disconnects. */
  signal?: AbortSignal;
}

interface EventRow {
  [column: string]: unknown;
  id: string;
  channel: string;
  event: string;
  payload: unknown;
}

/**
 * Build the SSE body for a subscription.
 *
 * Returns a ReadableStream so the caller can hand it straight to a Response. All cleanup is
 * inside the stream's lifecycle, which is the only place that reliably runs on client disconnect.
 */
export function createEventStream(opts: StreamOptions): ReadableStream<Uint8Array> {
  const log = opts.logger ?? createLogger({ block: "realtime", op: "stream" });
  const encoder = new TextEncoder();
  const channelSet = new Set(opts.channels);

  let client: PoolClient | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let lifetime: NodeJS.Timeout | undefined;
  let cursor = opts.since ?? 0n;
  let closed = false;

  /**
   * Declared outside the stream handlers so `cancel()` can reach it.
   *
   * Assigned in `start`. If cleanup lived only inside `start`, a consumer that cancels without an
   * abort signal would strand the checked-out client in LISTEN state forever — the leak that
   * silently exhausts a pool after a few hundred disconnects.
   */
  let shutdown: (reason: string) => void = () => {
    closed = true;
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Enqueue after the consumer has gone throws; that is a normal disconnect.
          closed = true;
        }
      };

      shutdown = (reason: string): void => {
        if (closed) return;
        closed = true;

        if (heartbeat) clearInterval(heartbeat);
        if (lifetime) clearTimeout(lifetime);

        // Removing the listener before release matters: a client returned to the pool while still
        // subscribed would deliver notifications into a handler for a dead stream.
        if (client) {
          client.removeAllListeners("notification");
          client.query(`UNLISTEN ${PG_CHANNEL}`).catch(() => {
            // Best effort. If UNLISTEN fails the client is broken anyway; release(true)
            // destroys it rather than returning a poisoned connection to the pool.
          });
          client.release(true);
          client = undefined;
        }

        try {
          controller.close();
        } catch {
          // Already closed by the consumer.
        }
        log.info("stream closed", { reason, channels: [...channelSet] });
      };

      opts.signal?.addEventListener("abort", () => shutdown("client disconnected"));

      try {
        // A dedicated client, checked out for this stream's lifetime. Cannot be a pooled query
        // connection: LISTEN state is per-connection and would leak into unrelated queries.
        client = await opts.pool.connect();

        client.on("error", (err) => {
          log.warn("listen connection error", { err: err.message });
          shutdown("connection error");
        });

        client.on("notification", (message) => {
          const parsed = parseNotification(message.payload);
          if (!parsed || !channelSet.has(parsed.channel)) return;

          // The notification carries only a cursor (NOTIFY caps payloads at 8000 bytes), so read
          // the actual rows. Draining by cursor rather than fetching just this id also closes the
          // gap where events published during the initial replay would otherwise be missed.
          void drain().catch((err) => {
            log.error("failed to drain events after notification", {
              err: err instanceof Error ? err.message : String(err),
            });
          });
        });

        await client.query(`LISTEN ${PG_CHANNEL}`);

        // Advise the browser's reconnect delay, then replay anything missed while disconnected.
        send(encodeSseFrame({ event: "ready", data: JSON.stringify({ channels: [...channelSet] }), retryMs: 3_000 }));
        await drain();

        heartbeat = setInterval(() => send(sseHeartbeat()), opts.heartbeatSeconds * 1_000);

        // Hard lifetime. Without it, a connection opened today is still held after a deploy, and
        // its waiting Capacity-Hours accrue indefinitely. The client reconnects and resumes from
        // its cursor, so no events are lost.
        lifetime = setTimeout(() => {
          send(encodeSseFrame({ event: "reconnect", data: JSON.stringify({ reason: "max lifetime reached" }) }));
          shutdown("max lifetime reached");
        }, opts.maxConnectionSeconds * 1_000);
      } catch (err) {
        log.error("failed to start stream", {
          err: err instanceof Error ? err.message : String(err),
        });
        shutdown("startup failure");
        throw err;
      }

      /** Send every event after `cursor` on the subscribed channels, then advance it. */
      async function drain(): Promise<void> {
        if (closed || !client) return;

        const { rows } = await client.query<EventRow>(
          `SELECT id, channel, event, payload
           FROM blocks_realtime.events
           WHERE channel = ANY($1::text[]) AND id > $2
           ORDER BY id
           LIMIT 500`,
          [[...channelSet], cursor.toString()],
        );

        for (const row of rows) {
          send(
            encodeSseFrame({
              id: row.id,
              event: row.event,
              data: JSON.stringify({ channel: row.channel, payload: row.payload }),
            }),
          );
          cursor = BigInt(row.id);
        }

        if (rows.length === 500) {
          // Bounded read; a client resuming after a long absence catches up over several drains
          // rather than in one unbounded query.
          log.capped("event replay batch filled", { channels: [...channelSet], cursor: cursor.toString() });
          await drain();
        }
      }
    },

    cancel() {
      // The consumer went away — most often a browser tab closing. This is the primary cleanup
      // path when no abort signal was supplied, so it must release the LISTEN client.
      shutdown("stream cancelled by consumer");
    },
  });
}
