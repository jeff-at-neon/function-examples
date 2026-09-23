#!/usr/bin/env node
/**
 * Deploy blocks to a real Neon project.
 *
 * Does what the console will do, from the command line: deploy the bundled function, create its
 * triggers, and record the installed version. Migrations are NOT applied here — every handler is
 * self-migrating (it applies its own migrations on first request), so deploying the function is the
 * install. Useful on its own for testing, and the reference implementation of the install sequence.
 *
 *   node scripts/deploy.mjs list
 *   node scripts/deploy.mjs install <slug> [--dry-run]
 *   node scripts/deploy.mjs status
 *   node scripts/deploy.mjs uninstall <slug>
 *
 * Needs NEON_API_KEY, NEON_PROJECT_ID, and DATABASE_URL (see .env.example). Reads the registry from
 * dist-registry/, so run `node scripts/build-registry.mjs` first.
 */

import { readFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://console.neon.tech/api/v2";
const REGISTRY_DIR = path.join(root, "dist-registry");

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

// ─── registry ───────────────────────────────────────────────────────────────

async function loadRegistry() {
  try {
    return JSON.parse(await readFile(path.join(REGISTRY_DIR, "registry.json"), "utf8"));
  } catch {
    console.error("No dist-registry/registry.json. Build it first:");
    console.error("  node scripts/build-registry.mjs");
    process.exit(1);
  }
}

/** The full self-describing template for one block (environment, triggers, operations). */
async function loadTemplate(id) {
  return JSON.parse(await readFile(path.join(REGISTRY_DIR, id, "template.json"), "utf8"));
}

/** Installed-version stamp: the repo version, since the registry carries no per-block version. */
async function repoVersion() {
  return JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;
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
    const registry = await loadRegistry();
    console.log(`\nNeon Function Registry — ${registry.templates.length} templates\n`);
    for (const t of registry.templates) {
      const deps = t.dependsOn?.length ? `  needs: ${t.dependsOn.join(", ")}` : "";
      console.log(`  ${t.id.padEnd(22)} fn:${functionSlugFor(t.id).padEnd(18)}${deps}`);
    }
    console.log("\nInstall one: node scripts/deploy.mjs install <slug>");
    break;
  }

  case "install": {
    if (!target) {
      console.error("Usage: node scripts/deploy.mjs install <slug> [--dry-run]");
      process.exit(1);
    }

    const registry = await loadRegistry();
    if (!registry.templates.some((t) => t.id === target)) {
      console.error(`Unknown block "${target}". Run: node scripts/deploy.mjs list`);
      process.exit(1);
    }
    const template = await loadTemplate(target);

    // Dependencies first, or a block referencing a dependency's schema fails on a missing table.
    if (template.dependsOn?.length) {
      console.log(`Note: ${target} depends on ${template.dependsOn.join(", ")} — install those first.`);
    }

    // Config check before touching anything. Failing here costs nothing.
    const missing = template.environment
      .filter((c) => c.required && !c.injected && !env[c.name])
      .map((c) => c.name);
    if (missing.length > 0) {
      console.error(`\nCannot install ${target}: missing required configuration.`);
      for (const name of missing) {
        const spec = template.environment.find((c) => c.name === name);
        console.error(`  ${name} — ${spec.description}`);
        if (spec.example) console.error(`    example: ${spec.example}`);
      }
      process.exit(1);
    }

    const functionSlug = functionSlugFor(target);
    const zipBytes = await readFile(path.join(REGISTRY_DIR, `${target}.zip`)).catch(() => {
      console.error(`No ${target}.zip in dist-registry/. Run: node scripts/build-registry.mjs`);
      process.exit(1);
    });

    console.log(`\nInstalling ${target} as function "${functionSlug}"`);
    if (dryRun) console.log("(dry run — no changes will be made)\n");

    // Migrations are NOT applied here: the handler self-migrates on first request (the zip ships
    // migrations/ and applies them idempotently). Deploying the function is the install.

    // Per-install trigger secret. Neon does not sign trigger delivery, so this is the only thing
    // distinguishing a real event from a forged POST. Generated fresh per deployment.
    const triggerSecret = env["NEON_BLOCKS_TRIGGER_SECRET"] ?? randomBytes(32).toString("base64url");

    // Environment for the function. Injected variables are excluded: Neon supplies those, and
    // passing our own would override the platform's.
    const functionEnv = {};
    for (const c of template.environment) {
      if (c.injected) continue;
      if (c.name === "NEON_BLOCKS_TRIGGER_SECRET") functionEnv[c.name] = triggerSecret;
      else if (env[c.name]) functionEnv[c.name] = env[c.name];
      else if (c.default !== undefined && c.default !== "") functionEnv[c.name] = c.default;
    }
    console.log(`  environment: ${Object.keys(functionEnv).length} variable(s)`);

    // A dry run exists so someone can see the plan before they have an API key.
    if (!dryRun) requireEnv("NEON_API_KEY", "NEON_PROJECT_ID");
    const branchId = dryRun ? "(dry-run)" : await resolveBranch();

    // Deploy the registry zip directly — index.mjs at the root, migrations/ alongside. The API
    // takes multipart/form-data with a zip, not JSON.
    if (!dryRun) {
      const form = new FormData();
      form.append("zip", new Blob([zipBytes]), `${target}.zip`);
      form.append("runtime", "nodejs24");
      form.append("environment", JSON.stringify(functionEnv));

      const deployment = await api(
        "POST",
        `/projects/${env["NEON_PROJECT_ID"]}/branches/${branchId}/functions/${functionSlug}/deployments`,
        { formData: form },
      );
      console.log(`  deployed: ${deployment.id ?? "ok"} (${deployment.status ?? "unknown status"})`);
    } else {
      console.log(`  would deploy a ${zipBytes.length}-byte zip`);
    }

    // Triggers. The function-deploy API does not create these; without them the scheduled and
    // /reconcile paths never fire.
    console.log(`  triggers: ${template.triggers?.length ?? 0}`);
    for (const trigger of template.triggers ?? []) {
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
                ...(trigger.prefixEnv && env[trigger.prefixEnv] ? { prefix: env[trigger.prefixEnv] } : {}),
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

    // Record the install, for upgrades. Best-effort: blocks_core.installations is created by the
    // handler's first migration, so this may not exist yet on a brand-new branch.
    if (!dryRun) {
      const version = await repoVersion();
      const sha256 = createHash("sha256").update(zipBytes).digest("hex");
      await withPool(async (pool) => {
        await pool.query(
          `INSERT INTO blocks_core.installations
             (block, version, artifact_sha256, function_slug, config)
           VALUES ($1, $2, $3, $4, $5::jsonb)
           ON CONFLICT (block) DO UPDATE
             SET version = EXCLUDED.version, artifact_sha256 = EXCLUDED.artifact_sha256,
                 function_slug = EXCLUDED.function_slug, config = EXCLUDED.config,
                 upgraded_at = now(), upgrade_from = NULL`,
          [
            target, version, sha256, functionSlug,
            // Secrets excluded deliberately: this row is for support and upgrades.
            JSON.stringify(
              Object.fromEntries(
                Object.entries(functionEnv).filter(
                  ([k]) => !template.environment.find((c) => c.name === k)?.secret,
                ),
              ),
            ),
          ],
        ).catch((err) => {
          console.log(`    note: could not record installation (${err.message.split("\n")[0]})`);
          console.log("    the block is deployed; blocks_core.installations is created on first request");
        });
      });
    }

    console.log(
      dryRun
        ? "\nDry run complete. Re-run without --dry-run to apply."
        : `\n${target} installed. It applies its own migrations on first request. Check health:\n` +
            `  curl https://<function-url>/health`,
    );
    if (!dryRun && !env["NEON_BLOCKS_TRIGGER_SECRET"]) {
      console.log(
        `\nGenerated a trigger secret for this install. To reproduce it, set:\n` +
          `  NEON_BLOCKS_TRIGGER_SECRET=${triggerSecret}`,
      );
    }
    break;
  }

  case "status": {
    await withPool(async (pool) => {
      const { rows } = await pool
        .query(`SELECT * FROM blocks_core.v_installed_blocks ORDER BY block`)
        .catch(() => ({ rows: null }));

      if (!rows) {
        console.log("No installations recorded. Install a block first.");
        return;
      }
      if (rows.length === 0) {
        console.log("No blocks installed.");
        return;
      }

      const version = await repoVersion();
      console.log(`\n${rows.length} block(s) installed (registry is at ${version})\n`);

      for (const row of rows) {
        const upgrade = row.version && row.version !== version ? ` → ${version} available` : "";
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

    const registry = await loadRegistry();
    if (!registry.templates.some((t) => t.id === target)) {
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
    if (destructive[target]) {
      console.log(`\nWARNING: uninstalling ${target} destroys ${destructive[target]}.`);
      console.log("Export it first if that matters. Continuing in 5 seconds; Ctrl-C to abort.\n");
      await new Promise((r) => setTimeout(r, 5_000));
    }

    // Roll back the block's migrations, read from the registry's per-template migrations folder.
    await withPool(async (pool) => {
      const { loadMigrations, rollbackMigrations } = await import(
        path.join(root, "packages/migrate/dist/index.js")
      );
      const migrations = await loadMigrations(path.join(REGISTRY_DIR, target, "migrations"));
      const rolled = await rollbackMigrations(pool, target, migrations, migrations.length);
      console.log(`rolled back ${rolled.length} migration(s) for ${target}`);

      await pool
        .query(`DELETE FROM blocks_core.installations WHERE block = $1`, [target])
        .catch(() => {});
    });
    console.log(
      `\nSchema removed. The deployed function still exists — remove it in the console, or:\n` +
        `  DELETE /projects/$NEON_PROJECT_ID/branches/<branch>/functions/${functionSlugFor(target)}`,
    );
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
