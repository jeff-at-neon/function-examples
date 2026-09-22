/** Structured logging. One JSON object per line so platform log search works. */

export type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
  /**
   * Record that work was intentionally bounded.
   *
   * Convention §10: no silent caps. Silent truncation reads as "covered everything" when it
   * didn't, which is how a sweeper appears healthy while permanently lagging.
   */
  capped(what: string, fields: Record<string, unknown>): void;
}

export function createLogger(base: Record<string, unknown> = {}): Logger {
  const threshold = ORDER[(process.env["NEON_BLOCKS_LOG_LEVEL"] as Level) ?? "info"] ?? 20;

  const emit = (level: Level, msg: string, fields?: Record<string, unknown>): void => {
    if (ORDER[level] < threshold) return;
    const line = JSON.stringify({
      level,
      msg,
      ...base,
      ...fields,
      ts: new Date().toISOString(),
    });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (fields) => createLogger({ ...base, ...fields }),
    capped: (what, fields) => emit("warn", `bounded: ${what}`, { ...fields, bounded: true }),
  };
}
