/**
 * Capacity findings. Pure. Honest about the limit the scaffold noted: per-function compute-hours
 * need Neon billing/invocation data a SQL function cannot read, so this reports the capacity signals
 * that ARE observable from the database — connection pressure and size — and says so.
 */

export interface CapacityFinding {
  kind: "connection_pressure" | "capacity_cost";
  severity: "info" | "warn" | "critical";
  objectName: string;
  detail: string;
  metrics: Record<string, number>;
}

/**
 * Flag connection pressure from live connections vs. max_connections. Pooled workloads that leak
 * connections hit this before anything else. Null when comfortably below the warn ratio.
 */
export function assessConnectionPressure(
  connectionCount: number,
  maxConnections: number,
): CapacityFinding | null {
  if (maxConnections <= 0) return null;
  const ratio = connectionCount / maxConnections;
  if (ratio < 0.75) return null;
  const severity = ratio >= 0.9 ? "critical" : "warn";
  return {
    kind: "connection_pressure",
    severity,
    objectName: "connections",
    detail: `${connectionCount} of ${maxConnections} connections in use (${Math.round(ratio * 100)}%). Approaching the limit; new connections will be refused at 100%.`,
    metrics: { connection_count: connectionCount, max_connections: maxConnections, ratio },
  };
}

/**
 * An honest capacity-cost note. The active-vs-idle compute-hour ratio (the free tier's 10:400 split)
 * is billed on invocation data this block cannot read, so this reports database size as the one
 * cost signal SQL exposes and states the limitation rather than faking an estimate.
 */
export function capacityCostNote(databaseBytes: number): CapacityFinding {
  return {
    kind: "capacity_cost",
    severity: "info",
    objectName: "database",
    detail:
      `Database is ${databaseBytes} bytes. Per-function compute-hours (active vs. idle CU) are billed ` +
      `on invocation data that is not visible to a SQL function, so this is storage only, not compute cost.`,
    metrics: { database_bytes: databaseBytes },
  };
}
