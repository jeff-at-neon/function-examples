import { describe, expect, it } from "vitest";
import {
  initializeResult,
  MCP_PROTOCOL_VERSION,
  parseRpcRequest,
  RPC,
  RpcError,
  rpcErrorResponse,
  rpcResult,
  toolCallResult,
  toolsListResult,
} from "../src/rpc.js";
import { parseGetArgs, parseSearchArgs, TOOLS } from "../src/tools.js";

describe("parseRpcRequest", () => {
  it("parses a well-formed request", () => {
    const req = parseRpcRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(req).toEqual({ id: 1, method: "tools/list", params: {}, isNotification: false });
  });

  it("treats a missing id as a notification", () => {
    const req = parseRpcRequest({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(req.isNotification).toBe(true);
    expect(req.id).toBe(null);
  });

  it("rejects a wrong jsonrpc version", () => {
    expect(() => parseRpcRequest({ jsonrpc: "1.0", method: "x" })).toThrow(RpcError);
  });

  it("rejects a missing method", () => {
    expect(() => parseRpcRequest({ jsonrpc: "2.0", id: 1 })).toThrow(RpcError);
  });

  it("rejects a batch (array) request", () => {
    expect(() => parseRpcRequest([{ jsonrpc: "2.0", method: "x" }])).toThrow(RpcError);
  });

  it("rejects non-object params", () => {
    try {
      parseRpcRequest({ jsonrpc: "2.0", id: 1, method: "x", params: [] });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).toBe(RPC.INVALID_PARAMS);
    }
  });
});

describe("response shapes", () => {
  it("builds a result envelope", () => {
    expect(rpcResult(1, { ok: true })).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  });

  it("builds an error envelope", () => {
    expect(rpcErrorResponse(1, RPC.METHOD_NOT_FOUND, "nope")).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "nope" },
    });
  });

  it("advertises the protocol version and tools capability on initialize", () => {
    const result = initializeResult("neon-mcp") as {
      protocolVersion: string;
      capabilities: Record<string, unknown>;
      serverInfo: { name: string };
    };
    expect(result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(result.capabilities).toHaveProperty("tools");
    expect(result.serverInfo.name).toBe("neon-mcp");
  });

  it("lists tools without leaking their handlers", () => {
    const listed = toolsListResult(TOOLS) as { tools: Record<string, unknown>[] };
    expect(listed.tools.map((t) => t["name"])).toEqual(["search_products", "get_product"]);
    for (const t of listed.tools) expect(t).not.toHaveProperty("run");
  });

  it("wraps tool output as MCP content, with an error flag when asked", () => {
    expect(toolCallResult({ a: 1 })).toEqual({ content: [{ type: "text", text: '{"a":1}' }] });
    expect(toolCallResult("boom", true)).toEqual({ content: [{ type: "text", text: "boom" }], isError: true });
  });
});

describe("tool argument validation", () => {
  it("defaults and clamps search args", () => {
    expect(parseSearchArgs({})).toEqual({ query: "", limit: 10 });
    expect(parseSearchArgs({ query: "chair", limit: 999 })).toEqual({ query: "chair", limit: 50 });
  });

  it("rejects a bad search limit", () => {
    expect(() => parseSearchArgs({ limit: 0 })).toThrow(RpcError);
  });

  it("requires a sku for get_product", () => {
    expect(parseGetArgs({ sku: "SKU-001" })).toEqual({ sku: "SKU-001" });
    expect(() => parseGetArgs({})).toThrow(RpcError);
  });
});
