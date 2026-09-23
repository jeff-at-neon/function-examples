# Block 29 — MCP server

Expose Postgres-backed tools to an AI agent over MCP

**Block 29 of the catalog.**

> **Status: scaffold.** The JSON-RPC/MCP protocol handling, the tool-call audit log, and two example
> tools over a demo catalog are wired for real, with pure, unit-tested protocol and argument logic.
> Exposing your own data and production auth are marked seams. Unverified against a live Neon project.

## Why this block

Agents reach tools through MCP, and the tools most worth giving them read your own database:
`search_products`, `get_customer`, `get_recent_orders`. Hosting that server on a Neon Function puts
it in the same region as the data, gives it a public URL that branches with your project, and needs
no separate always-on service. It is a differentiated, current example of what Functions are for.

## Install

```bash
neon-blocks migrate mcp
neon function deploy mcp --src blocks/mcp/src
```

Set `MCP_API_KEY` to protect the endpoint. `DATABASE_URL` is injected automatically on a deployed
branch. Point an MCP client at `POST <function-url>/mcp`.

## Protocol

The `/mcp` endpoint speaks JSON-RPC 2.0 over HTTP and implements the MCP methods a client needs:

| Method | Result |
|---|---|
| `initialize` | Protocol version, capabilities (`tools`), and server info. |
| `tools/list` | The tool descriptors: name, description, JSON Schema for arguments. |
| `tools/call` | Runs a tool and returns its output as MCP content. |
| `ping` | Liveness. |

A request without an `id` (a notification, e.g. `notifications/initialized`) gets a `202` and no
body, per JSON-RPC.

## Tools (examples)

| Tool | Arguments | Reads |
|---|---|---|
| `search_products` | `query?`, `limit?` (1-50) | `blocks_mcp.products` by name, SKU, or description |
| `get_product` | `sku` | one product by SKU |

Both read the block's own demo catalog, seeded by the migration so calls return results immediately.

## Design notes

- **Authenticate the endpoint.** A Function has a public URL. With `MCP_API_KEY` set, every request
  needs a bearer token (constant-time compared). Unset means open, which is fine for a demo and
  unsafe for real data.
- **Audit every call.** Each `tools/call` is logged to `blocks_mcp.tool_calls` with arguments,
  outcome, and duration. That is both the audit trail and the health signal (error rate).
- **Argument validation is the boundary.** Tool arguments are validated before any query, so a
  malformed call is a clean protocol error, not a Postgres exception.
- **Tool errors reach the model.** A failed tool returns `isError` content rather than a transport
  error, so the agent can see what went wrong and adapt.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `MCP_SERVER_NAME` | `neon-mcp` | Name reported in the initialize handshake. |
| `MCP_API_KEY` | `` | Shared secret. When set, every request must send a matching bearer token. |

Injected automatically by Neon: `DATABASE_URL`.

## Limits and honest caveats

- **Demo data.** The tools read the block's seeded `products` table. To expose real data, point the
  tool queries in `src/tools.ts` at your tables and update the descriptions.
- **Shared-secret auth only.** Production MCP auth (OAuth) is a seam; the shared-key path works today.
- **Single request per POST.** JSON-RPC batching is intentionally not supported.
- **Unverified against a live Neon project.** Nothing in this repo has been run against real Neon
  infrastructure yet, including against a real MCP client.

## Observability

```sql
SELECT * FROM blocks_mcp.v_status;
```

## Uninstall

```bash
neon-blocks rollback mcp
```
