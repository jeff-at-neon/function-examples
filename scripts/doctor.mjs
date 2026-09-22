#!/usr/bin/env node
/**
 * Preflight check for a local or CI test environment.
 *
 * Reads .env, validates what it finds, connects to the database, and reports which blocks are
 * testable. Designed so its output is safe to paste anywhere: every credential is reduced to a
 * shape assertion ("set, 64 chars, looks like a Neon host") and no value is ever printed.
 *
 * That property is the point. Diagnosing a connection problem usually means someone pasting their
 * config into a chat window, and a tool that makes the useful part visible without the secret part
 * removes the reason to do that.
 *
 *   node scripts/doctor.mjs
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Minimal .env parser. Avoids a dependency for something this small. */
async function loadDotEnv(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return {};
  }

  const env = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip matched surrounding quotes, which people add reflexively.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value !== "") env[key] = value;
  }
  return env;
}

// Real process env wins over .env, so CI can override without editing a file.
const fileEnv = await loadDotEnv(path.join(root, ".env"));
const env = { ...fileEnv, ...process.env };

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const info = (m) => console.log(`    ${m}`);

console.log("\nNeon Blocks environment check\n");
console.log(
  Object.keys(fileEnv).length > 0
    ? `Loaded .env (${Object.keys(fileEnv).length} variables)`
    : "No .env found — reading process environment only. Copy .env.example to .env to configure.",
);

let fatal = false;

// ───────────────────────────────────────────────────────────────────────────
console.log("\n1. Database");
// ───────────────────────────────────────────────────────────────────────────

const dbUrl = env["DATABASE_URL"];

if (!dbUrl) {
  bad("DATABASE_URL is not set — nothing can be tested without it");
  info("Create a throwaway branch: neon branches create --name blocks-test");
  fatal = true;
} else {
  let parsed;
  try {
    parsed = new URL(dbUrl);
  } catch {
    bad("DATABASE_URL is not a valid URL");
    fatal = true;
  }

  if (parsed) {
    // Describe the connection without revealing it. Host and database name are the parts that
    // matter for diagnosis; the password never appears.
    const host = parsed.hostname;
    const database = parsed.pathname.replace(/^\//, "") || "(none)";
    ok(`DATABASE_URL is set — host ${host}, database ${database}`);

    if (!/neon\.tech$/.test(host) && host !== "localhost" && !host.startsWith("127.")) {
      warn(`host does not look like Neon or localhost — is this the right database?`);
    }

    // Pooled connections break DDL-heavy work: PgBouncer in transaction mode does not keep session
    // state across statements, and the migration runner relies on advisory locks.
    if (host.includes("-pooler")) {
      bad("this is a POOLED connection string; migrations need the direct one");
      info("Advisory locks and session state do not survive transaction-mode pooling.");
      info("Remove '-pooler' from the host, or copy the direct string from the console.");
      fatal = true;
    }

    if (!parsed.searchParams.has("sslmode")) {
      warn("no sslmode parameter — Neon requires TLS; add ?sslmode=require");
    }

    // Guard against the expensive mistake. Rollback verification drops schemas.
    if (/\b(prod|production|main)\b/.test(database) || /\b(prod|production)\b/.test(host)) {
      bad(`database or host name contains "prod"/"main" — refusing to recommend this`);
      info("verify-rollback DROPs every block schema. Use a throwaway branch.");
      fatal = true;
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n2. Credentials present");
// ───────────────────────────────────────────────────────────────────────────

/** Report a credential's shape, never its value. */
function describeSecret(name, { optional = true, minLength = 8 } = {}) {
  const value = env[name];
  if (!value) {
    if (optional) warn(`${name} not set`);
    else bad(`${name} not set`);
    return false;
  }
  if (value.length < minLength) {
    warn(`${name} is set but only ${value.length} characters — likely a placeholder`);
    return false;
  }
  // Length and prefix are enough to spot a truncated paste or a wrong-vendor key.
  const prefix = /^[a-z]+_/.exec(value)?.[0] ?? "";
  ok(`${name} set (${value.length} chars${prefix ? `, prefix "${prefix}"` : ""})`);
  return true;
}

const hasStorage =
  describeSecret("NEON_STORAGE_ENDPOINT") &&
  describeSecret("NEON_STORAGE_ACCESS_KEY_ID") &&
  describeSecret("NEON_STORAGE_SECRET_ACCESS_KEY", { minLength: 16 });

const hasAi = describeSecret("NEON_AI_GATEWAY_API_KEY", { minLength: 16 });
const hasTriggerSecret = describeSecret("NEON_BLOCKS_TRIGGER_SECRET", { minLength: 16 });
const hasApiKey = describeSecret("NEON_API_KEY", { minLength: 16 });

const webhookProviders = ["STRIPE", "GITHUB", "SHOPIFY", "SLACK", "CLERK"].filter(
  (p) => env[`WEBHOOK_SECRET_${p}`],
);
if (webhookProviders.length > 0) {
  ok(`webhook secrets configured for: ${webhookProviders.join(", ").toLowerCase()}`);
} else {
  warn("no webhook signing secrets set — block 6 cannot verify any provider");
}

if (!hasTriggerSecret) {
  info("Without it, anyone who learns a function URL can forge trigger events.");
  info("Generate one: openssl rand -base64 32");
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n3. Bucket configuration");
// ───────────────────────────────────────────────────────────────────────────

// The write-amplification check, done here rather than discovered on an invoice. There is no
// negative prefix filter on storage triggers, so an output written where the trigger is watching
// retriggers the pipeline that produced it.
const loopPairs = [
  ["ROUTER_BUCKET", "ROUTER_OUTPUT_BUCKET", "ROUTER_PREFIX", "ROUTER_OUTPUT_PREFIX"],
  ["IMAGES_SOURCE_BUCKET", "IMAGES_DERIVATIVE_BUCKET", "IMAGES_SOURCE_PREFIX", "IMAGES_DERIVATIVE_PREFIX"],
  ["CSV_BUCKET", "CSV_BUCKET", "CSV_PREFIX", "CSV_REPORT_PREFIX"],
  ["MODERATION_BUCKET", "MODERATION_BUCKET", "MODERATION_PREFIX", "MODERATION_QUARANTINE_PREFIX"],
];

let loopRisk = false;
for (const [inBucket, outBucket, inPrefix, outPrefix] of loopPairs) {
  const source = env[inBucket];
  if (!source) continue;

  const output = env[outBucket] || source;
  if (output !== source) continue; // separate buckets: always safe

  const pIn = env[inPrefix] ?? "";
  const pOut = env[outPrefix] ?? "";

  if (pIn === "" || pOut === "" || pOut.startsWith(pIn) || pIn.startsWith(pOut)) {
    bad(`${inBucket} and ${outBucket} share a bucket with overlapping prefixes`);
    info(`"${pIn || "(empty)"}" vs "${pOut || "(empty)"}" — every output would retrigger the pipeline.`);
    info("Use a separate output bucket, or make the prefixes disjoint.");
    loopRisk = true;
  }
}
if (!loopRisk) ok("no write-amplification loops in the configured bucket pairs");

// ───────────────────────────────────────────────────────────────────────────
console.log("\n4. Connectivity");
// ───────────────────────────────────────────────────────────────────────────

if (dbUrl && !fatal) {
  try {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: dbUrl, connectionTimeoutMillis: 10_000 });
    await client.connect();

    const { rows } = await client.query(
      `SELECT current_database() AS db,
              current_user AS usr,
              substring(version() from 'PostgreSQL [0-9.]+') AS version,
              pg_size_pretty(pg_database_size(current_database())) AS size`,
    );
    const row = rows[0];
    ok(`connected — ${row.version}, database ${row.db}, user ${row.usr}, size ${row.size}`);

    // pgvector gates five blocks, and its absence fails at CREATE EXTENSION rather than anywhere
    // informative, so check before migrations do.
    const { rows: exts } = await client.query(
      `SELECT extname FROM pg_extension WHERE extname IN ('vector','pg_trgm','unaccent','pg_stat_statements')`,
    );
    const installed = new Set(exts.map((e) => e.extname));

    const { rows: avail } = await client.query(
      `SELECT name FROM pg_available_extensions WHERE name IN ('vector','pg_trgm','unaccent')`,
    );
    const available = new Set(avail.map((a) => a.name));

    for (const ext of ["vector", "pg_trgm", "unaccent"]) {
      if (installed.has(ext)) ok(`extension ${ext} installed`);
      else if (available.has(ext)) info(`extension ${ext} available, will be created by migrations`);
      else bad(`extension ${ext} is NOT available — blocks depending on it cannot install`);
    }

    if (installed.has("pg_stat_statements")) {
      ok("pg_stat_statements installed — block 25 can analyse queries");
    } else {
      warn("pg_stat_statements not installed — block 25 will report that rather than stay silent");
    }

    // Already-installed blocks, so re-running is understood rather than surprising.
    const { rows: applied } = await client.query(
      `SELECT count(DISTINCT block)::int AS blocks, count(*)::int AS migrations
       FROM blocks_core.migrations`,
    ).catch(() => ({ rows: [{ blocks: 0, migrations: 0 }] }));

    if (applied[0]?.migrations > 0) {
      info(
        `${applied[0].blocks} block(s) already migrated here (${applied[0].migrations} migrations). ` +
          `Re-applying is a no-op.`,
      );
    } else {
      info("no blocks migrated yet — this is a clean database");
    }

    await client.end();
  } catch (err) {
    bad(`could not connect: ${err instanceof Error ? err.message : String(err)}`);
    if (String(err).includes("password authentication failed")) {
      info("Check the password, and that you copied the whole string including the ?sslmode suffix.");
    }
    if (String(err).includes("ENOTFOUND") || String(err).includes("ETIMEDOUT")) {
      info("Host unreachable. Neon computes suspend when idle; the first connection may need a retry.");
    }
    fatal = true;
  }
} else if (dbUrl) {
  warn("skipping connectivity check because of the errors above");
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n5. What you can test now");
// ───────────────────────────────────────────────────────────────────────────

const tiers = [
  {
    label: "All 25 migrations, rollback verification, every v_status view",
    ready: Boolean(dbUrl) && !fatal,
    need: "DATABASE_URL",
    note: "The highest-value step — this is the part that has never run.",
  },
  {
    label: "RAG ingestion, hybrid search, vision, embedding freshness",
    ready: hasAi,
    need: "NEON_AI_GATEWAY_API_KEY",
  },
  {
    label: "The full storage family end to end",
    ready: hasStorage,
    need: "NEON_STORAGE_* credentials and the buckets created",
  },
  {
    label: "Inbound webhook verification",
    ready: webhookProviders.length > 0,
    need: "at least one WEBHOOK_SECRET_*",
  },
  {
    label: "Function deployment and live trigger delivery",
    ready: hasApiKey && hasTriggerSecret,
    need: "NEON_API_KEY and NEON_BLOCKS_TRIGGER_SECRET",
  },
];

for (const tier of tiers) {
  if (tier.ready) ok(tier.label);
  else info(`— ${tier.label} (needs ${tier.need})`);
  if (tier.ready && tier.note) info(tier.note);
}

console.log("\nNext:");
if (fatal) {
  console.log("  Fix the errors above, then re-run: node scripts/doctor.mjs");
  process.exit(1);
}
console.log("  node scripts/ci-migrate.mjs apply             # apply all 25 blocks");
console.log("  node scripts/ci-migrate.mjs verify-rollback    # prove every migration reverses");
console.log("  node scripts/ci-migrate.mjs check-views        # query every v_status\n");
