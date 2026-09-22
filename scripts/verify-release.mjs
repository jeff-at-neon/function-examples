#!/usr/bin/env node
/**
 * Verify release artifacts before publishing.
 *
 * Two properties the console-catalog model depends on entirely, so both are checked rather than
 * trusted:
 *
 *   1. **Self-contained.** An artifact must deploy without the monorepo present. If a bundle still
 *      references `@neon-blocks/*`, it fails at invoke with a module-not-found — after the user has
 *      already deployed it, which is the worst time to learn about a build problem.
 *
 *   2. **Credential-free.** Artifacts are served unauthenticated, so anything secret-shaped inside
 *      one is a disclosure. This is the property that lets the whole distribution model be simple,
 *      and it only stays true if something enforces it.
 *
 *   node scripts/verify-release.mjs [--dir dist-release]
 */

import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const dirIndex = args.indexOf("--dir");
const releaseDir = path.resolve(root, dirIndex >= 0 && args[dirIndex + 1] ? args[dirIndex + 1] : "dist-release");

const catalogPath = path.join(releaseDir, "catalog.json");
let catalog;
try {
  catalog = JSON.parse(await readFile(catalogPath, "utf8"));
} catch {
  console.error(`No catalog.json in ${path.relative(root, releaseDir)}. Run build-release.mjs first.`);
  process.exit(1);
}

console.log(`\nVerifying ${catalog.blockCount} artifacts at version ${catalog.release}\n`);

/**
 * Secret-shaped patterns. Deliberately narrow: this must not fire on the documentation strings that
 * legitimately describe credentials ("Object Storage access key. Injected automatically"), or every
 * release would fail on its own README.
 */
const SECRET_PATTERNS = [
  // Hyphens must be inside the class. Current OpenAI keys look like `sk-proj-<random>`, and a
  // class of [A-Za-z0-9] stops at "sk-proj" (7 chars) so the {20,} quantifier never matches —
  // which silently missed the most common key format in existence.
  [/\bsk-[A-Za-z0-9_-]{20,}/, "OpenAI-style API key"],
  [/\bwhsec_[A-Za-z0-9+/_-]{20,}/, "webhook signing secret"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key id"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "GitHub token"],
  // A connection string with a real-looking password. Excludes the postgres:postgres CI placeholder
  // and obvious templates.
  [/postgres(?:ql)?:\/\/(?!postgres:postgres@)[^:/\s]+:(?!password\b|user\b|<)[^@\s]{8,}@/, "database connection string with credentials"],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private key"],
];

let failures = 0;
const fail = (slug, message) => {
  console.log(`  \x1b[31m✗\x1b[0m ${slug.padEnd(22)} ${message}`);
  failures++;
};

const workDir = await mkdtemp(path.join(tmpdir(), "neon-blocks-verify-"));

try {
  const files = await readdir(releaseDir);
  const tarballs = files.filter((f) => f.endsWith(".tar.gz"));

  if (tarballs.length !== catalog.blockCount) {
    console.error(
      `catalog.json lists ${catalog.blockCount} blocks but ${tarballs.length} tarballs exist`,
    );
    process.exit(1);
  }

  for (const entry of catalog.blocks) {
    const tarball = path.join(releaseDir, entry.artifact.file);
    const extractTo = path.join(workDir, entry.slug);

    // Integrity first. A digest mismatch means the catalog and the artifacts disagree, and the
    // console would be verifying against the wrong value.
    const bytes = await readFile(tarball);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== entry.artifact.sha256) {
      fail(entry.slug, "sha256 does not match catalog.json");
      continue;
    }
    if (bytes.length !== entry.artifact.bytes) {
      fail(entry.slug, `size ${bytes.length} does not match catalog.json (${entry.artifact.bytes})`);
      continue;
    }

    await run("mkdir", ["-p", extractTo]);
    await run("tar", ["-xzf", tarball, "-C", extractTo]);

    // Required contents. A missing manifest or migration produces a deploy that half-works.
    const contents = await readdir(extractTo);
    for (const required of ["index.js", "block.json"]) {
      if (!contents.includes(required)) {
        fail(entry.slug, `missing ${required}`);
        continue;
      }
    }

    const bundle = await readFile(path.join(extractTo, "index.js"), "utf8");

    // Property 1: self-contained.
    if (/@neon-blocks\//.test(bundle)) {
      fail(entry.slug, "bundle references @neon-blocks/* — not self-contained");
      continue;
    }

    // Only runtime-provided modules may remain external. Anything else means the artifact needs an
    // npm install the deploy path does not perform.
    //
    // Anchored to line-start `import ... from "x"` rather than a bare `from "x"` search. The loose
    // version matched string *content* — a template literal like `${cfg.bucket}` and the phrase
    // "fix your card" both tripped it, because both contain `from "`-adjacent text inside strings.
    // A module specifier is also syntactically narrow, so requiring that shape removes the rest.
    const allowedExternals = new Set(["pg"]);
    const externals = [...bundle.matchAll(/^\s*(?:import|export)\s[^;]*?\bfrom\s*"([^"]+)"/gm)]
      .map((m) => m[1])
      .filter((spec) => !spec.startsWith(".") && !spec.startsWith("node:"))
      // A real specifier is a package name or path, never an interpolation or a sentence.
      .filter((spec) => /^(@[a-z0-9-~][\w.-]*\/)?[a-z0-9-~][\w.-]*(\/[\w.-]+)*$/i.test(spec));

    for (const spec of new Set(externals)) {
      if (!allowedExternals.has(spec)) {
        fail(entry.slug, `unexpected external dependency "${spec}" — the deploy path does not npm install`);
      }
    }

    // Property 2: credential-free. Checks every file in the artifact, including the README.
    for (const file of contents) {
      const filePath = path.join(extractTo, file);
      let text;
      try {
        text = await readFile(filePath, "utf8");
      } catch {
        continue; // a directory
      }
      for (const [pattern, label] of SECRET_PATTERNS) {
        const match = pattern.exec(text);
        if (match) {
          // Reports the pattern that fired and the location, never the matched value.
          fail(entry.slug, `possible ${label} in ${file} at offset ${match.index}`);
        }
      }
    }

    // Migrations must be present and reversible, matching the count the catalog advertises.
    const migrationDir = path.join(extractTo, "migrations");
    const migrations = await readdir(migrationDir).catch(() => []);
    const ups = migrations.filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"));
    const downs = migrations.filter((f) => f.endsWith(".down.sql"));

    if (ups.length !== entry.migrationCount) {
      fail(entry.slug, `${ups.length} migrations but catalog says ${entry.migrationCount}`);
    }
    if (downs.length !== ups.length) {
      fail(entry.slug, `${ups.length} up migrations but ${downs.length} down — not fully reversible`);
    }

    // The manifest must carry the version, since that is what the console pins against.
    const manifest = JSON.parse(await readFile(path.join(extractTo, "block.json"), "utf8"));
    if (manifest.version !== entry.version) {
      fail(entry.slug, `manifest version ${manifest.version} != catalog ${entry.version}`);
    }

    // Injected variables must never be presented as user input, or the console would prompt for a
    // credential Neon already supplies.
    const promptable = entry.config.filter((c) => !c.injected && c.required);
    const injected = entry.config.filter((c) => c.injected);
    if (injected.some((c) => !/^(DATABASE_URL|NEON_)/.test(c.name))) {
      fail(entry.slug, "a variable marked injected is not a recognised Neon-provided name");
    }

    console.log(
      `  \x1b[32m✓\x1b[0m ${entry.slug.padEnd(22)} ` +
        `${String(Math.round(bytes.length / 1024)).padStart(3)}KB  ` +
        `${ups.length} migration(s)  ` +
        `${promptable.length} field(s) to prompt  ` +
        `${injected.length} injected`,
    );
  }
} finally {
  await rm(workDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} problem(s) found. Not safe to publish.`);
  process.exit(1);
}

console.log(
  `\nAll ${catalog.blockCount} artifacts verified: self-contained, credential-free, reversible.`,
);
