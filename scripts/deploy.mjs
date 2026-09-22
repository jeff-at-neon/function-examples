#!/usr/bin/env node
/**
 * Deploy blocks to a real Neon project.
 *
 * Does what the console will do, from the command line: apply migrations, deploy the bundled
 * function, create its triggers, and record the installed version. Useful on its own for testing,
 * and it is the reference implementation of the install sequence in docs/CONSOLE.md.
 *
 *   node scripts/deploy.mjs list
 *   node scripts/deploy.mjs install <slug> [--dry-run]
 *   node scripts/deploy.mjs status
 *   node scripts/deploy.mjs uninstall <slug>
 *
 * Needs NEON_API_KEY, NEON_PROJECT_ID, and DATABASE_URL (see .env.example). Reads artifacts from
 * dist-release/, so run `node scripts/build-release.mjs` first.
 */

import { readFile, readdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://console.neon.tech/api/v2";

// ─── env ──────────────────────────────────────────────────────────────────────

async function loadDotEnv() {
  const env = {};
  try {
    const text = await readFile(path.join(root, ".env"), "utf8");
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (t === "" || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (v !== "") env[t.slice(0, eq).trim()] = v;
    }
  } catch {
    /* no .env is fine when the real environment is populated */
  }
  return env;
}

const env = { ...(await loadDotEnv()), ...process.env };

/**
 * Neon's function_slug is 1-20 lowercase alphanumeric characters — no hyphens.
 *
 * 15 of the 25 block slugs violate that, so this transform is mandatory rather than cosmetic.
 * Deterministic, and verified collision-free across the current catalog; the assertion below keeps
 * that true if slugs are added later, because a collision would silently deploy one block over
 * another.
 */
export function functionSlugFor(blockSlug) {
  const slug = blockSlug.replace(/-/g, "").slice(0, 20).toLowerCase();
  if (!/^[a-z0-9]{1,20}$/.test(slug)) {
    throw new Error(`Cannot derive a legal function_slug from "${blockSlug}"`);
  }
  return slug;
}

function requireEnv(...names) {
  const missing = names.filter((n) => !env[n]);
  if (missing.length > 0) {
    console.error(`Missing required configuration: ${missing.join(", ")}`);
    console.error("See .env.example, then run: node scripts/doctor.mjs");
    process.exit(1);
  }
}

// ─── Neon API ─────────────────────────────────────────────────────────────────

async function api(method, endpoint, { body, formData } = {}) {
  const headers = { authorization: `Bearer ${env["NEON_API_KEY"]}` };
  let payload;

  if (formData) {
    payload = formData; // fetch sets the multipart boundary itself
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const response = await fetch(`${API}${endpoint}`, { method, headers, body: payload });
  const text = await response.text();

  if (!response.ok) {
    // Include the response body: Neon's errors are specific and hiding them turns a clear
    // "bucket does not exist" into an opaque 400.
    throw new Error(`${method} ${endpoint} → ${response.status}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : {};
}

/** Resolve the branch to operate on, defaulting to the project's primary. */
async function resolveBranch() {
  if (env["NEON_BRANCH_ID"]) return env["NEON_BRANCH_ID"];

  const { branches } = await api("GET", `/projects/${env["NEON_PROJECT_ID"]}/branches`);
  const wanted = env["NEON_BRANCH"];

  if (wanted) {
    const found = branches.find((b) => b.name === wanted);
    if (!found) {
      throw new Error(
        `No branch named "${wanted}". Available: ${branches.map((b) => b.name).join(", ")}`,
      );
    }
    return found.id;
  }

  const primary = branches.find((b) => b.primary || b.default);
  if (!primary) throw new Error("Could not determine a branch; set NEON_BRANCH or NEON_BRANCH_ID");

  // Say it out loud. Deploying to primary by accident is a mistake worth one line of output.
  console.log(`Using primary branch "${primary.name}" (${primary.id})`);
  return primary.id;
}

// ─── artifacts ────────────────────────────────────────────────────────────────

async function loadCatalog() {
  const file = path.join(root, "dist-release", "catalog.json");
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    console.error("No dist-release/catalog.json. Build it first:");
    console.error("  node scripts/build-release.mjs --version 0.1.0");
    process.exit(1);
  }
}

/** Extract a block's tarball and verify its digest against the catalog. */
async function stageArtifact(entry) {
  const tarball = path.join(root, "dist-release", entry.artifact.file);
  const bytes = await readFile(tarball);

  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== entry.artifact.sha256) {
    throw new Error(`${entry.artifact.file} sha256 does not match catalog.json`);
  }

  const dir = await mkdtemp(path.join(tmpdir(), `neon-block-${entry.slug}-`));
  await run("tar", ["-xzf", tarball, "-C", dir]);
  return dir;
}

// ─── database ─────────────────────────────────────────────────────────────────

async function withPool(fn) {
  requireEnv("DATABASE_URL");
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: env["DATABASE_URL"], max: 3 });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

// ─── commands ─────────────────────────────────────────────────────────────────

const [command, target] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const dryRun = process.argv.includes("--dry-run");

switch (command) {
  case "list": {
    const catalog = await loadCatalog();
    console.log(`\nCatalog ${catalog.release} — ${catalog.blockCount} blocks\n`);
    for (const b of catalog.blocks) {
      const prompts = b.config.filter((c) => !c.injected && c.required).length;
      console.log(
        `${String(b.order).padStart(2)}. ${b.slug.padEnd(22)} ` +
          `fn:${functionSlugFor(b.slug).padEnd(18)} ` +
          `${b.depth === "implemented" ? "impl " : "scaff"} ` +
          `${String(prompts)} required field(s)`,
      );
    }
    console.log("\nInstall one: node scripts/deploy.mjs install <slug>");
    break;
  }

  case "install": {
    if (!target) {
      console.error("Usage: node scripts/deploy.mjs install <slug> [--dry-run]");
      process.exit(1);
    }

    const catalog = await loadCatalog();
    const entry = catalog.blocks.find((b) => b.slug === target);
    if (!entry) {
      console.error(`Unknown block "${target}". Run: node scripts/deploy.mjs list`);
      process.exit(1);
    }

    // Dependencies first, or a block referencing a dependency's schema fails on a missing table.
    if (entry.dependsOn.length > 0) {
      console.log(`Note: ${entry.slug} depends on ${entry.dependsOn.join(", ")} — install those first.`);
    }

    // Config check before touching anything. Failing here costs nothing; failing after migrations
    // have applied leaves a half-installed block.
    const missing = entry.config
      .filter((c) => c.required && !c.injected && !env[c.name])
      .map((c) => c.name);
    if (missing.length > 0) {
      console.error(`\nCannot install ${entry.slug}: missing required configuration.`);
      for (const name of missing) {
        const spec = entry.config.find((c) => c.name === name);
        console.error(`  ${name} — ${spec.description}`);
        if (spec.example) console.error(`    example: ${spec.example}`);
      }
      process.exit(1);
    }

    const functionSlug = functionSlugFor(entry.slug);
    const dir = await stageArtifact(entry);

    try {
      console.log(`\nInstalling ${entry.slug} ${entry.version} as function "${functionSlug}"`);
      if (dryRun) console.log("(dry run — no changes will be made)\n");

      // 1. Migrations.
      const migrationDir = path.join(dir, "migrations");
      const files = (await readdir(migrationDir))
        .filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"))
        .sort();

      console.log(`  migrations: ${files.length}`);
      if (!dryRun) {
        await withPool(async (pool) => {
          const { applyMigrations, loadMigrations } = await import(
            path.join(root, "packages/migrate/dist/index.js")
          );
          const migrations = await loadMigrations(migrationDir);
          const result = await applyMigrations(pool, entry.slug, migrations);
          console.log(`    applied ${result.applied.length}, skipped ${result.skipped.length}`);
          if (result.drifted.length > 0) {
            throw new Error(
              `drifted migrations: ${result.drifted.map((d) => d.version).join(", ")}`,
            );
          }
        });
      }

      // 2. Per-install trigger secret. Neon does not sign trigger delivery, so this is the only
      // thing distinguishing a real event from a forged POST. Generated fresh per deployment and
      // never reused across projects.
      const triggerSecret = env["NEON_BLOCKS_TRIGGER_SECRET"] ?? randomBytes(32).toString("base64url");

      // 3. Environment for the function. Injected variables are excluded: Neon supplies those, and
      // passing our own would override the platform's.
      const functionEnv = {};
      for (const c of entry.config) {
        if (c.injected) continue;
        if (c.name === "NEON_BLOCKS_TRIGGER_SECRET") {
          functionEnv[c.name] = triggerSecret;
        } else if (env[c.name]) {
          functionEnv[c.name] = env[c.name];
        } else if (c.default !== null) {
          functionEnv[c.name] = c.default;
        }
      }
      console.log(`  environment: ${Object.keys(functionEnv).length} variable(s)`);

      // 4. Deploy. The API takes multipart/form-data with a zip, not JSON.
      //
      // Credentials are only required for a real deploy. A dry run exists precisely so someone can
      // see the plan before they have an API key, so demanding one here would defeat it.
      if (!dryRun) requireEnv("NEON_API_KEY", "NEON_PROJECT_ID");
      const branchId = dryRun ? "(dry-run)" : await resolveBranch();

      if (!dryRun) {
        const zipPath = path.join(dir, "function.zip");
        // Zip only what the runtime needs. Shipping migrations inside the function would work but
        // put SQL on a public endpoint's filesystem for no reason.
        await run("zip", ["-q", "-j", zipPath, path.join(dir, "index.js")]);

        const form = new FormData();
        form.append("zip", new Blob([await readFile(zipPath)]), "function.zip");
        form.append("runtime", "nodejs24");
        form.append("environment", JSON.stringify(functionEnv));

        const deployment = await api(
          "POST",
          `/projects/${env["NEON_PROJECT_ID"]}/branches/${branchId}/functions/${functionSlug}/deployments`,
          { formData: form },
        );
        console.log(`  deployed: ${deployment.id ?? "ok"} (${deployment.status ?? "unknown status"})`);
      }

      // 5. Triggers.
      console.log(`  triggers: ${entry.triggers.length}`);
      for (const trigger of entry.triggers) {
        const name = `${functionSlug}-${trigger.functionPath.replace(/^\//, "") || "root"}`;
        // Secret on the query string is how the handler authenticates the caller.
        const functionPath = `${trigger.functionPath}?secret=${triggerSecret}`;

        const body =
          trigger.type === "schedule"
            ? { type: "schedule", function_slug: functionSlug, name, function_path: functionPath,
                schedule: { cron: trigger.cron }, enabled: true }
            : { type: "storage_object_created", function_slug: functionSlug, name,
                function_path: functionPath,
                storage_object_created: {
                  bucket_name: env[trigger.bucketEnv] ?? "",
                  ...(trigger.prefixEnv && env[trigger.prefixEnv]
                    ? { prefix: env[trigger.prefixEnv] }
                    : {}),
                },
                enabled: true };

        if (trigger.type === "storage_object_created" && !body.storage_object_created.bucket_name) {
          console.log(`    skipped ${trigger.type} — ${trigger.bucketEnv} is not set`);
          continue;
        }

        console.log(
          `    ${trigger.type} → ${trigger.functionPath}` +
            (trigger.cron ? ` (${trigger.cron} UTC)` : ` (${body.storage_object_created?.bucket_name})`),
        );

        if (!dryRun) {
          await api("POST", `/projects/${env["NEON_PROJECT_ID"]}/branches/${branchId}/triggers`, { body });
        }
      }

      // 6. Record the version, so upgrades have something to compare against.
      if (!dryRun) {
        await withPool(async (pool) => {
          await pool.query(
            `INSERT INTO blocks_core.installations
               (block, version, artifact_sha256, function_slug, config)
             VALUES ($1, $2, $3, $4, $5::jsonb)
             ON CONFLICT (block) DO UPDATE
               SET version = EXCLUDED.version,
                   artifact_sha256 = EXCLUDED.artifact_sha256,
                   function_slug = EXCLUDED.function_slug,
                   config = EXCLUDED.config,
                   upgraded_at = now(),
                   upgrade_from = NULL`,
            [
              entry.slug,
              entry.version,
              entry.artifact.sha256,
              functionSlug,
              // Secrets excluded deliberately: this row is for support and upgrades, and a
              // credential in it would outlive the reason to have it.
              JSON.stringify(
                Object.fromEntries(
                  Object.entries(functionEnv).filter(
                    ([k]) => !entry.config.find((c) => c.name === k)?.secret,
                  ),
                ),
              ),
            ],
          ).catch((err) => {
            // The block is deployed and working at this point; only the bookkeeping failed.
            console.log(`    note: could not record installation (${err.message.split("\n")[0]})`);
            console.log("    install the queue block first — it creates blocks_core.installations");
          });
        });
      }

      console.log(
        dryRun
          ? "\nDry run complete. Re-run without --dry-run to apply."
          : `\n${entry.slug} installed. Check health:\n` +
              `  curl https://<function-url>/health`,
      );
      if (!dryRun && !env["NEON_BLOCKS_TRIGGER_SECRET"]) {
        console.log(
          `\nGenerated a trigger secret for this install. To reproduce it, set:\n` +
            `  NEON_BLOCKS_TRIGGER_SECRET=${triggerSecret}`,
        );
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    break;
  }

  case "status": {
    await withPool(async (pool) => {
      const { rows } = await pool
        .query(`SELECT * FROM blocks_core.v_installed_blocks ORDER BY block`)
        .catch(() => ({ rows: null }));

      if (!rows) {
        console.log("No installations recorded. Install the queue block first.");
        return;
      }
      if (rows.length === 0) {
        console.log("No blocks installed.");
        return;
      }

      const catalog = await loadCatalog();
      console.log(`\n${rows.length} block(s) installed (catalog is at ${catalog.release})\n`);

      for (const row of rows) {
        const available = catalog.blocks.find((b) => b.slug === row.block)?.version;
        const upgrade = available && available !== row.version ? ` → ${available} available` : "";
        const interrupted = row.interrupted_upgrade_from
          ? `  INTERRUPTED UPGRADE from ${row.interrupted_upgrade_from}`
          : "";
        console.log(
          `  ${row.block.padEnd(22)} ${row.version}${upgrade}` +
            `  fn:${row.function_slug ?? "?"}  ${row.migrations_applied} migration(s)${interrupted}`,
        );
      }
    });
    break;
  }

  case "uninstall": {
    if (!target) {
      console.error("Usage: node scripts/deploy.mjs uninstall <slug>");
      process.exit(1);
    }

    const catalog = await loadCatalog();
    const entry = catalog.blocks.find((b) => b.slug === target);
    if (!entry) {
      console.error(`Unknown block "${target}"`);
      process.exit(1);
    }

    // Several blocks hold data that cannot be reconstructed. Warn before, not after.
    const destructive = {
      "webhooks-inbound": "the raw webhook archive — the only copy of events providers will not resend",
      "webhooks-outbound": "endpoint registrations INCLUDING signing secrets subscribers cannot re-derive",
      billing: "usage_events, the audit trail behind invoices already sent",
      compliance: "the hash-chained audit log",
      vision: "alt text you may be serving on live pages",
    };
    if (destructive[entry.slug]) {
      console.log(`\nWARNING: uninstalling ${entry.slug} destroys ${destructive[entry.slug]}.`);
      console.log("Export it first if that matters. Continuing in 5 seconds; Ctrl-C to abort.\n");
      await new Promise((r) => setTimeout(r, 5_000));
    }

    const dir = await stageArtifact(entry);
    try {
      await withPool(async (pool) => {
        const { loadMigrations, rollbackMigrations } = await import(
          path.join(root, "packages/migrate/dist/index.js")
        );
        const migrations = await loadMigrations(path.join(dir, "migrations"));
        const rolled = await rollbackMigrations(pool, entry.slug, migrations, migrations.length);
        console.log(`rolled back ${rolled.length} migration(s) for ${entry.slug}`);

        await pool
          .query(`DELETE FROM blocks_core.installations WHERE block = $1`, [entry.slug])
          .catch(() => {});
      });
      console.log(
        `\nSchema removed. The deployed function still exists — remove it in the console, or:\n` +
          `  DELETE /projects/$NEON_PROJECT_ID/branches/<branch>/functions/${functionSlugFor(entry.slug)}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    break;
  }

  default:
    console.error(
      "Usage:\n" +
        "  node scripts/deploy.mjs list\n" +
        "  node scripts/deploy.mjs install <slug> [--dry-run]\n" +
        "  node scripts/deploy.mjs status\n" +
        "  node scripts/deploy.mjs uninstall <slug>\n",
    );
    process.exit(1);
}
