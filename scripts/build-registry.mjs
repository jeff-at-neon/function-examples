#!/usr/bin/env node
/**
 * Build the Neon Function Registry.
 *
 * Emits a servable tree under dist-registry/: a registry.json discovery index plus, per block, a
 * self-describing template.json, the bundled handler (index.js — the operations' shared source),
 * the README, and the migrations. Conforms to schemas/{registry,template}.schema.json.
 *
 * Like build-release.mjs, artifacts are public and inert: bundled code and metadata, no credentials
 * of any kind. Regenerated from each block's block.json, so it never drifts from source.
 *
 *   node scripts/build-registry.mjs [--out dist-registry]
 */

import { mkdir, readFile, writeFile, rm, cp } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const outDir = path.resolve(root, argOf("--out", "dist-registry"));

const { discoverBlocks } = await import(path.join(root, "packages/cli/dist/index.js"));
const esbuild = await import("esbuild");

const SECRET_HINT = /SECRET|TOKEN|KEY|PASSWORD|CREDENTIAL/;

/** The template.json route pattern forbids ':', so express a path param as a plain segment. */
function sanitizeRoute(route) {
  return route.replace(/:/g, "").replace(/\/{2,}/g, "/");
}

function toEnvironment(env) {
  return env.map((e) => ({
    name: e.name,
    description: e.description,
    required: e.required === true,
    ...(SECRET_HINT.test(e.name) ? { secret: true } : {}),
    ...(e.injected === true ? { injected: true } : {}),
    ...(typeof e.default === "string" ? { default: e.default } : {}),
    ...(typeof e.example === "string" ? { example: e.example } : {}),
  }));
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const blocks = await discoverBlocks(path.join(root, "blocks"));
console.log(`Building registry for ${blocks.length} blocks\n`);

const templates = [];
let failures = 0;

for (const { manifest, dir } of blocks) {
  const id = manifest.slug;
  const templateDir = path.join(outDir, id);

  try {
    if (!Array.isArray(manifest.operations) || manifest.operations.length === 0) {
      throw new Error("manifest has no operations — cannot build a template");
    }

    await mkdir(templateDir, { recursive: true });

    // Bundle to a single standalone ESM file at the archive root, named index.mjs (the runtime tries
    // it first and always parses .mjs as ESM, so no package.json is needed). Everything is inlined —
    // including pg — because the guest is bare Node 24 with no node_modules; only node:* builtins and
    // pg's optional native/edge shims stay external.
    const result = await esbuild.build({
      entryPoints: [path.join(dir, "src/index.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      external: ["pg-native", "cloudflare:sockets"],
      keepNames: true,
      outfile: path.join(templateDir, "index.mjs"),
      logLevel: "silent",
    });
    if (result.errors.length > 0) throw new Error(result.errors.map((e) => e.text).join("; "));

    const bundle = await readFile(path.join(templateDir, "index.mjs"), "utf8");
    if (/@neon-blocks\//.test(bundle)) {
      throw new Error("bundle still references @neon-blocks/* — it is not self-contained");
    }
    if (/from\s*["']pg["']/.test(bundle)) {
      throw new Error("bundle still imports 'pg' — it must be inlined (the guest has no node_modules)");
    }

    // README + migrations travel with the template so it is self-describing, renderable, and — for
    // a self-migrating handler — the SQL is readable from /opt/function/migrations at runtime.
    const readme = await readFile(path.join(dir, "README.md"), "utf8").catch(() => "");
    if (readme) await writeFile(path.join(templateDir, "README.md"), readme);
    await cp(path.join(dir, "migrations"), path.join(templateDir, "migrations"), { recursive: true }).catch(() => {});

    const template = {
      $schema: "https://neon.com/functions/schemas/template.schema.json",
      id,
      provider: "neon",
      title: manifest.name,
      description: manifest.summary,
      dependencies: [],
      dependsOn: manifest.dependsOn ?? [],
      environment: toEnvironment(manifest.env),
      operations: manifest.operations.map((o) => ({
        id: o.id,
        title: o.title,
        description: o.description,
        source: "index.mjs",
        route: sanitizeRoute(o.route),
        recommended: o.recommended === true,
      })),
    };
    await writeFile(path.join(templateDir, "template.json"), `${JSON.stringify(template, null, 2)}\n`);

    // A deployable zip with index.mjs at the ROOT — the layout the nodejs24 runtime's resolveEntry
    // expects (no subdirectory search). Contains the entry, migrations, and display metadata; env
    // and secrets are NOT included (sent separately by the deploy API), keeping the artifact inert.
    await run("zip", ["-q", "-r", "-X", path.join(outDir, `${id}.zip`), "."], { cwd: templateDir });

    templates.push({
      rank: manifest.rank,
      entry: {
        id,
        provider: "neon",
        title: manifest.name,
        description: manifest.summary,
        dependsOn: manifest.dependsOn ?? [],
        path: `${id}/template.json`,
      },
    });

    console.log(
      `  ${id.padEnd(22)} ${String(Math.round(bundle.length / 1024)).padStart(4)}KB  ` +
        `${manifest.operations.length} op(s)`,
    );
  } catch (err) {
    failures++;
    console.error(`  ${id.padEnd(22)} FAILED: ${err instanceof Error ? err.message : err}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} block(s) failed to build.`);
  process.exit(1);
}

const registry = {
  $schema: "https://neon.com/functions/schemas/registry.schema.json",
  name: "neon-functions",
  homepage: "https://neon.com/docs/functions",
  templates: templates.sort((a, b) => a.rank - b.rank).map((t) => t.entry),
};
await writeFile(path.join(outDir, "registry.json"), `${JSON.stringify(registry, null, 2)}\n`);

console.log(
  `\nregistry.json + ${templates.length} template folders in ${path.relative(root, outDir)}/`,
);
console.log("Artifacts contain no credentials and can be served unauthenticated.");
