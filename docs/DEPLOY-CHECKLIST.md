# Deploy checklist: making self-migration work

For the console/GUI that deploys blocks via the Neon function-deploy API.

Every handler is **self-migrating**: on its first request it applies its own migrations
idempotently (recorded in `blocks_core.migrations`), reading the SQL from
`/opt/function/migrations`. For that to work end to end, a deploy must satisfy all of the following.

## The zip you deploy

1. **Deploy the registry's `<id>.zip` unmodified** — don't rebuild a code-only zip.
   `unzip -l <id>.zip` must show **`index.mjs` at the root** *and* a sibling **`migrations/`**
   directory with the `.sql` files. If you build the zip yourself, include `migrations/` — do **not**
   strip it "to keep the function lean" (the old pipeline excluded migrations; that is now reversed).
2. `index.mjs` stays at the archive **root** and `migrations/` is a sibling at the root — no nesting
   under a subfolder. The `nodejs24` runtime only resolves `/opt/function/index.mjs`.

## The deploy API call

3. Send the whole zip as the multipart `zip` field, `runtime: nodejs24`, and env as the separate
   `environment` JSON. Don't extract and re-zip just the entry.
4. **Do not put `DATABASE_URL` in `environment`** — Neon injects it. But confirm it *is* injected on
   the target branch, because the migration step connects with it. If it's missing, the first
   request 500s.

## After deploy (the most commonly missed step)

5. **Migrations run on the first request, not at deploy.** After deploying, the console must
   **invoke the function once** (e.g. `GET /health`) to trigger migration — otherwise the schema
   won't appear until something first hits the function or a trigger fires.
6. Create the declared triggers (`template.triggers`), but note scheduled/storage functions don't
   self-invoke immediately — so still hit `/health` post-deploy to bring the schema up now.

## Verify after one deploy

7. `curl <fn-url>/health` returns **200**, then:
   ```sql
   SELECT * FROM blocks_core.migrations ORDER BY applied_at;         -- has rows
   SELECT schema_name FROM information_schema.schemata
     WHERE schema_name LIKE 'blocks_%';                              -- blocks_<slug> exists
   ```
8. If `/health` is **500**, the body says which:
   - `no migrations found at /opt/function/migrations` → the zip didn't include `migrations/`.
   - a DB/connection error → `DATABASE_URL` isn't injected on the branch.

## Dependency stacks

A block only migrates its **own** schema. A block with `dependsOn` (e.g. `["queue"]`) needs its
dependencies installed **first** — resolve the `dependsOn` closure and deploy foundations
(`blocks_core`/`queue`) before dependents.
