# Block 27 — REST API

Create, read, update, and delete rows over HTTP

**Block 27 of the catalog.**

> **Status: implemented.** A complete, runnable CRUD API with pure, unit-tested validation. Auth and
> rate limiting are deliberately out of scope. Unverified against a live Neon project.

## Why this block

The canonical first example: an HTTP request lands on a Neon Function, which reads or writes
Postgres in the same region and returns JSON. It is the shape almost every backend starts from, and
seeing it end to end is the fastest way to understand where a Function sits relative to your data.

The block owns its `blocks_rest_api.todos` table, so installing it is self-contained and never
touches your existing tables. Swap the table and columns for your own resource to adapt it.

## Install

```bash
neon-blocks migrate rest-api
neon function deploy rest-api --src blocks/rest-api/src
```

No triggers, no secrets. `DATABASE_URL` is injected automatically on a deployed branch.

## Design notes

- **Validation before Postgres.** A malformed body or a non-UUID id is rejected as a `400` before a
  query runs, so a bad request never surfaces as an opaque `500` from a constraint violation.
- **Single-statement updates.** `PATCH` uses `COALESCE(new, existing)`, so an absent field keeps its
  value in one statement with no read-modify-write race.
- **Bounded lists.** `GET /todos` clamps `?limit` to `REST_API_PAGE_SIZE` rather than rejecting a
  larger value, so the response size is bounded regardless of input.
- **Auth belongs in front.** This block does no authentication on purpose. Put api-edge (#12) ahead
  of it for API keys and rate limits rather than reimplementing them per endpoint.

## API

| Route | Purpose |
|---|---|
| `GET /todos` | List todos, newest first. `?limit` and `?offset` for pagination. |
| `POST /todos` | Create a todo: `{ "title": "…", "done": false }`. Returns `201`. |
| `GET /todos/:id` | Fetch one todo. `404` if absent. |
| `PATCH /todos/:id` | Update `title` and/or `done`. At least one required. |
| `DELETE /todos/:id` | Delete a todo. Returns `204`, or `404` if absent. |
| `GET /health` | `200` / `503`, backed by `blocks_rest_api.v_status`. |

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `REST_API_PAGE_SIZE` | `50` | Default and maximum rows returned by `GET /todos`. |

Injected automatically by Neon: `DATABASE_URL`.

## Limits and honest caveats

- **No auth or rate limiting.** By design; compose api-edge (#12) in front.
- **Single resource.** It models one table (`todos`) as a teaching example. Adapt the schema,
  columns, and validation for your resource.
- **Unverified against a live Neon project.** Nothing in this repo has been run against real Neon
  infrastructure yet.

## Observability

```sql
SELECT * FROM blocks_rest_api.v_status;
```

## Uninstall

```bash
neon-blocks rollback rest-api
```
