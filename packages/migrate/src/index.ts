/**
 * Migration runner.
 *
 * Convention §2: numbered, append-only, every up has a down. These run in production
 * databases, so "restore a backup" is not an uninstall story.
 */

import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Pool } from "pg";
import { getPool, withAdvisoryLock, withTransaction } from "@neon-blocks/core";

export interface Migration {
  /** Zero-padded numeric prefix, e.g. "001". */
  version: string;
  name: string;
  upSql: string;
  /** Absent only if the block has not yet written one — CI rejects that. */
  downSql: string | undefined;
  /** SHA-256 of upSql, used to detect edits to already-applied migrations. */
  checksum: string;
}

const MIGRATION_FILE = /^(\d{3,})_([a-z0-9_]+)\.sql$/;

/** Bootstrap for the ledger itself. Must be idempotent and self-contained. */
export const LEDGER_DDL = `
CREATE SCHEMA IF NOT EXISTS blocks_core;

CREATE TABLE IF NOT EXISTS blocks_core.migrations (
  block       text        NOT NULL,
  version     text        NOT NULL,
  name        text        NOT NULL,
  checksum    text        NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (block, version)
);
`;

/**
 * Load a block's migrations from disk, newest last.
 *
 * Rejects duplicate version numbers: two files both claiming 003 is a merge accident that
 * would otherwise apply in filesystem order and diverge between environments.
 */
export async function loadMigrations(dir: string): Promise<Migration[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const migrations: Migration[] = [];
  const seen = new Map<string, string>();

  for (const entry of entries.sort()) {
    if (entry.endsWith(".down.sql")) continue;
    const match = MIGRATION_FILE.exec(entry);
    if (!match) continue;

    const [, version, name] = match as unknown as [string, string, string];
    const previous = seen.get(version);
    if (previous) {
      throw new Error(
        `Duplicate migration version ${version} in ${dir}: "${previous}" and "${entry}". ` +
          `Renumber one — applying both in filesystem order diverges between environments.`,
      );
    }
    seen.set(version, entry);

    const upSql = await readFile(path.join(dir, entry), "utf8");
    const downSql = await readFileOrUndefined(path.join(dir, `${version}_${name}.down.sql`));

    migrations.push({
      version,
      name,
      upSql,
      downSql,
      checksum: createHash("sha256").update(upSql).digest("hex"),
    });
  }

  return migrations;
}

async function readFileOrUndefined(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export interface ApplyResult {
  applied: string[];
  skipped: string[];
  /** Migrations whose file changed after being applied. Never auto-repaired. */
  drifted: { version: string; name: string }[];
}

/**
 * Apply all pending migrations for a block.
 *
 * Each migration runs in its own transaction, so a failure halfway through a set leaves the
 * earlier ones applied and recorded — which is why they must be independently valid.
 *
 * Held under an advisory lock: two functions booting concurrently on the same branch would
 * otherwise race, and `CREATE TABLE IF NOT EXISTS` does not save you from two conflicting
 * `ALTER`s.
 */
export async function applyMigrations(
  pool: Pool,
  block: string,
  migrations: readonly Migration[],
): Promise<ApplyResult> {
  const result = await withAdvisoryLock(pool, `blocks_migrate:${block}`, async () => {
    await pool.query(LEDGER_DDL);

    const { rows } = await pool.query<{ version: string; checksum: string }>(
      `SELECT version, checksum FROM blocks_core.migrations WHERE block = $1`,
      [block],
    );
    const appliedChecksums = new Map(rows.map((r) => [r.version, r.checksum]));

    const outcome: ApplyResult = { applied: [], skipped: [], drifted: [] };

    for (const migration of migrations) {
      const existing = appliedChecksums.get(migration.version);

      if (existing !== undefined) {
        if (existing !== migration.checksum) {
          // Surfaced, never repaired: silently re-running an edited migration is how
          // environments diverge irreversibly.
          outcome.drifted.push({ version: migration.version, name: migration.name });
        }
        outcome.skipped.push(migration.version);
        continue;
      }

      await withTransaction(pool, async (client) => {
        await client.query(migration.upSql);
        await client.query(
          `INSERT INTO blocks_core.migrations (block, version, name, checksum)
           VALUES ($1, $2, $3, $4)`,
          [block, migration.version, migration.name, migration.checksum],
        );
      });
      outcome.applied.push(migration.version);
    }

    return outcome;
  });

  if (result === false) {
    throw new Error(
      `Could not acquire the migration lock for block "${block}" — another process is ` +
        `migrating it. Retry shortly.`,
    );
  }
  return result;
}

/**
 * Roll back the most recent `count` migrations, newest first.
 *
 * Refuses to start if any migration in range lacks a down script, rather than rolling back
 * partway and leaving the schema in a state no file describes.
 */
export async function rollbackMigrations(
  pool: Pool,
  block: string,
  migrations: readonly Migration[],
  count = 1,
): Promise<string[]> {
  const { rows } = await pool.query<{ version: string }>(
    `SELECT version FROM blocks_core.migrations
     WHERE block = $1 ORDER BY version DESC LIMIT $2`,
    [block, count],
  );

  const byVersion = new Map(migrations.map((m) => [m.version, m]));
  const targets = rows.map((r) => r.version);

  const missing = targets.filter((v) => !byVersion.get(v)?.downSql);
  if (missing.length > 0) {
    throw new Error(
      `Cannot roll back block "${block}": no down migration for version(s) ` +
        `${missing.join(", ")}. Convention §2 requires every migration to be reversible.`,
    );
  }

  const rolled: string[] = [];
  for (const version of targets) {
    const migration = byVersion.get(version)!;
    await withTransaction(pool, async (client) => {
      await client.query(migration.downSql!);
      await client.query(`DELETE FROM blocks_core.migrations WHERE block = $1 AND version = $2`, [
        block,
        version,
      ]);
    });
    rolled.push(version);
  }
  return rolled;
}

/**
 * Wrap a block's fetch handler so it applies the block's own migrations once, on the first request
 * of a cold start, before serving. This makes a bare function-deploy a complete install for an
 * independent block: the console ships code + env, and the handler brings its schema up to date
 * idempotently (checksummed, advisory-locked, recorded in blocks_core.migrations).
 *
 * `migrationsUrl` is resolved relative to the deployed entry — `new URL("./migrations/",
 * import.meta.url)` — because the bundle mounts with index.mjs and migrations/ as siblings at
 * /opt/function. The migration SQL must therefore travel inside the artifact.
 *
 * A block only applies its OWN migrations. Blocks with dependsOn still require their dependencies
 * installed first; the installer orders the stack (dependencies before dependents).
 */
export function autoMigrate(opts: {
  block: string;
  migrationsUrl: URL | string;
  fetch: (request: Request) => Promise<Response> | Response;
}): { fetch: (request: Request) => Promise<Response> } {
  let ready: Promise<void> | null = null;
  const ensure = (): Promise<void> => {
    if (!ready) {
      ready = (async () => {
        const dir =
          typeof opts.migrationsUrl === "string" ? opts.migrationsUrl : fileURLToPath(opts.migrationsUrl);
        const migrations = await loadMigrations(dir);
        await applyMigrations(getPool(), opts.block, migrations);
      })().catch((err) => {
        // Reset so a transient failure (e.g. the database briefly unreachable) retries next request
        // rather than wedging the process into a permanently un-migrated state.
        ready = null;
        throw err;
      });
    }
    return ready;
  };

  return {
    fetch: async (request: Request): Promise<Response> => {
      await ensure();
      return opts.fetch(request);
    },
  };
}
