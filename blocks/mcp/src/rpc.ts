/**
 * JSON-RPC 2.0 and MCP framing.
 *
 * Pure and dependency-free so the protocol handling (parsing a request, shaping a result or error,
 * building the initialize and tools/list payloads) is unit-testable without a database or a live
 * MCP client. The handler in index.ts wires these to the tool registry and Postgres.
 */

export const JSONRPC_VERSION = "2.0";

/** MCP protocol revision advertised in the initialize handshake. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Standard JSON-RPC error codes. */
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  id: JsonRpcId;
  method: string;
  params: Record<string, unknown>;
  /** A request without an id is a notification: it gets no response. */
  isNotification: boolean;
}

export class RpcError extends Error {
  override readonly name = "RpcError";
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Parse and validate a single JSON-RPC request object.
 *
 * Throws RpcError with the right code so the caller can return a well-formed error response rather
 * than a 500. Batch requests (arrays) are rejected: MCP over HTTP does not require them and they add
 * ordering complexity a template should not carry.
 */
export function parseRpcRequest(body: unknown): JsonRpcRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new RpcError(RPC.INVALID_REQUEST, "Request must be a single JSON-RPC object");
  }
  const o = body as Record<string, unknown>;

  if (o["jsonrpc"] !== JSONRPC_VERSION) {
    throw new RpcError(RPC.INVALID_REQUEST, `jsonrpc must be "${JSONRPC_VERSION}"`);
  }
  if (typeof o["method"] !== "string" || o["method"] === "") {
    throw new RpcError(RPC.INVALID_REQUEST, "method must be a non-empty string");
  }

  const rawId = o["id"];
  const hasId = rawId !== undefined;
  if (hasId && rawId !== null && typeof rawId !== "string" && typeof rawId !== "number") {
    throw new RpcError(RPC.INVALID_REQUEST, "id must be a string, number, or null");
  }

  const params = o["params"];
  if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
    throw new RpcError(RPC.INVALID_PARAMS, "params must be an object");
  }

  return {
    id: hasId ? (rawId as JsonRpcId) : null,
    method: o["method"],
    params: (params as Record<string, unknown>) ?? {},
    isNotification: !hasId,
  };
}

export function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function rpcErrorResponse(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: JSONRPC_VERSION, id, error: { code, message } };
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The `initialize` result: protocol version, declared capabilities, and server identity. */
export function initializeResult(serverName: string, version = "0.1.0"): Record<string, unknown> {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: serverName, version },
  };
}

/** The `tools/list` result: the tool descriptors, without their handlers. */
export function toolsListResult(tools: readonly ToolDescriptor[]): Record<string, unknown> {
  return {
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  };
}

/**
 * A `tools/call` result.
 *
 * MCP returns tool output as content parts; a tool error is reported with `isError: true` in a
 * normal result (not a JSON-RPC error), so the model can see and react to it.
 */
export function toolCallResult(payload: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
}
