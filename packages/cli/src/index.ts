/**
 * CLI implementation.
 *
 * Commands: list, info, add, migrate, verify. `verify` is the interesting one — it's what CI
 * runs to enforce the mechanical parts of docs/CONVENTIONS.md across all 25 blocks, so a
 * convention violation fails a pull request instead of being discovered by a user.
 */

import { readdir, readFile, access } from "node:fs/promises";
import path from "node:path";
import { loadManifest, ManifestError, type BlockManifest } from "./manifest.js";
import { loadMigrations } from "@neon-blocks/migrate";

export { loadManifest, parseManifest, ManifestError } from "./manifest.js";
export type { BlockManifest, TriggerSpec, EnvVarSpec, Capability } from "./manifest.js";

export interface DiscoveredBlock {
  manifest: BlockManifest;
  dir: string;
}

/** Load every block manifest, sorted by catalog rank. */
export async function discoverBlocks(blocksDir: string): Promise<DiscoveredBlock[]> {
  const entries = await readdir(blocksDir, { withFileTypes: true });
  const blocks: DiscoveredBlock[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(blocksDir, entry.name);
    const manifestPath = path.join(dir, "block.json");
    try {
      await access(manifestPath);
    } catch {
      continue;
    }
    const manifest = await loadManifest(manifestPath);
    if (manifest.slug !== entry.name) {
      throw new ManifestError(
        `${manifestPath}: slug "${manifest.slug}" does not match directory name "${entry.name}"`,
      );
    }
    blocks.push({ manifest, dir });
  }

  return blocks.sort((a, b) => a.manifest.rank - b.manifest.rank);
}

export interface VerifyProblem {
  block: string;
  rule: string;
  detail: string;
}

/**
 * Enforce the mechanically-checkable conventions.
 *
 * Each check maps to a numbered rule in docs/CONVENTIONS.md, and the message names the rule so
 * a failure teaches rather than merely blocks.
 */
export async function verifyBlocks(blocksDir: string): Promise<VerifyProblem[]> {
  const blocks = await discoverBlocks(blocksDir);
  const problems: VerifyProblem[] = [];
  const slugs = new Set(blocks.map((b) => b.manifest.slug));
  const ranks = new Map<number, string>();

  for (const { manifest, dir } of blocks) {
    const add = (rule: string, detail: string): void => {
      problems.push({ block: manifest.slug, rule, detail });
    };

    const duplicate = ranks.get(manifest.rank);
    if (duplicate) {
      add("catalog", `rank ${manifest.rank} is also claimed by "${duplicate}"`);
    }
    ranks.set(manifest.rank, manifest.slug);

    for (const dependency of manifest.dependsOn) {
      if (!slugs.has(dependency)) {
        add("dependsOn", `depends on unknown block "${dependency}"`);
      }
    }

    // §2 — every migration reversible, and the schema it creates is the one it claims.
    const migrations = await loadMigrations(path.join(dir, "migrations"));
    if (migrations.length === 0) {
      add("§2 migrations", "has no migrations; every block owns at least one schema");
    }
    for (const migration of migrations) {
      if (!migration.downSql) {
        add(
          "§2 reversible",
          `migration ${migration.version}_${migration.name}.sql has no matching .down.sql`,
        );
      }
    }

    const firstMigration = migrations[0];
    if (firstMigration && !firstMigration.upSql.includes(manifest.schema)) {
      add(
        "§1 schema",
        `first migration never mentions "${manifest.schema}"; a block must create its own schema`,
      );
    }

    // §1 — never touch another block's schema or the user's tables.
    for (const migration of migrations) {
      const foreign = [...migration.upSql.matchAll(/\bblocks_([a-z0-9_]+)\./g)]
        .map((m) => `blocks_${m[1]}`)
        .filter((s) => s !== manifest.schema && s !== "blocks_core");
      for (const schema of new Set(foreign)) {
        add(
          "§1 isolation",
          `migration ${migration.version} references foreign schema "${schema}"; ` +
            `cross-block access goes through the events/queue contracts`,
        );
      }
    }

    // §10 — observability is not optional.
    const hasStatusView = migrations.some((m) => /CREATE\s+(OR\s+REPLACE\s+)?VIEW\s+\S*v_status/i.test(m.upSql));
    if (!hasStatusView) {
      add("§10 observability", `no ${manifest.schema}.v_status view found in migrations`);
    }

    // §5 — anything trigger-driven needs a reconciliation sweeper, because storage triggers
    // are Beta with no delivery guarantee and no delete events.
    const hasStorageTrigger = manifest.triggers.some((t) => t.type === "storage_object_created");
    const hasSchedule = manifest.triggers.some((t) => t.type === "schedule");
    if (hasStorageTrigger && !hasSchedule) {
      add(
        "§5 reconciliation",
        "declares a storage trigger but no schedule trigger; storage delivery has no " +
          "guarantee and no delete events, so a cron sweeper is required for correctness",
      );
    }

    await verifyFiles(dir, manifest, add);
  }

  return problems;
}

async function verifyFiles(
  dir: string,
  manifest: BlockManifest,
  add: (rule: string, detail: string) => void,
): Promise<void> {
  for (const required of ["README.md", "src/index.ts", "package.json"]) {
    try {
      await access(path.join(dir, required));
    } catch {
      add("layout", `missing ${required}`);
    }
  }

  try {
    const handler = await readFile(path.join(dir, "src/index.ts"), "utf8");

    // §10 — every block answers /health.
    if (!handler.includes("/health")) {
      add("§10 observability", "src/index.ts does not register a /health route");
    }

    // §7 — a storage-triggered block must HEAD-verify, since trigger POSTs are forgeable.
    //
    // Checked across the whole src/ tree, not just index.ts: a well-factored block keeps the
    // pipeline in its own module, and flagging that would push people to inline everything into
    // the handler to satisfy the linter.
    if (manifest.triggers.some((t) => t.type === "storage_object_created")) {
      const sources = await readSourceTree(path.join(dir, "src"));
      if (!sources.some((source) => source.includes("headVerified"))) {
        add(
          "§7 untrusted input",
          "no source file calls headVerified(); trigger delivery is unauthenticated, so " +
            "object existence must be independently established before acting on an event",
        );
      }
    }
  } catch {
    // Missing src/index.ts already reported above.
  }
}

/** Read every .ts file under a directory, recursively. */
async function readSourceTree(dir: string): Promise<string[]> {
  const contents: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return contents;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) contents.push(...(await readSourceTree(full)));
    else if (entry.name.endsWith(".ts")) contents.push(await readFile(full, "utf8"));
  }
  return contents;
}

/** Render the install plan for a block: migrations, env vars, triggers, dependencies. */
export function formatInstallPlan(block: DiscoveredBlock, migrationCount: number): string {
  const { manifest } = block;
  const lines: string[] = [
    `${manifest.name} (${manifest.slug})  rank #${manifest.rank}  [${manifest.depth}]`,
    ``,
    manifest.summary,
    ``,
    `Schema:        ${manifest.schema}`,
    `Migrations:    ${migrationCount}`,
    `Billing:       ${manifest.billing}`,
    `Capabilities:  ${manifest.capabilities.join(", ") || "none"}`,
  ];

  if (manifest.dependsOn.length > 0) {
    lines.push(`Depends on:    ${manifest.dependsOn.join(", ")}`);
  }
  if (manifest.bundler === "none") {
    lines.push(
      ``,
      `NOTE: this block ships native binaries and cannot use the default esbuild bundle.`,
      `      Deploy with --no-bundle and a platform-matched node_modules (see its README).`,
    );
  }

  const configurable = manifest.env.filter((e) => !e.injected);
  if (configurable.length > 0) {
    lines.push(``, `Environment:`);
    for (const env of configurable) {
      const flag = env.required ? "required" : `optional, default ${env.default ?? "none"}`;
      lines.push(`  ${env.name}  (${flag})`, `    ${env.description}`);
    }
  }

  const injected = manifest.env.filter((e) => e.injected);
  if (injected.length > 0) {
    lines.push(``, `Injected by Neon (no action needed): ${injected.map((e) => e.name).join(", ")}`);
  }

  if (manifest.triggers.length > 0) {
    lines.push(``, `Triggers to create:`);
    for (const trigger of manifest.triggers) {
      if (trigger.type === "schedule") {
        lines.push(
          `  schedule  ${trigger.cron}  ->  ${trigger.functionPath}`,
          `    ${trigger.description}`,
        );
      } else {
        lines.push(
          `  storage   $${trigger.bucketEnv}  ->  ${trigger.functionPath}`,
          `    ${trigger.description}`,
        );
      }
    }
    lines.push(
      ``,
      `Reminder: child branches inherit triggers DISABLED. Enable them after promoting a`,
      `branch to production, or scheduled work will silently never run.`,
    );
  }

  return lines.join("\n");
}
