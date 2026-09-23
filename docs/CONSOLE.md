# Console catalog integration

How a hosted catalog deploys these blocks into a user's own org, project, and branch. The catalog
surface is the **function registry** — see [REGISTRY.md](REGISTRY.md) for the authoritative
`registry.json` / `template.json` schema and the deploy-artifact contract. This doc covers the
install model on top of it.

## The property everything rests on

**Artifacts are public and inert.** Each block's `<id>.zip` contains bundled code, migrations, and a
manifest — and no credentials of any kind. So it can be served unauthenticated from anywhere (today
GitHub Pages, CORS-open), and the console never holds a secret on the user's behalf.

That works because Neon injects what functions need: `DATABASE_URL`, Object Storage credentials, and
AI Gateway credentials arrive in the deployed function's environment automatically. The catalog
supplies code; the platform supplies identity.

Two consequences worth stating plainly:

- **No user credentials belong in this repo or in GitHub secrets.** The only secret CI needs is one
  `NEON_API_KEY` for a throwaway test branch.
- **`NEON_BLOCKS_TRIGGER_SECRET` is the exception and must be generated per install.** Neon does not
  sign trigger delivery, so this shared secret is the only thing distinguishing a real trigger from
  a forged POST. The console generates one per deployment and never reuses or stores it centrally.

`scripts/validate-registry.mjs` checks the registry against the schemas on every build; the inert
property holds by construction (env/secrets are never bundled — they are sent separately via the
deploy API's `environment` field).

## What a release contains

`node scripts/build-registry.mjs` produces `dist-registry/`:

```
registry.json                         the console's discovery index
<id>/template.json                    self-describing: env, operations, triggers, depth, dependsOn
<id>/index.mjs                        bundled, self-contained ESM (everything inlined, incl. pg)
<id>/migrations/*.sql                 up and down
<id>/README.md                        rendered as the block's docs page
<id>.zip                              deployable archive: index.mjs at ROOT + migrations/ + docs
```

All blocks total a few MB. The bundle inlines every dependency — `@neon-blocks/*` **and `pg`** —
because the `nodejs24` guest is bare Node with no `node_modules`; only `node:*` builtins stay
external. The handler is `export default { fetch }`, the shape the deploy API invokes. See
[REGISTRY.md](REGISTRY.md) → "Deploy artifact contract" for the exact zip/entry requirements.

## registry.json + template.json

`registry.json` is a small index (`{ id, title, description, dependsOn, path }` per template); each
`template.json` carries everything needed to render a browse page and an install form —
`environment` (with `required`/`injected`/`secret`/`default`/`example`), `operations`, `triggers`,
`depth`, and `dependsOn`. Full schema in [REGISTRY.md](REGISTRY.md).

The `injected` flag matters: prompting for `DATABASE_URL` would be asking for something Neon already
provides. The console prompts only for non-injected variables.

## Install sequence

```
1. resolve dependsOn, install those first          (queue before ingest-router)
2. fetch <id>.zip from the registry, collect env in the deploy dialog
3. generate a per-install NEON_BLOCKS_TRIGGER_SECRET
4. POST the zip + runtime:nodejs24 + environment JSON to the function deploy API
5. create declared triggers, appending ?secret=<generated> to each function_path
6. GET /health to confirm the deployment answers
```

**Migrations are not a separate step.** Every handler is self-migrating: on its first request it
applies its own migrations idempotently (checksummed, advisory-locked, recorded in
`blocks_core.migrations`), reading the SQL from `/opt/function/migrations`. So deploying the function
*is* the install for an independent block. A block with `dependsOn` still needs its dependencies
installed first — the console orders the stack (step 1).

### Branch behaviour

**Child branches inherit triggers disabled.** A block installed on a parent branch and then branched
will have its schema and function but dormant triggers. The console should enable them on promote or
surface it — otherwise scheduled work silently never runs, the most common install-time surprise on
this platform. Every scheduled block's `/health` reports it.

## Versioning and upgrade

`blocks_core.migrations` records which migrations ran; `blocks_core.installations` records which
**version** is installed (`scripts/deploy.mjs` writes it — the repo version, since the registry
carries no per-block version). `SELECT * FROM blocks_core.v_installed_blocks;` shows the state.

Upgrades are **explicit, never automatic**: the console shows "installed vs available" with a
changelog and an action that re-deploys the newer zip (the handler applies any new migrations on its
next boot). `installations.upgrade_from` flags an interrupted upgrade.

## Uninstall

Each block owns exactly one schema, so `DROP SCHEMA blocks_<slug> CASCADE` is a complete removal —
that is why the namespacing convention exists. `scripts/deploy.mjs uninstall <slug>` rolls back the
block's down migrations instead, which deliberately leave shared objects alone (the `vector`
extension, `blocks_core.migrations`) that a cascade would take with it. Several blocks hold data the
user may not expect to lose, and the console should warn:

| Block | What uninstall destroys |
|---|---|
| `webhooks-inbound` | The raw archive — the only copy of events providers will not resend. |
| `webhooks-outbound` | Endpoint registrations **including signing secrets**. Subscribers cannot re-derive them. |
| `billing` | `usage_events`, the audit trail behind invoices already sent. |
| `compliance` | The hash-chained audit log. |
| `vision` | Alt text you may be serving on live pages. |

## Gaps before this is production-ready

Honest list, roughly in priority order:

1. **Live deploy is unproven.** Migrations have been applied, rolled back, and re-applied against a
   real Neon branch (`scripts/ci-migrate.mjs`), and the registry is hosted with CORS — but a full
   round trip through the function-deploy API (deploy zip → first request self-migrates → triggers
   fire) has not been exercised end to end.
2. **Artifacts are not signed.** `sha256` gives integrity against corruption, not authenticity
   against substitution. Publishing through a trusted channel or signing with a pinned key is the
   real answer.
3. **JSON-blob config is wrong for a form.** `ROUTER_ROUTES` and `QUEUE_CONCURRENCY` are fine in a
   file and hostile in a UI. They should become structured config the console renders as real inputs.
4. **No `widget` form-hint metadata.** `environment` says a field is required and secret, but not
   that `ROUTER_BUCKET` is a bucket picker or `*_CRON` a schedule builder. Adding a `widget` hint to
   the schema is straightforward and would improve the install experience.
5. **Trigger-create API reach is unconfirmed.** `deploy.mjs` calls it; whether the browser console
   can call it directly (vs. via a backend) needs confirming, or scheduled/`/reconcile` paths never
   fire.
6. **Third-party publishing is out of scope.** A catalog limited to this repo needs no external
   registry, signing infrastructure, or sandboxing. Opening it up needs all three.
