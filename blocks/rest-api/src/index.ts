/**
 * Block 27 — REST API on Postgres.
 *
 * The canonical first example: HTTP request to a Neon Function to Postgres and back. A full CRUD
 * REST API over the block's own todos table, in the same region as the database so each query is a
 * local round trip. DATABASE_URL is injected automatically on a deployed branch.
 *
 * Routes:
 *   GET    /todos        List todos, newest first, paginated by ?limit and ?offset.
 *   POST   /todos        Create a todo.
 *   GET    /todos/:id    Fetch one todo.
 *   PATCH  /todos/:id    Update a todo's title and/or done flag.
 *   DELETE /todos/:id    Delete a todo.
 *   GET    /health       200 / 503, backed by the block's v_status view.
 *
 * STATUS: implemented. A complete, runnable CRUD API with input validation and consistent JSON
 * errors. Auth and rate limiting are intentionally out of scope: put api-edge (#12) in front for
 * that rather than reimplementing it here.
 */

import {
  checkHealth,
  createLogger,
  getPool,
  json,
  loadConfig,
  NotFoundError,
  problem,
  Router,
  ValidationError,
  type Logger,
} from "@neon-blocks/core";
import { parseCreate, parsePagination, parsePatch } from "./validate.js";

const log: Logger = createLogger({ block: "rest-api" });

const SPEC = {
  block: "rest-api",
  required: ["DATABASE_URL"],
  optional: { REST_API_PAGE_SIZE: "50" },
} as const;

function pageSize(): number {
  return loadConfig(SPEC).int("REST_API_PAGE_SIZE", { min: 1, max: 1000 });
}

const router = new Router();

router.get("/todos", async (_request, ctx) => {
  const { limit, offset } = parsePagination(ctx.url.searchParams, pageSize());
  const { rows } = await getPool().query(
    `SELECT id, title, done, created_at, updated_at
     FROM blocks_rest_api.todos
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return json({ todos: rows, limit, offset });
});

router.post("/todos", async (request) => {
  const input = parseCreate(await readJson(request));
  const { rows } = await getPool().query(
    `INSERT INTO blocks_rest_api.todos (title, done)
     VALUES ($1, $2)
     RETURNING id, title, done, created_at, updated_at`,
    [input.title, input.done],
  );
  return json({ todo: rows[0] }, { status: 201 });
});

router.get("/todos/:id", async (_request, ctx) => {
  const { rows } = await getPool().query(
    `SELECT id, title, done, created_at, updated_at
     FROM blocks_rest_api.todos WHERE id = $1`,
    [requireUuid(ctx.params["id"])],
  );
  if (!rows[0]) throw new NotFoundError("todo not found");
  return json({ todo: rows[0] });
});

router.add("PATCH", "/todos/:id", async (request, ctx) => {
  const id = requireUuid(ctx.params["id"]);
  const patch = parsePatch(await readJson(request));

  // COALESCE keeps this a single statement: an absent field falls through to the existing value,
  // so there is no read-modify-write race between fetching the row and updating it.
  const { rows } = await getPool().query(
    `UPDATE blocks_rest_api.todos
     SET title = COALESCE($2, title),
         done = COALESCE($3, done),
         updated_at = now()
     WHERE id = $1
     RETURNING id, title, done, created_at, updated_at`,
    [id, patch.title ?? null, patch.done ?? null],
  );
  if (!rows[0]) throw new NotFoundError("todo not found");
  return json({ todo: rows[0] });
});

router.add("DELETE", "/todos/:id", async (_request, ctx) => {
  const { rowCount } = await getPool().query(
    `DELETE FROM blocks_rest_api.todos WHERE id = $1`,
    [requireUuid(ctx.params["id"])],
  );
  if (rowCount === 0) throw new NotFoundError("todo not found");
  return new Response(null, { status: 204 });
});

router.get("/health", async () => {
  const report = await checkHealth(getPool(), { block: "rest-api", schema: "blocks_rest_api" });
  return json(report, { status: report.status === "ok" ? 200 : 503 });
});

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ValidationError("Request body is not valid JSON");
  }
}

/** Reject a malformed id before it reaches Postgres, so a bad path is a clean 400, not a 500. */
function requireUuid(value: string | undefined): string {
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new ValidationError("id must be a UUID");
  }
  return value;
}

export default {
  fetch: (request: Request): Promise<Response> => router.handle(request),
};

// Re-exported so unit tests can import the pure logic directly.
export { parseCreate, parsePatch, parsePagination } from "./validate.js";
