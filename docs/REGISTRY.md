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
    { "name": "NEON_BLOCKS_TRIGGER_SECRET", "description": "Shared secret appended to trigger paths as ?secret=. …" },
    { "name": "QUEUE_BATCH_SIZE", "description": "Jobs claimed per invocation. …" }
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
- **`environment`** — user-configurable variables only, as `{name, description}`. Neon-injected
  variables (`DATABASE_URL`, `NEON_STORAGE_*`, `NEON_AI_GATEWAY_*`) are omitted.
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

## Known limitation (install forms)

The supplied `template.schema.json` `environment` is `{name, description}` only — it intentionally
drops `required` / `default` / `injected` / `secret`. That is enough to render **docs** and a bare
variable list, but **not a full install form**, and the CLI cannot know which vars to prompt for
versus inject. The richer per-variable config still lives in `build-release.mjs`'s `catalog.json`.
Wiring a real install form (GUI) or prompt/inject flow (CLI) will need either an extension to the
template schema or a sidecar carrying that metadata. Tracked as the next decision for the
CLI-deploy and GUI passes.
