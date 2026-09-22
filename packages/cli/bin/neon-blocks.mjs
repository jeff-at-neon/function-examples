#!/usr/bin/env node
/**
 * neon-blocks CLI entry point.
 *
 * Plain .mjs so it runs from a checkout without a build step — a contributor's first command
 * shouldn't be `npm run build`.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const blocksDir = path.join(repoRoot, "blocks");

const USAGE = `neon-blocks — reusable Neon Functions

Usage:
  neon-blocks list                    List all blocks by catalog rank
  neon-blocks info <slug>             Show a block's install plan
  neon-blocks add <slug>              Print install steps for a block
  neon-blocks verify                  Check every block against docs/CONVENTIONS.md
  neon-blocks migrate <slug>          Apply a block's migrations (needs DATABASE_URL)
  neon-blocks rollback <slug> [n]     Roll back a block's last n migrations

Run from a checkout of the neon-blocks repo.
`;

async function loadCli() {
  // Prefer compiled output; fall back to a clear message rather than a cryptic import error.
  try {
    return await import(path.join(repoRoot, "packages/cli/dist/index.js"));
  } catch (err) {
    console.error(
      "The CLI has not been built yet. Run `npm run typecheck` from the repo root first.\n" +
        `(${err.message})`,
    );
    process.exit(1);
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return;
  }

  const cli = await loadCli();

  switch (command) {
    case "list": {
      const blocks = await cli.discoverBlocks(blocksDir);
      const width = Math.max(...blocks.map((b) => b.manifest.slug.length));
      for (const { manifest } of blocks) {
        const rank = String(manifest.rank).padStart(2);
        const slug = manifest.slug.padEnd(width);
        const depth = manifest.depth === "implemented" ? "impl " : "scaff";
        const money = manifest.billing === "meter" ? "$" : " ";
        process.stdout.write(`${rank}. ${slug}  ${depth} ${money}  ${manifest.summary}\n`);
      }
      return;
    }

    case "info":
    case "add": {
      const slug = args[0];
      if (!slug) {
        console.error(`Usage: neon-blocks ${command} <slug>`);
        process.exit(1);
      }
      const blocks = await cli.discoverBlocks(blocksDir);
      const block = blocks.find((b) => b.manifest.slug === slug);
      if (!block) {
        console.error(
          `Unknown block "${slug}". Run \`neon-blocks list\` to see all ${blocks.length}.`,
        );
        process.exit(1);
      }

      const { loadMigrations } = await import(path.join(repoRoot, "packages/migrate/dist/index.js"));
      const migrations = await loadMigrations(path.join(block.dir, "migrations"));
      process.stdout.write(`${cli.formatInstallPlan(block, migrations.length)}\n`);

      if (command === "add") {
        process.stdout.write(
          `\nInstall:\n` +
            `  1. neon-blocks migrate ${slug}\n` +
            `  2. Set the environment variables listed above\n` +
            `  3. Deploy: neon function deploy ${slug} --src blocks/${slug}/src\n` +
            (block.manifest.triggers.length > 0
              ? `  4. Create the triggers listed above with \`neon triggers create\`\n`
              : ""),
        );
      }
      return;
    }

    case "verify": {
      const problems = await cli.verifyBlocks(blocksDir);
      if (problems.length === 0) {
        const blocks = await cli.discoverBlocks(blocksDir);
        process.stdout.write(`All ${blocks.length} blocks satisfy the conventions.\n`);
        return;
      }
      for (const problem of problems) {
        process.stderr.write(`${problem.block}: [${problem.rule}] ${problem.detail}\n`);
      }
      process.stderr.write(`\n${problems.length} convention violation(s).\n`);
      process.exit(1);
    }

    case "migrate":
    case "rollback": {
      const slug = args[0];
      if (!slug) {
        console.error(`Usage: neon-blocks ${command} <slug>`);
        process.exit(1);
      }
      if (!process.env.DATABASE_URL) {
        console.error(
          "DATABASE_URL is not set. Point it at the Neon branch you want to migrate.\n" +
            "Tip: use a child branch first — it is free and disposable.",
        );
        process.exit(1);
      }

      const { loadMigrations, applyMigrations, rollbackMigrations } = await import(
        path.join(repoRoot, "packages/migrate/dist/index.js")
      );
      const { getPool, resetPool } = await import(path.join(repoRoot, "packages/core/dist/index.js"));

      const migrations = await loadMigrations(path.join(blocksDir, slug, "migrations"));
      const pool = getPool();
      try {
        if (command === "migrate") {
          const result = await applyMigrations(pool, slug, migrations);
          process.stdout.write(
            `applied: ${result.applied.join(", ") || "none"}\n` +
              `skipped: ${result.skipped.length}\n`,
          );
          if (result.drifted.length > 0) {
            process.stderr.write(
              `\nWARNING: these migrations changed after being applied:\n` +
                result.drifted.map((d) => `  ${d.version}_${d.name}`).join("\n") +
                `\nAlready-applied migrations are append-only (convention §2). Add a new ` +
                `migration instead of editing one.\n`,
            );
            process.exit(1);
          }
        } else {
          const count = Number(args[1] ?? "1");
          const rolled = await rollbackMigrations(pool, slug, migrations, count);
          process.stdout.write(`rolled back: ${rolled.join(", ") || "none"}\n`);
        }
      } finally {
        await resetPool();
      }
      return;
    }

    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
