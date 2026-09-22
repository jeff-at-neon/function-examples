import { describe, expect, it } from "vitest";
import { encodeSseFrame, parseLastEventId, sseHeaders, sseHeartbeat } from "../src/sse.js";
import { parseChannels, parseNotification, assertValidChannel } from "../src/channels.js";

describe("encodeSseFrame", () => {
  it("encodes a minimal frame", () => {
    expect(encodeSseFrame({ data: "hello" })).toBe("data: hello\n\n");
  });

  it("includes id, event, and retry in spec order", () => {
    expect(encodeSseFrame({ id: "7", event: "update", data: "x", retryMs: 3000 })).toBe(
      "retry: 3000\nid: 7\nevent: update\ndata: x\n\n",
    );
  });

  // The sharp edge: a raw newline inside data would terminate the frame early and the client
  // would receive truncated JSON.
  it("splits multi-line data across repeated data: lines", () => {
    expect(encodeSseFrame({ data: "line1\nline2" })).toBe("data: line1\ndata: line2\n\n");
  });

  it("normalizes CRLF and bare CR, which browsers treat inconsistently", () => {
    expect(encodeSseFrame({ data: "a\r\nb\rc" })).toBe("data: a\ndata: b\ndata: c\n\n");
  });

  it("keeps JSON payloads intact through a round trip", () => {
    const payload = JSON.stringify({ nested: { text: "has\nnewline" }, n: 1 });
    const frame = encodeSseFrame({ data: payload });
    const reassembled = frame
      .trimEnd()
      .split("\n")
      .map((line) => line.replace(/^data: /, ""))
      .join("\n");
    expect(JSON.parse(reassembled)).toEqual({ nested: { text: "has\nnewline" }, n: 1 });
  });
});

describe("sseHeartbeat", () => {
  it("emits a comment frame clients ignore but proxies count as activity", () => {
    expect(sseHeartbeat()).toBe(": keepalive\n\n");
  });
});

describe("sseHeaders", () => {
  it("disables caching and proxy buffering", () => {
    const headers = sseHeaders();
    expect(headers["content-type"]).toContain("text/event-stream");
    expect(headers["cache-control"]).toContain("no-cache");
    // Without this, nginx-style proxies hold frames until a buffer fills and realtime arrives
    // in batches.
    expect(headers["x-accel-buffering"]).toBe("no");
  });
});

describe("parseLastEventId", () => {
  it("parses a valid cursor so reconnects resume without gaps", () => {
    expect(parseLastEventId("42")).toBe(42n);
    expect(parseLastEventId("  42  ")).toBe(42n);
  });

  it("returns null for absent or malformed headers instead of failing the connection", () => {
    expect(parseLastEventId(null)).toBeNull();
    expect(parseLastEventId("not-a-number")).toBeNull();
    expect(parseLastEventId("-5")).toBeNull();
  });

  it("handles cursors beyond Number.MAX_SAFE_INTEGER", () => {
    expect(parseLastEventId("9007199254740993")).toBe(9007199254740993n);
  });
});

describe("assertValidChannel", () => {
  it("accepts conventional channel names", () => {
    expect(assertValidChannel("room:42")).toBe("room:42");
    expect(assertValidChannel("org.7.notifications")).toBe("org.7.notifications");
    expect(assertValidChannel("a-b_c")).toBe("a-b_c");
  });

  // Channel names reach SQL predicates and are echoed to other subscribers, so wildcards and
  // injection characters must not survive validation.
  it("rejects wildcards, spaces, and quotes", () => {
    for (const bad of ["*", "a b", "a'b", 'a"b', "a%b", "a;b", "", "a\nb"]) {
      expect(() => assertValidChannel(bad)).toThrow(/Invalid channel/);
    }
  });

  it("rejects names over 128 characters", () => {
    expect(() => assertValidChannel("a".repeat(129))).toThrow(/Invalid channel/);
    expect(assertValidChannel("a".repeat(128))).toHaveLength(128);
  });
});

describe("parseChannels", () => {
  it("parses a comma-separated list", () => {
    expect(parseChannels("a,b,c", 16)).toEqual(["a", "b", "c"]);
  });

  it("trims whitespace and ignores empty entries", () => {
    expect(parseChannels(" a , b ,, c ", 16)).toEqual(["a", "b", "c"]);
  });

  // Otherwise a client sending ?channels=a,a,a receives every message three times.
  it("deduplicates", () => {
    expect(parseChannels("a,a,b,a", 16)).toEqual(["a", "b"]);
  });

  it("requires at least one channel", () => {
    expect(() => parseChannels(null, 16)).toThrow(/At least one channel is required/);
    expect(() => parseChannels("", 16)).toThrow(/At least one channel is required/);
    expect(() => parseChannels("  ,  ", 16)).toThrow(/At least one channel/);
  });

  // Without a cap, one request could subscribe to thousands of channels and hold a connection
  // that rescans the buffer on every notification.
  it("enforces the per-connection cap", () => {
    expect(() => parseChannels("a,b,c", 2)).toThrow(/limit is 2/);
  });

  it("counts the cap after deduplication", () => {
    expect(parseChannels("a,a,a", 1)).toEqual(["a"]);
  });
});

describe("parseNotification", () => {
  it("parses a well-formed payload", () => {
    expect(parseNotification('{"id":5,"channel":"room:1","event":"update"}')).toEqual({
      id: 5n,
      channel: "room:1",
      event: "update",
    });
  });

  it("accepts a string id, since large bigints serialize as strings", () => {
    expect(parseNotification('{"id":"9007199254740993","channel":"a","event":"m"}')?.id).toBe(
      9007199254740993n,
    );
  });

  it("defaults a missing event name", () => {
    expect(parseNotification('{"id":1,"channel":"a"}')?.event).toBe("message");
  });

  // A malformed notification must not tear down a subscriber loop serving many clients.
  it("returns null rather than throwing on bad input", () => {
    expect(parseNotification(undefined)).toBeNull();
    expect(parseNotification("not json")).toBeNull();
    expect(parseNotification("{}")).toBeNull();
    expect(parseNotification('{"id":1}')).toBeNull();
    expect(parseNotification('{"id":1,"channel":"has space"}')).toBeNull();
  });
});
