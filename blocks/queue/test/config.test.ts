import { describe, expect, it } from "vitest";
import { loadQueueConfig, parseConcurrency } from "../src/config.js";

describe("parseConcurrency", () => {
  it("accepts an empty object", () => {
    expect(parseConcurrency("{}")).toEqual({});
  });

  it("parses per-type caps", () => {
    expect(parseConcurrency('{"rag.embed":4,"vision.tag":2}')).toEqual({
      "rag.embed": 4,
      "vision.tag": 2,
    });
  });

  // A silently-dropped cap shows up as an unexplained capacity-hours bill rather than an
  // error, so every malformed shape must be loud.
  it("rejects malformed JSON with an actionable message", () => {
    expect(() => parseConcurrency("{rag:4}")).toThrow(/not valid JSON.*Expected an object/s);
  });

  it("rejects arrays and scalars", () => {
    expect(() => parseConcurrency("[1,2]")).toThrow(/must be a JSON object/);
    expect(() => parseConcurrency("4")).toThrow(/must be a JSON object/);
  });

  it("rejects non-positive and fractional caps", () => {
    expect(() => parseConcurrency('{"a":0}')).toThrow(/positive integer/);
    expect(() => parseConcurrency('{"a":-1}')).toThrow(/positive integer/);
    expect(() => parseConcurrency('{"a":1.5}')).toThrow(/positive integer/);
    expect(() => parseConcurrency('{"a":"4"}')).toThrow(/positive integer/);
  });
});

describe("loadQueueConfig", () => {
  it("applies documented defaults when nothing is set", () => {
    const config = loadQueueConfig({});
    expect(config.batchSize).toBe(25);
    expect(config.leaseSeconds).toBe(300);
    expect(config.budgetMs).toBe(45_000);
    expect(config.retentionDays).toBe(7);
    expect(config.concurrency).toEqual({});
  });

  it("reads overrides from the environment", () => {
    const config = loadQueueConfig({
      QUEUE_BATCH_SIZE: "100",
      QUEUE_CONCURRENCY: '{"rag.embed":8}',
    });
    expect(config.batchSize).toBe(100);
    expect(config.concurrency).toEqual({ "rag.embed": 8 });
  });

  it("rejects out-of-range values rather than clamping", () => {
    // Clamping would hide a typo; a lease of 0 seconds means every job is instantly stealable.
    expect(() => loadQueueConfig({ QUEUE_LEASE_SECONDS: "0" })).toThrow(/must be >= 10/);
    expect(() => loadQueueConfig({ QUEUE_BATCH_SIZE: "0" })).toThrow(/must be >= 1/);
    expect(() => loadQueueConfig({ QUEUE_BATCH_SIZE: "abc" })).toThrow(/must be an integer/);
  });
});
