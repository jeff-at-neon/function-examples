/**
 * The Postgres-backed tools this MCP server exposes.
 *
 * Each tool is a descriptor (name, description, JSON Schema for its arguments) plus a handler that
 * queries Postgres. The example tools read the block's own demo `products` table; to expose real
 * data, point the handler queries at your own tables and update the descriptions. Argument
 * validation is pure and exported so it can be unit-tested without a database.
 */

import { RpcError, RPC, type ToolDescriptor } from "./rpc.js";

interface Queryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

export interface McpTool extends ToolDescriptor {
  run(args: Record<string, unknown>, db: Queryable): Promise<unknown>;
}

/** Validate and clamp search_products arguments. Exported for unit tests. */
export function parseSearchArgs(args: Record<string, unknown>): { query: string; limit: number } {
  const query = typeof args["query"] === "string" ? args["query"].trim() : "";
  const rawLimit = args["limit"];
  let limit = 10;
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit < 1) {
      throw new RpcError(RPC.INVALID_PARAMS, "limit must be a positive integer");
    }
    limit = Math.min(rawLimit, 50);
  }
  return { query, limit };
}

/** Validate get_product arguments. Exported for unit tests. */
export function parseGetArgs(args: Record<string, unknown>): { sku: string } {
  if (typeof args["sku"] !== "string" || args["sku"].trim() === "") {
    throw new RpcError(RPC.INVALID_PARAMS, "sku is required and must be a non-empty string");
  }
  return { sku: args["sku"].trim() };
}

export const TOOLS: McpTool[] = [
  {
    name: "search_products",
    description: "Search the product catalog by name, SKU, or description. Returns matching products.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to match against name, SKU, or description. Empty lists all." },
        limit: { type: "integer", description: "Max results, 1-50. Defaults to 10.", minimum: 1, maximum: 50 },
      },
    },
    async run(args, db) {
      const { query, limit } = parseSearchArgs(args);
      const pattern = `%${query}%`;
      const { rows } = await db.query(
        `SELECT sku, name, description, price_cents
         FROM blocks_mcp.products
         WHERE ($1 = '' OR name ILIKE $2 OR sku ILIKE $2 OR description ILIKE $2)
         ORDER BY name
         LIMIT $3`,
        [query, pattern, limit],
      );
      return { count: rows.length, products: rows };
    },
  },
  {
    name: "get_product",
    description: "Fetch a single product by its SKU.",
    inputSchema: {
      type: "object",
      properties: { sku: { type: "string", description: "The product SKU, e.g. SKU-001." } },
      required: ["sku"],
    },
    async run(args, db) {
      const { sku } = parseGetArgs(args);
      const { rows } = await db.query(
        `SELECT sku, name, description, price_cents FROM blocks_mcp.products WHERE sku = $1`,
        [sku],
      );
      if (!rows[0]) throw new RpcError(RPC.INVALID_PARAMS, `No product with SKU "${sku}"`);
      return rows[0];
    },
  },
];

export function findTool(name: string): McpTool | undefined {
  return TOOLS.find((t) => t.name === name);
}
