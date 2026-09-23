import { describe, expect, it } from "vitest";
import { assessConnectionPressure, capacityCostNote } from "../src/capacity.js";

describe("assessConnectionPressure", () => {
  it("returns null well below the limit", () => {
    expect(assessConnectionPressure(10, 100)).toBeNull();
  });
  it("warns at 75%+ and escalates to critical at 90%+", () => {
    expect(assessConnectionPressure(80, 100)?.severity).toBe("warn");
    expect(assessConnectionPressure(95, 100)?.severity).toBe("critical");
  });
  it("guards a non-positive max", () => {
    expect(assessConnectionPressure(5, 0)).toBeNull();
  });
  it("includes the metrics", () => {
    const f = assessConnectionPressure(90, 100);
    expect(f?.metrics).toMatchObject({ connection_count: 90, max_connections: 100 });
    expect(f?.kind).toBe("connection_pressure");
  });
});

describe("capacityCostNote", () => {
  it("is an info finding that reports size and states the compute-cost limitation", () => {
    const f = capacityCostNote(123_456);
    expect(f.kind).toBe("capacity_cost");
    expect(f.severity).toBe("info");
    expect(f.metrics["database_bytes"]).toBe(123_456);
    expect(f.detail).toMatch(/not visible to a SQL function/);
  });
});
