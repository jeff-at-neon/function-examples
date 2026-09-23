import { describe, expect, it, vi } from "vitest";
import { createGatewayChat, gatewayConfigFromEnv } from "../src/gateway.js";

const okBody = {
  model: "gpt-5-mini-2025-08-07",
  choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
};

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("createGatewayChat — temperature retry", () => {
  it("retries once without temperature when the model rejects it", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(body);
      if ("temperature" in body) {
        return jsonResponse(400, {
          error_code: "BAD_REQUEST",
          message: "'temperature' does not support 0.0 with this model. Only the default (1) value is supported.",
        });
      }
      return jsonResponse(200, okBody);
    }) as unknown as typeof fetch;

    const provider = createGatewayChat({ baseUrl: "https://gw", apiKey: "k", fetchImpl }, { model: "gpt-5-mini" });
    const result = await provider.chat([{ role: "user", content: "hi" }], { temperature: 0 });

    expect(result.text).toBe("{\"ok\":true}");
    expect(calls).toHaveLength(2);
    expect("temperature" in calls[0]!).toBe(true); // first attempt sent it
    expect("temperature" in calls[1]!).toBe(false); // retry dropped it
  });

  it("does not retry on a 400 unrelated to temperature", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, { error: { message: "unknown model \"x\"" } }),
    ) as unknown as typeof fetch;
    const provider = createGatewayChat({ baseUrl: "https://gw", apiKey: "k", fetchImpl }, { model: "x" });
    await expect(provider.chat([{ role: "user", content: "hi" }], { temperature: 0 })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("gatewayConfigFromEnv — accepts Neon's injected names", () => {
  it("reads NEON_AI_GATEWAY_BASE_URL / NEON_AI_GATEWAY_TOKEN", () => {
    const cfg = gatewayConfigFromEnv({
      NEON_AI_GATEWAY_BASE_URL: "https://gw/",
      NEON_AI_GATEWAY_TOKEN: "tok",
    } as NodeJS.ProcessEnv);
    expect(cfg).toEqual({ baseUrl: "https://gw", apiKey: "tok" });
  });
});
