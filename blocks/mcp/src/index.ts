/**
 * Block 29 — MCP Server on Postgres.
 *
 * A Model Context Protocol server over HTTP (JSON-RPC 2.0) that exposes Postgres-backed tools to an
 * AI agent. It runs on a Neon Function next to the database, so a tool call is a local query, and it
 * branches with your data like every other block. Every tool call is logged for audit.
 *
 * Routes:
 *   POST   /mcp        The MCP endpoint: initialize, tools/list, tools/call, ping.
 *   GET    /health     200 / 503, backed by the block's v_status view.
 *
 * STATUS: scaffold. The JSON-RPC/MCP protocol handling, the tool-call log, and two example tools
 * over the demo catalog are wired for real. Exposing your own data is a marked seam: point the tool
 * queries at your tables. Auth is an optional shared secret; production OAuth is a seam.
 */

import {
  checkHealth,
  constantTimeEquals,
  createLogger,
  getPool,
  json,
  loadConfig,
  problem,
  Router,
  type Logger,
} from "@neon-blocks/core";
import {
  initializeResult,
  parseRpcRequest,
  RpcError,
  RPC,
  rpcErrorResponse,
  rpcResult,
  toolCallResult,
  toolsListResult,
  type JsonRpcId,
} from "./rpc.js";
import { findTool, TOOLS } from "./tools.js";

const log: Logger = createLogger({ block: "mcp" });

const SPEC = {
  block: "mcp",
  required: ["DATABASE_URL"],
  optional: { MCP_SERVER_NAME: "neon-mcp", MCP_API_KEY: "" },
} as const;

const router = new Router();

router.post("/mcp", async (request) => {
  const cfg = loadConfig(SPEC);

  // A public URL with no backend in front, so authenticate when a key is configured. Unset means
  // open, which the README calls out as unsafe for real data.
  const apiKey = cfg.get("MCP_API_KEY");
  if (apiKey !== "" && !bearerMatches(request.headers.get("authorization"), apiKey)) {
    return problem(401, "unauthorized", "Provide 'Authorization: Bearer <MCP_API_KEY>'.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(rpcErrorResponse(null, RPC.PARSE_ERROR, "Request body is not valid JSON"), { status: 400 });
  }

  let req;
  try {
    req = parseRpcRequest(body);
  } catch (err) {
    const code = err instanceof RpcError ? err.code : RPC.INVALID_REQUEST;
    return json(rpcErrorResponse(null, code, err instanceof Error ? err.message : "Invalid request"));
  }

  const response = await dispatch(req.method, req.params, req.id, cfg.get("MCP_SERVER_NAME"));

  // A notification (no id) gets no response body per JSON-RPC.
  if (req.isNotification) return new Response(null, { status: 202 });
  return json(response);
});

router.get("/health", async () => {
  const report = await checkHealth(getPool(), {
    block: "mcp",
    schema: "blocks_mcp",
    evaluate: (status) => {
      const problems: string[] = [];
      const calls = Number(status["tool_calls_last_hour"] ?? 0);
      const errors = Number(status["errors_last_hour"] ?? 0);
      if (calls > 0 && errors / calls > 0.5) {
        problems.push(`${errors} of ${calls} tool calls in the last hour failed`);
      }
      return problems;
    },
  });
  return json(report, { status: report.status === "ok" ? 200 : 503 });
});

/** Route one JSON-RPC method to its result. Returns a full JSON-RPC response object. */
async function dispatch(
  method: string,
  params: Record<string, unknown>,
  id: JsonRpcId,
  serverName: string,
): Promise<Record<string, unknown>> {
  switch (method) {
    case "initialize":
      return rpcResult(id, initializeResult(serverName));
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, toolsListResult(TOOLS));
    case "tools/call":
      return callTool(params, id);
    default:
      return rpcErrorResponse(id, RPC.METHOD_NOT_FOUND, `Unknown method "${method}"`);
  }
}

async function callTool(params: Record<string, unknown>, id: JsonRpcId): Promise<Record<string, unknown>> {
  const name = typeof params["name"] === "string" ? params["name"] : "";
  const args =
    typeof params["arguments"] === "object" && params["arguments"] !== null && !Array.isArray(params["arguments"])
      ? (params["arguments"] as Record<string, unknown>)
      : {};

  const tool = findTool(name);
  if (!tool) return rpcErrorResponse(id, RPC.METHOD_NOT_FOUND, `Unknown tool "${name}"`);

  const pool = getPool();
  const started = Date.now();
  try {
    const result = await tool.run(args, pool);
    await logCall(pool, name, args, true, Date.now() - started, null);
    return rpcResult(id, toolCallResult(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logCall(pool, name, args, false, Date.now() - started, message);
    // A bad argument is a protocol error; anything else is surfaced to the model as a tool error
    // (isError content) so it can react rather than see a transport failure.
    if (err instanceof RpcError) return rpcErrorResponse(id, err.code, message);
    log.error("tool execution failed", { tool: name, err: message });
    return rpcResult(id, toolCallResult(`Tool failed: ${message}`, true));
  }
}

interface Pool {
  query(sql: string, params?: readonly unknown[]): Promise<unknown>;
}

async function logCall(
  pool: Pool,
  tool: string,
  args: Record<string, unknown>,
  ok: boolean,
  durationMs: number,
  error: string | null,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO blocks_mcp.tool_calls (tool, arguments, ok, duration_ms, error)
       VALUES ($1, $2::jsonb, $3, $4, $5)`,
      [tool, JSON.stringify(args), ok, durationMs, error],
    );
  } catch (err) {
    // Audit logging must never fail the tool call itself.
    log.warn("failed to write tool_call audit row", { err: err instanceof Error ? err.message : String(err) });
  }
}

function bearerMatches(header: string | null, expected: string): boolean {
  const match = header ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
  const token = match?.[1]?.trim();
  return token !== undefined && constantTimeEquals(token, expected);
}

export default {
  fetch: (request: Request): Promise<Response> => router.handle(request),
};

// Re-exported so unit tests can import the pure logic directly.
export {
  parseRpcRequest,
  rpcResult,
  rpcErrorResponse,
  toolsListResult,
  toolCallResult,
  initializeResult,
  RpcError,
  RPC,
} from "./rpc.js";
export { parseSearchArgs, parseGetArgs, findTool, TOOLS } from "./tools.js";
