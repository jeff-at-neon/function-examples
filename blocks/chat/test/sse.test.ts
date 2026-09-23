import { describe, expect, it } from "vitest";
import { encodeSse, sseComment } from "../src/sse.js";

describe("encodeSse", () => {
  it("encodes a named event with a JSON payload", () => {
    expect(encodeSse({ event: "delta", data: { text: "hi" } })).toBe(
      'event: delta\ndata: {"text":"hi"}\n\n',
    );
  });

  it("omits the event line for a default message", () => {
    expect(encodeSse({ data: "hello" })).toBe("data: hello\n\n");
  });

  it("splits a multi-line string payload across data lines", () => {
    expect(encodeSse({ data: "a\nb" })).toBe("data: a\ndata: b\n\n");
  });

  it("always terminates a frame with a blank line", () => {
    expect(encodeSse({ event: "done", data: {} }).endsWith("\n\n")).toBe(true);
  });
});

describe("sseComment", () => {
  it("formats a heartbeat comment the client ignores", () => {
    expect(sseComment()).toBe(": ping\n\n");
    expect(sseComment("keepalive")).toBe(": keepalive\n\n");
  });
});
