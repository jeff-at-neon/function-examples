#!/usr/bin/env node
/**
 * Migration verifier for CI.
 *
 * Applies every block's migrations to a real Postgres, rolls them all back, and re-applies them.
 * That round trip is the only thing that makes convention §2 — "every migration is reversible" —
 * worth asserting rather than merely stating, and it is the check unit tests fundamentally cannot
 * perform.
 *
 * Three subcommands:
 *   apply            forward-migrate everything in dependency order
 *   verify-rollback  roll back in reverse, then re-apply — catches down migrations that do not
 *                    exist, that fail, or that leave a state the up migration cannot re-enter
 *   check-views      query every v_status view, because a view can parse and still be broken
 *
 * Usage: DATABASE_URL=... node scripts/ci-migrate.mjs <subcommand>
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required. Point it at a throwaway database — this drops schemas.");
  process.exit(1);
}

const { discoverBlocks } = await import(path.join(root, "packages/cli/dist/index.js"));
const { loadMigrations, applyMigrations, rollbackMigrations } = await import(
  path.join(root, "packages/migrate/dist/index.js")
);
const { getPool, resetPool } = await import(path.join(root, "packages/core/dist/index.js"));

const blocksDir = path.join(root, "blocks");

/**
 * Blocks in an order that satisfies declared dependencies.
 *
 * Rank order alone is not sufficient — a block may depend on a higher-ranked one — so this does a
 * topological sort and falls back to rank for ties. Without it, a block referencing a dependency's
 * schema fails on a table that simply has not been created yet, which looks like a broken migration
 * rather than a broken ordering.
 */
function inDependencyOrder(blocks) {
  const bySlug = new Map(blocks.map((b) => [b.manifest.slug, b]));
  const ordered = [];
  const state = new Map(); // slug -> "visiting" | "done"

  const visit = (block, chain) => {
    const slug = block.manifest.slug;
    if (state.get(slug) === "done") return;
    if (state.get(slug) === "visiting") {
      throw new Error(`Circular dependency: ${[...chain, slug].join(" -> ")}`);
    }

    state.set(slug, "visiting");
    for (const dep of block.manifest.dependsOn) {
      const dependency = bySlug.get(dep);
      if (!dependency) {
        throw new Error(`Block "${slug}" depends on unknown block "${dep}"`);
      }
      visit(dependency, [...chain, slug]);
    }
    state.set(slug, "done");
    ordered.push(block);
  };

  for (const block of [...blocks].sort((a, b) => a.manifest.rank - b.manifest.rank)) {
    visit(block, []);
  }
  return ordered;
}

async function loadAll() {
  const blocks = inDependencyOrder(await discoverBlocks(blocksDir));
  const withMigrations = [];

  for (const block of blocks) {
    const migrations = await loadMigrations(path.join(block.dir, "migrations"));
    withMigrations.push({ ...block, migrations });
  }
  return withMigrations;
}

async function apply(pool, blocks, { quiet = false } = {}) {
  for (const block of blocks) {
    const result = await applyMigrations(pool, block.manifest.slug, block.migrations);

    if (result.drifted.length > 0) {
      // A migration whose checksum changed after being applied. Surfaced loudly because silently
      // re-running an edited migration is how environments diverge irreversibly.
      throw new Error(
        `Block "${block.manifest.slug}" has drifted migrations: ` +
          result.drifted.map((d) => `${d.version}_${d.name}`).join(", "),
      );
    }
    if (!quiet) {
      console.log(
        `  ${block.manifest.slug.padEnd(22)} applied ${String(result.applied.length).padStart(2)}, ` +
          `skipped ${result.skipped.length}`,
      );
    }
  }
}

switch (process.argv[2]) {
  case "apply": {
    const pool = getPool();
    const blocks = await loadAll();
    console.log(`Applying migrations for ${blocks.length} blocks in dependency order:`);
    await apply(pool, blocks);
    console.log("All migrations applied.");
    await resetPool();
    break;
  }

  case "verify-rollback": {
    const pool = getPool();
    const blocks = await loadAll();

    // Reverse order: a block that depends on another must be removed before the thing it depends on,
    // or the rollback hits a foreign key or a missing schema.
    console.log(`Rolling back ${blocks.length} blocks in reverse dependency order:`);
    for (const block of [...blocks].reverse()) {
      const rolled = await rollbackMigrations(
        pool,
        block.manifest.slug,
        block.migrations,
        block.migrations.length,
      );
      console.log(`  ${block.manifest.slug.padEnd(22)} rolled back ${rolled.length}`);
    }

    // The real assertion. A down migration can succeed and still leave residue — a lingering
    // extension, a function, a type — that makes the up migration fail the second time. Only
    // re-applying proves the cycle is actually clean.
    console.log("\nRe-applying to prove the rollback left a clean slate:");
    await apply(pool, blocks);
    console.log("Rollback verified: every migration is genuinely reversible.");
    await resetPool();
    break;
  }

  case "check-views": {
    const pool = getPool();
    const blocks = await loadAll();
    const failures = [];

    console.log(`Querying v_status for ${blocks.length} blocks:`);
    for (const block of blocks) {
      const schema = block.manifest.schema;
      try {
        // Actually read it. A view that references a dropped column parses at creation and only
        // fails when someone selects from it, which in practice is during an incident.
        const { rows } = await pool.query(`SELECT * FROM "${schema}".v_status`);
        const columns = rows[0] ? Object.keys(rows[0]).length : 0;
        console.log(`  ${block.manifest.slug.padEnd(22)} ok (${columns} columns)`);
      } catch (err) {
        failures.push(`${schema}.v_status: ${err instanceof Error ? err.message : String(err)}`);
        console.log(`  ${block.manifest.slug.padEnd(22)} FAILED`);
      }
    }

    await resetPool();

    if (failures.length > 0) {
      console.error(`\n${failures.length} view(s) are not queryable:`);
      for (const failure of failures) console.error(`  ${failure}`);
      process.exit(1);
    }
    console.log("Every v_status view is queryable.");
    break;
  }

  default:
    console.error(
      "Usage: DATABASE_URL=... node scripts/ci-migrate.mjs <apply|verify-rollback|check-views>",
    );
    process.exit(1);
}
