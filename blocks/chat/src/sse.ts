/**
 * Server-sent events framing.
 *
 * Pure and framework-free on purpose: the /chat endpoint returns a plain text/event-stream body so
 * any client (a fetch reader, EventSource, or the Vercel AI SDK transport) can consume it without a
 * client library. The wire contract is documented in the block README.
 */

export interface SseFrame {
  /** SSE event name. Omit for the default "message" event. */
  event?: string;
  /** Payload. Objects are JSON-encoded; strings are sent verbatim. */
  data: unknown;
}

/** Headers a streaming response must set so proxies do not buffer or transform it. */
export const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
};

/**
 * Encode one frame to the SSE wire format.
 *
 * Multi-line payloads are split across `data:` lines per the spec, and each frame is terminated by
 * a blank line. A newline inside a JSON string is escaped by JSON.stringify, so only literal string
 * payloads can span lines.
 */
export function encodeSse(frame: SseFrame): string {
  const payload = typeof frame.data === "string" ? frame.data : JSON.stringify(frame.data);
  const lines: string[] = [];
  if (frame.event) lines.push(`event: ${frame.event}`);
  for (const line of payload.split("\n")) lines.push(`data: ${line}`);
  return `${lines.join("\n")}\n\n`;
}

/** A heartbeat comment. Sent periodically so an idle stream is not dropped by an intermediary. */
export function sseComment(text = "ping"): string {
  return `: ${text}\n\n`;
}
