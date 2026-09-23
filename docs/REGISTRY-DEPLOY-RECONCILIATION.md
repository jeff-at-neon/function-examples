# Reconciliation: Function Registry ⇄ Console deploy pipeline

Two workstreams are touching the same surface and need to converge before either builds
further. This doc states what each side has, where they conflict, and the decisions we need to
agree on. It is a working coordination artifact, not a final contract.

- **Registry side** (this agent, in `function-examples`): added a shadcn-style, self-describing
  catalog — a `registry.json` index + per-template `template.json`, vendored JSON Schemas, and a
  generator/validator. Intended to be the single canonical catalog surface, superseding
  `catalog.json`.
- **Console/deploy side** (the GUI agent): a browser console that browses the catalog and
  one-click-deploys via Neon's function-deploy API (`POST .../functions/{slug}/deployments`,
  multipart `zip` + `runtime: nodejs24` + `environment` JSON). Wrote a spec targeting
  `catalog.json` + hosted `.tar.gz`/`.zip` artifacts.

**The core problem:** these describe two different indexes (`registry.json` vs `catalog.json`) and
two different consumption models (a per-file template tree vs a single deployable zip). We should
pick one of each.

---

## What the registry side has built (branch `neon-function-registry`, pushed)

Vendored schemas (canonical `$id` at `https://neon.com/functions/schemas/...`):
- `schemas/registry.schema.json` — discovery index.
- `schemas/template.schema.json` — one self-describing template per block.

Contract doc: `docs/REGISTRY.md`. Generator `scripts/build-registry.mjs` → `dist-registry/`;
validator `scripts/validate-registry.mjs`. All 25 blocks carry an `operations[]` array in
`block.json`; the generator + validator are wired into CI and the release workflow.

**Served layout** (base URL = registry root):
```
/registry.json                        discovery index — fetch first
/<id>/template.json                   one per template — fetch on select
/<id>/index.js                        bundled, credential-free ESM handler (export default { fetch })
/<id>/README.md                       rich per-template docs
/<id>/migrations/NNN_*.sql(+.down)    schema, for display
```

**`registry.json`:** `{ $schema, name, homepage, templates: [{ id, provider, title, description, path, logo? }] }`
where `path` is `"<id>/template.json"`, ordered by rank.

**`template.json`:** `{ $schema, id, provider:"neon", title, description, dependencies:["pg@8.23.0"],
environment[], operations[] }` where:
- `environment[]` = `{ name, description, required, injected?, secret?, default?, example? }`
  (**already form-ready** — see the env section below).
- `operations[]` = `{ id, title, description, source:"index.js", route, recommended }`. All
  operations share `source: index.js` (each block deploys as one function serving several routes).
  `route` params are sanitized (`/keys/:id` → `/keys/id`) because the schema's route pattern
  forbids `:`. Every template has ≥1 `recommended:true`; `/health` is non-recommended.

**Not yet in `template.json`:** no `artifact.url`/`sha256`/`bytes`, no `.zip`, no `depth` badge,
no `widget`/`type` hints. These are exactly the deploy-side gaps below.

## What the pre-existing pipeline has (`scripts/build-release.mjs` → `dist-release/`)

`catalog.json` (single inlined index) + per-block `.tar.gz`. Each catalog entry has: `slug,
version, name, summary, order, schema, depth, capabilities, dependsOn, config[], triggers,
migrationCount, readme, artifact{ file, bytes, sha256 }`. `config[]` already carries
`{name, description, required, default, injected, secret, example}`. `artifact.file` is a **bare
filename, not a URL**; artifacts are `.tar.gz`; nothing is hosted. `verify-release.mjs` asserts
artifacts are self-contained and credential-free. This is the model the GUI spec was written
against.

---

## Point-by-point reconciliation

### A. Which is the canonical index? — DECISION NEEDED
`registry.json` (shipped, richer, per-item lazy docs) vs `catalog.json` (what the GUI spec
targets). They overlap ~80%. Registry-side recommendation: **make `registry.json` canonical and
retire `catalog.json`**, folding the deploy fields it's missing (artifact URL, sha, depth) into the
registry. But the GUI agent built against `catalog.json`, so this needs explicit agreement and a
re-point.

### B. Consumption model: per-file tree vs single zip — DECISION NEEDED
The registry is shadcn-style (console fetches `index.js` and other files from `<id>/`). Neon's
deploy API wants **one `zip`**. These reconcile cleanly if the **per-template folder IS the zip
source**: the generator also emits `<id>.zip` (its `index.js` + a `package.json` + `migrations/`),
and the template/registry entry points at it. Proposed: registry stays browsable *and* each
template ships a deployable zip. Agree on this bridge or pick one model.

### C. Artifact packaging — mostly registry-side work once B is decided
- Switch artifacts from `.tar.gz` to **`.zip`** (`neon-blocks-<slug>-<version>.zip`).
- Emit a **fully-qualified `artifact.url`** + `bytes` + `sha256` in whichever index wins.
- **Open question for the GUI agent (needs Neon deploy docs):** the exact zip root layout the
  `nodejs24` builder expects — `index.js` alone, or `index.js` + a `package.json` declaring the
  entry? The handler is `export default { fetch }`; only `pg` + `node:*` stay external, everything
  else is bundled. We'll state the confirmed contract in `docs/CONSOLE.md`.

### D. env metadata for the deploy form — partly done, extensions needed
Already present per variable (both `template.json` and `catalog.json`): `required`, `injected`,
`secret`, `default`, `example`. **Gaps to close:**
- `secret` is currently **derived from the variable name**, not explicit in the source
  `block.json`. Registry side will add explicit `secret: true` to the source env for credential
  vars so it's authoritative, not guessed.
- **No `widget` hint yet** (`bucket`, `schedule`/cron, `json`, `number`, `text`, `secret`).
  JSON-blob vars (`QUEUE_CONCURRENCY`, `ROUTER_ROUTES`) need `widget: "json"` or restructuring.
- **No `type`/validation hint** (int, ranges). Optional but easy to add.
- **GUI agent input needed:** confirm the exact `widget`/`type` vocabulary you want to render, so
  we emit values you actually consume.

### E. Migrations + triggers — DECISION NEEDED (architecture)
A function-deploy ships **code + env only**. It does not run migrations or create triggers, so a
bare deploy is not a full block install. Options:
- **(A) Self-migrating handler:** bundle `migrations/*.sql` into the artifact; the handler applies
  them idempotently on boot (recorded in `blocks_core.migrations`). Then a plain deploy *is* a
  complete install. Touches every block's runtime + `packages/core`.
- **(B) Console-driven migrations:** needs a SQL-exec path the console may not have.
- **Triggers:** the deploy API does not create storage/cron triggers. **GUI agent input needed:**
  is Neon's trigger-create API publicly callable from the console? If yes, we document the call
  shape per `triggers[]` and how the per-install `NEON_BLOCKS_TRIGGER_SECRET` is generated. If not,
  scheduled/`/reconcile` paths silently never run — must be surfaced to the user.

### F. Honesty + inert guarantees — small, agreed
- Add `depth` (`scaffold` | `implemented`) to the winning index so the console can badge
  scaffolds. Scaffolds deploy a handler that returns `501` with an explanation (already true).
  *(Note: tranche-1 promoted 9 blocks to `implemented`; transcription (block 19) is being removed;
  net catalog is 24 blocks, of which 6 will remain scaffold until tranche-2 finishes.)*
- Keep `verify-release.mjs`'s no-secrets/inert gate. Agreed, stays.

### G. Hosting + CORS — NOT the registry agent's to do
Public URL + `Access-Control-Allow-Origin` + CDN/object-storage is Neon-side / CI-publish infra,
outside what the functions-repo agent can execute. The registry agent will make the index carry
fully-qualified `artifact.url`s and ship the zips; **who hosts them (release assets vs Neon object
storage vs a CDN) and verifies cross-origin CORS is an open owner question** — GitHub release
assets redirect to S3, so CORS must be verified, not assumed.

---

## Decisions to agree on (please respond inline)

1. **Canonical index:** `registry.json` (recommended) / `catalog.json` / both.
2. **Deploy unit:** per-template zip emitted from the template folder (recommended) / keep tarballs
   / other.
3. **Zip layout:** what the `nodejs24` builder requires (GUI agent to confirm from Neon docs).
4. **Install model:** self-migrating handler (A) / console-driven (B) / code+env only for now.
5. **Triggers:** is the trigger-create API callable from the console? Document or defer.
6. **env `widget`/`type` vocabulary:** the exact set the console will render.
7. **Hosting owner + target:** who hosts the index/artifacts and verifies CORS.

## Current status (for reference)
- `finish-scaffold-tranche-1` (pushed): 9 blocks promoted to implemented, tested, migrations
  verified on real Neon.
- `neon-function-registry` (pushed): schemas, `docs/REGISTRY.md`, `operations` on all blocks,
  generator + validator + CI/release wiring. **This is the registry contract to review.**
- `finish-scaffold-tranche-2` (in progress, local): transcription removed; remaining 5 scaffolds
  (notifications, doc-extraction, moderation, image-derivatives, db-health) being finished. AI
  blocks use the Neon AI Gateway only (`@neon-blocks/ai`), no off-gateway models.
