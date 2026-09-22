# Console catalog integration

How a hosted catalog deploys these blocks into a user's own org, project, and branch. The model is
DockerHub-shaped: a public index of versioned artifacts, each self-describing, fetched and deployed
on demand.

## The property everything rests on

**Artifacts are public and inert.** A release tarball contains bundled code, migrations, a manifest,
and a README — and no credentials of any kind. So they can be served unauthenticated from anywhere,
and the console never holds a secret on the user's behalf.

That works because Neon already injects what functions need. `DATABASE_URL`, Object Storage
credentials, and AI Gateway credentials arrive in the deployed function's environment automatically.
The catalog supplies code; the platform supplies identity.

Two consequences worth stating plainly:

- **No user credentials belong in this repo or in GitHub secrets.** The only secret CI needs is one
  `NEON_API_KEY` for a throwaway test branch.
- **`NEON_BLOCKS_TRIGGER_SECRET` is the exception and must be generated per install.** Neon does not
  sign trigger delivery, so this shared secret is the only thing distinguishing a real trigger from
  a forged POST. The console should generate one per deployment and never reuse or store it centrally.

`scripts/verify-release.mjs` enforces the inert property on every release rather than trusting it,
because a regression would be invisible until something leaked.

## What a release contains

`node scripts/build-release.mjs --version X.Y.Z` produces:

```
catalog.json                              the console's index
neon-blocks-<slug>-<version>.tar.gz       one per block
  index.js          bundled, self-contained, ~9-23 KB
  block.json        manifest + version
  migrations/*.sql  up and down
  README.md         rendered as the block's docs page
```

All 25 blocks total about **340 KB**. The bundle inlines every `@neon-blocks/*` workspace import, so
`pg` and `node:*` are the only externals — both runtime-provided. Verified: the artifact imports
cleanly and exposes `default.fetch`, which is the shape the deploy API expects.

## catalog.json

One entry per block, carrying everything needed to render a browse page and an install form:

```jsonc
{
  "catalogVersion": 1,
  "release": "0.1.0",
  "blockCount": 25,
  "blocks": [{
    "slug": "ingest-router",
    "version": "0.1.0",
    "name": "Ingest Router",
    "summary": "One storage trigger per bucket, dispatched by file type…",
    "order": 5,                    // default sort: foundations first
    "schema": "blocks_ingest_router",
    "depth": "implemented",        // vs "scaffold" — surface this honestly
    "capabilities": ["postgres", "object_storage"],
    "dependsOn": ["queue"],        // install these first
    "config": [{
      "name": "ROUTER_BUCKET",
      "description": "Bucket this router watches…",
      "required": true,
      "default": null,
      "injected": false,           // true = Neon supplies it, DO NOT PROMPT
      "secret": false,             // true = render as a password field
      "example": "uploads"
    }],
    "triggers": [
      { "type": "storage_object_created", "bucketEnv": "ROUTER_BUCKET", "functionPath": "/route" },
      { "type": "schedule", "cron": "37 * * * *", "functionPath": "/reconcile" }
    ],
    "migrationCount": 1,
    "readme": "ingest-router/README.md",
    "artifact": { "file": "…tar.gz", "bytes": 17988, "sha256": "64ddcd…" }
  }]
}
```

The `injected` flag matters: prompting for `DATABASE_URL` would be asking a user for something Neon
already provides. Across the catalog, injected variables outnumber promptable ones roughly 4:1 — most
blocks need one or two real inputs.

## Install sequence

```
1. resolve dependsOn, install those first          (queue before ingest-router)
2. fetch tarball, verify sha256 against catalog
3. apply migrations in order, recording in blocks_core.migrations
4. generate a per-install NEON_BLOCKS_TRIGGER_SECRET
5. POST index.js to the function deploy API for the target branch
6. create declared triggers, appending ?secret=<generated> to each function_path
7. record version in blocks_core.installations
8. GET /health to confirm the deployment answers
```

Steps 3 and 5 should be transactional in spirit: a block whose migrations applied but whose function
failed to deploy is the state most likely to confuse a user. Record the attempt before deploying so
the failure is visible rather than silent.

### Branch behaviour

**Child branches inherit triggers disabled.** A block installed on a parent branch and then branched
will have its schema and function but dormant triggers. The console should either enable them on
promote or surface it — otherwise scheduled work silently never runs, which is the most common
install-time surprise on this platform. Every scheduled block's `/health` reports it.

## Versioning and upgrade

`blocks_core.migrations` records which migrations ran. `blocks_core.installations` records which
**version** is installed — a different question, and the one a user cannot answer by inspecting a
checkout when the console owns the install.

```sql
SELECT * FROM blocks_core.v_installed_blocks;
```

Upgrades are **explicit, never automatic**. The console shows "v1.2 installed, v1.3 available" with a
changelog and an upgrade action that applies only the intervening migrations. A schema migration on a
production table can take locks and degrade performance; the user should choose when that happens.

`installations.upgrade_from` is set while an upgrade is in flight and cleared on success. A non-null
value means an upgrade was interrupted, leaving a schema state that neither version describes — worth
surfacing prominently rather than inferring from a version mismatch.

`installation_history` keeps the record, because "what changed and when" is the first question when a
block misbehaves after an upgrade.

## Uninstall

Each block owns exactly one schema, so `DROP SCHEMA blocks_<slug> CASCADE` is a complete removal —
that is why the namespacing convention exists. But several blocks hold data the user may not expect
to lose, and the console should say so:

| Block | What uninstall destroys |
|---|---|
| `webhooks-inbound` | The raw archive — the only copy of events providers will not resend. |
| `webhooks-outbound` | Endpoint registrations **including signing secrets**. Subscribers cannot re-derive them. |
| `billing` | `usage_events`, the audit trail behind invoices already sent. |
| `compliance` | The hash-chained audit log. |
| `vision` | Alt text you may be serving on live pages. |

Prefer `neon-blocks rollback`, which runs the down migrations, over a raw `DROP SCHEMA`: the down
migrations deliberately leave shared objects alone (the `vector` extension, `blocks_core.migrations`)
that a cascade would take with it.

## Gaps before this is production-ready

Honest list, roughly in priority order:

1. **Nothing has been deployed to Neon and the SQL has never executed.** The artifacts are verified
   self-contained and loadable; the migrations are reviewed, not proven. `scripts/ci-migrate.mjs`
   closes this and needs a database.
2. **Artifacts are not signed.** `sha256` gives integrity against corruption, not authenticity
   against substitution. Publishing through a channel the console trusts, or signing with a key it
   pins, is the real answer.
3. **JSON-blob config is wrong for a form.** `ROUTER_ROUTES` and `QUEUE_CONCURRENCY` are fine in a
   file and hostile in a UI. They should become structured config the console renders as real inputs.
4. **No form-hint metadata.** `config` says a field is required and secret, but not that
   `ROUTER_BUCKET` should be a bucket picker or `*_CRON` a schedule builder. Adding a `widget` hint
   to the manifest is straightforward and would improve the install experience substantially.
5. **Blocks 11–25 are scaffolds.** `depth` distinguishes them, and the console must surface that —
   installing one gets working schema and a handler that returns `501` with an explanation for the
   parts not yet wired. Presenting them as complete would be the worst failure mode here.
6. **No telemetry across installs.** With one deployment per project there is no aggregate view, so
   "version 1.2 has a bug, notify affected projects" has no mechanism.
7. **Third-party publishing is out of scope.** A catalog limited to this repo needs no registry,
   signing infrastructure, or sandboxing. Opening it up needs all three.
