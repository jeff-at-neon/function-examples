# Neon Function Registry

A shadcn-style, self-describing catalog for the function blocks. Two consumers:

- a **CLI** that installs a block from a registry entry, and
- a **GUI** (the Neon console) that reads the registry to render a browsable catalog.

The format supersedes the single inlined `catalog.json` from `scripts/build-release.mjs` as the
catalog **index** (the deploy tarballs `build-release.mjs` produces stay). It is defined by two JSON
Schemas, vendored in this repo and the single source of truth:

- [`schemas/registry.schema.json`](../schemas/registry.schema.json) — the discovery index.
- [`schemas/template.schema.json`](../schemas/template.schema.json) — one self-describing template per block.

Their canonical `$id`s are `https://neon.com/functions/schemas/registry.schema.json` and
`.../template.schema.json`.

## Served layout

The generator emits a servable tree (base URL = registry root):

```
/registry.json                        discovery index — fetch first
/<id>/template.json                   one per template — fetch on select
/<id>/index.js                        bundled, credential-free ESM handler (the operations' `source`)
/<id>/README.md                       rich per-template docs
/<id>/migrations/NNN_*.sql(+.down)    schema, for display
```

## `registry.json` — the index

```json
{
  "$schema": "https://neon.com/functions/schemas/registry.schema.json",
  "name": "neon-functions",
  "homepage": "https://neon.com/docs/functions",
  "templates": [
    {
      "id": "queue",
      "provider": "neon",
      "title": "Outbox + Durable Job Queue",
      "description": "Postgres-backed job queue and event outbox: retries, backoff, DLQ, idempotency, concurrency caps.",
      "path": "queue/template.json"
    }
  ]
}
```

- `templates` is ordered by build rank (foundations first).
- `path` is relative to the index and points at the template's `template.json`.
- `logo` (optional) is an absolute `https://` URL — display metadata only, never fetched by the CLI.

## `template.json` — the detail view

```json
{
  "$schema": "https://neon.com/functions/schemas/template.schema.json",
  "id": "queue",
  "provider": "neon",
  "title": "Outbox + Durable Job Queue",
  "description": "Postgres-backed job queue and event outbox: retries, backoff, DLQ, idempotency, concurrency caps.",
  "dependencies": ["pg@8.23.0"],
  "environment": [
    { "name": "DATABASE_URL", "description": "Branch connection string.", "required": true, "injected": true, "secret": true },
    { "name": "NEON_BLOCKS_TRIGGER_SECRET", "description": "Shared secret appended to trigger paths as ?secret=. …", "required": false, "secret": true, "example": "a-long-random-string" },
    { "name": "QUEUE_BATCH_SIZE", "description": "Jobs claimed per invocation. …", "required": false, "default": "25" }
  ],
  "operations": [
    { "id": "work",    "title": "POST /work",    "description": "cron, every minute — drain the outbox, then run due jobs", "source": "index.js", "route": "/work",   "recommended": true },
    { "id": "sweep",   "title": "POST /sweep",   "description": "cron, daily — reclaim leases, purge, report DLQ depth",     "source": "index.js", "route": "/sweep",  "recommended": true },
    { "id": "enqueue", "title": "POST /enqueue", "description": "HTTP — enqueue a job from application code",                 "source": "index.js", "route": "/enqueue","recommended": true },
    { "id": "health",  "title": "GET /health",   "description": "Liveness and readiness, backed by the block's v_status view.", "source": "index.js", "route": "/health", "recommended": false }
  ]
}
```

### Field semantics

- **`dependencies`** — external runtime deps the deployed function needs, pinned to an exact
  version (no ranges). The `@neon-blocks/*` workspace packages are bundled into `index.js` and are
  **not** listed; today the only external dep is `pg`.
- **`environment`** — every variable the function reads, carrying everything a deploy form needs:
  - `name`, `description` (always present).
  - `required` (always present) — whether the form must collect a value.
  - `injected` — supplied automatically by Neon (`DATABASE_URL`, `NEON_STORAGE_*`,
    `NEON_AI_GATEWAY_*`). The form must **not** prompt for these; show them as provided. Injected
    variables are never `required` of the user.
  - `secret` — render as a secret input; never echo the value.
  - `default` — prefill for an optional variable. `example` — placeholder only, not a default.

  A deploy form therefore prompts for `{ !injected }` variables, marks the `required` ones, uses
  `secret` inputs where set, and prefills `default`.
- **`operations`** — the block's routes as selectable units. All operations share one `source`
  (`index.js`, the bundled handler); they differ by `route`. Every template has **at least one**
  `recommended: true` operation; `/health` is the only consistently non-recommended one. A UI
  should default-check the recommended set.
- **Route params** like `/keys/:id` are sanitized to `/keys/id` in `template.json` (the schema's
  `route` pattern forbids `:`). The true colon route lives in the block source, not the template.

## Operations model

Each block deploys as **one** Neon Function serving several routes/trigger-paths (see
`scripts/deploy.mjs`). So operations map to that function's routes rather than to independently
deployable modules — which is why they share a single `source`.

## Generating and validating

```bash
node scripts/build-registry.mjs      # emits dist-registry/ (gitignored build output)
node scripts/validate-registry.mjs   # validates registry.json + every template.json vs the schemas
```

`dist-registry/` is a build artifact (like `dist-release/`); CI regenerates and validates it, and
the release pipeline publishes it. Because it is generated from each block's `block.json`, it never
drifts from source.

## Deploy form

`template.json` carries enough for a full deploy form. The GUI should:

1. Fetch `template.json`, read `environment`.
2. Show non-`injected` variables as form fields; mark `required` ones; use a secret input where
   `secret` is true; prefill `default` and use `example` as the placeholder.
3. Show `injected` variables (e.g. `DATABASE_URL`) as "provided by Neon" — never a prompt.
4. Let the user select which `operations` to enable (default-check `recommended`), and surface
   `dependencies` and the migrations under `<id>/migrations/` as what the install will run.
