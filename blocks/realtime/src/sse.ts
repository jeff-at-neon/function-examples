/**
 * Server-Sent Events framing.
 *
 * Pure string functions, kept separate because SSE has several sharp edges that are easy to get
 * wrong and hard to debug through a browser: multi-line data must be split across repeated
 * `data:` lines, and a bare newline anywhere terminates the frame early.
 */

export interface SseFrame {
  /** Event name the client listens for. Omit for the default `message`. */
  event?: string;
  data: string;
  /** Cursor echoed back by the browser as Last-Event-ID on reconnect. */
  id?: string;
  /** Tells the browser how long to wait before reconnecting, in ms. */
  retryMs?: number;
}

/**
 * Encode one SSE frame.
 *
 * Every line of `data` gets its own `data:` prefix — a raw newline inside the value would
 * otherwise end the frame and the client would receive truncated JSON.
 */
export function encodeSseFrame(frame: SseFrame): string {
  const lines: string[] = [];

  if (frame.retryMs !== undefined) lines.push(`retry: ${frame.retryMs}`);
  if (frame.id !== undefined) lines.push(`id: ${frame.id}`);
  if (frame.event !== undefined) lines.push(`event: ${frame.event}`);

  // Normalize CR and CRLF first: the spec treats all three as line breaks, and a stray CR
  // produces a frame that parses differently across browsers.
  for (const line of frame.data.replace(/\r\n|\r/g, "\n").split("\n")) {
    lines.push(`data: ${line}`);
  }

  return `${lines.join("\n")}\n\n`;
}

/**
 * A comment frame, used as a heartbeat.
 *
 * Clients ignore comments, but proxies and load balancers count any bytes as activity — without
 * these an idle stream gets closed at around 30–60 seconds by intermediaries.
 */
export function sseHeartbeat(note = "keepalive"): string {
  return `: ${note}\n\n`;
}

/** Headers an SSE response requires. */
export function sseHeaders(): Record<string, string> {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    // A cached event stream is a stream that never updates.
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // Defeats response buffering in nginx-style proxies, which otherwise hold frames until the
    // buffer fills and make a realtime stream arrive in batches.
    "x-accel-buffering": "no",
  };
}

/**
 * Parse the reconnect cursor.
 *
 * The browser sends `Last-Event-ID` automatically on reconnect; honouring it is what turns a
 * dropped connection into a gap-free resume rather than silent message loss.
 */
export function parseLastEventId(header: string | null): bigint | null {
  if (!header) return null;
  try {
    const value = BigInt(header.trim());
    return value >= 0n ? value : null;
  } catch {
    // A malformed header is not worth failing the connection over; resume from now instead.
    return null;
  }
}
