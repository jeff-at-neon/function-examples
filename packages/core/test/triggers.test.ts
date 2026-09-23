import { describe, expect, it } from "vitest";
import {
  parseTriggerEvent,
  parseTriggerRequest,
  TriggerPayloadError,
} from "../src/triggers.js";

describe("parseTriggerEvent — schedule (tick) deliveries carry no type", () => {
  // The regression: a scheduled invocation POSTs with no `type` discriminator (the platform just
  // runs the route on its cron). The parser used to throw `Unsupported trigger type undefined`.
  it("treats an empty object as a schedule", () => {
    const event = parseTriggerEvent({});
    expect(event.type).toBe("schedule");
    expect(typeof (event as { scheduledAt: string }).scheduledAt).toBe("string");
  });

  it("treats a missing/undefined type as a schedule", () => {
    expect(parseTriggerEvent({ data: {} }).type).toBe("schedule");
    expect(parseTriggerEvent({ type: undefined }).type).toBe("schedule");
    expect(parseTriggerEvent({ type: null }).type).toBe("schedule");
  });

  it("treats a non-object body as a schedule tick", () => {
    expect(parseTriggerEvent(undefined).type).toBe("schedule");
    expect(parseTriggerEvent(null).type).toBe("schedule");
  });

  it("uses data.scheduled_at when the platform provides it", () => {
    const event = parseTriggerEvent({ type: "schedule", data: { scheduled_at: "2026-01-01T00:00:00Z" } });
    expect(event).toMatchObject({ type: "schedule", scheduledAt: "2026-01-01T00:00:00Z" });
  });

  it("still rejects a present-but-unrecognized type", () => {
    expect(() => parseTriggerEvent({ type: "webhook" })).toThrow(TriggerPayloadError);
    expect(() => parseTriggerEvent({ type: "webhook" })).toThrow(/Unsupported trigger type/);
  });
});

describe("parseTriggerEvent — storage_object_created", () => {
  it("extracts bucket_name and object_key", () => {
    const event = parseTriggerEvent({
      type: "storage_object_created",
      data: { bucket_name: "uploads", object_key: "a/b.pdf" },
    });
    expect(event).toMatchObject({
      type: "storage_object_created",
      bucketName: "uploads",
      objectKey: "a/b.pdf",
    });
  });

  it("rejects a storage event missing its fields", () => {
    expect(() => parseTriggerEvent({ type: "storage_object_created", data: {} })).toThrow(
      TriggerPayloadError,
    );
  });

  it("rejects a traversal object_key", () => {
    expect(() =>
      parseTriggerEvent({
        type: "storage_object_created",
        data: { bucket_name: "uploads", object_key: "../secret" },
      }),
    ).toThrow(TriggerPayloadError);
  });
});

describe("parseTriggerRequest — reads the body tolerantly", () => {
  const req = (body: string | null, headers?: Record<string, string>) =>
    new Request("https://fn.example/work", {
      method: "POST",
      headers,
      ...(body === null ? {} : { body }),
    });

  it("treats an empty body as a schedule (Request.json() would have thrown)", async () => {
    const event = await parseTriggerRequest(req(null));
    expect(event.type).toBe("schedule");
  });

  it("treats whitespace-only body as a schedule", async () => {
    const event = await parseTriggerRequest(req("   "));
    expect(event.type).toBe("schedule");
  });

  it("parses a storage delivery body", async () => {
    const event = await parseTriggerRequest(
      req(JSON.stringify({ type: "storage_object_created", data: { bucket_name: "b", object_key: "k" } })),
    );
    expect(event).toMatchObject({ type: "storage_object_created", bucketName: "b", objectKey: "k" });
  });

  it("rejects a non-empty body that is not valid JSON", async () => {
    await expect(parseTriggerRequest(req("not json"))).rejects.toThrow(TriggerPayloadError);
  });
});
