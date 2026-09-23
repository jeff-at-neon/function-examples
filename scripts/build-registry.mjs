#!/usr/bin/env node
/**
 * Build the Neon Function Registry.
 *
 * Emits a servable tree under dist-registry/: a registry.json discovery index plus each native
 * block or lightweight source template. Conforms to schemas/{registry,template}.schema.json.
 *
 * Artifacts are public and inert: bundled code and metadata, no credentials
 * of any kind. Regenerated from blocks/ and templates/, so it never drifts from source.
 *
 *   node scripts/build-registry.mjs [--out dist-registry]
 */

import { mkdir, readFile, writeFile, rm, cp, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
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

// ESM output can't service the dynamic require()s that CommonJS deps (pg and friends) make of Node
// builtins — esbuild's shim throws "Dynamic require of X is not supported" at load, killing the
// deploy before it runs. Give the bundle a real require via createRequire, plus the __filename/
// __dirname globals CJS deps expect. esbuild's __require shim delegates to this when it exists.
const ESM_REQUIRE_BANNER = [
  "import { createRequire as __createRequire } from 'node:module';",
  "import { fileURLToPath as __fileURLToPath } from 'node:url';",
  "import { dirname as __pathDirname } from 'node:path';",
  "const require = __createRequire(import.meta.url);",
  "const __filename = __fileURLToPath(import.meta.url);",
  "const __dirname = __pathDirname(__filename);",
].join("\n");

/** The template.json route pattern forbids ':', so express a path param as a plain segment. */
function sanitizeRoute(route) {
  return route.replace(/:/g, "").replace(/\/{2,}/g, "/");
}

/** Neon function_slug: 1-20 lowercase alphanumerics, no hyphens. Must match scripts/deploy.mjs. */
function functionSlugFor(blockSlug) {
  const slug = blockSlug.replace(/-/g, "").slice(0, 20).toLowerCase();
  if (!/^[a-z0-9]{1,20}$/.test(slug)) {
    throw new Error(`Cannot derive a legal function_slug from "${blockSlug}"`);
  }
  return slug;
}

/** Data type of a variable, inferred from its default (falls back to string). */
function inferType(e) {
  const d = typeof e.default === "string" ? e.default.trim() : undefined;
  if (d !== undefined && d !== "") {
    if (/^-?\d+$/.test(d)) return "int";
    if (Number.isFinite(Number(d))) return "number";
    if (d === "true" || d === "false") return "boolean";
    if (/^[[{]/.test(d)) return "json";
  }
  return "string";
}

/** Which form control the console should render. Vocabulary: bucket|schedule|json|number|secret|text. */
function inferWidget(e, type, secret) {
  if (secret) return "secret";
  if (/_BUCKET$/.test(e.name)) return "bucket";
  if (/CRON|_SCHEDULE$/.test(e.name)) return "schedule";
  if (type === "json") return "json";
  if (type === "int" || type === "number") return "number";
  return "text";
}

function toEnvironment(env) {
  return env.map((e) => {
    const secret = SECRET_HINT.test(e.name);
    const type = inferType(e);
    return {
      name: e.name,
      description: e.description,
      required: e.required === true,
      ...(secret ? { secret: true } : {}),
      ...(e.injected === true ? { injected: true } : {}),
      ...(typeof e.default === "string" ? { default: e.default } : {}),
      ...(typeof e.example === "string" ? { example: e.example } : {}),
      type,
      widget: inferWidget(e, type, secret),
    };
  });
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
      banner: { js: ESM_REQUIRE_BANNER },
      outfile: path.join(templateDir, "index.mjs"),
      logLevel: "silent",
    });
    if (result.errors.length > 0) throw new Error(result.errors.map((e) => e.text).join("; "));

    const indexPath = path.join(templateDir, "index.mjs");
    const bundle = await readFile(indexPath, "utf8");
    if (/@neon-blocks\//.test(bundle)) {
      throw new Error("bundle still references @neon-blocks/* — it is not self-contained");
    }
    if (/from\s*["']pg["']/.test(bundle)) {
      throw new Error("bundle still imports 'pg' — it must be inlined (the guest has no node_modules)");
    }

    // Load-check: import the bundle the way the runtime does (await import), catching load-time
    // failures — e.g. "Dynamic require of X is not supported" — before publishing a broken zip.
    const check =
      `import(${JSON.stringify(indexPath)})` +
      `.then((m) => { if (typeof m.default?.fetch !== "function") { console.error("no default.fetch export"); process.exit(3); } })` +
      `.catch((e) => { console.error(e && e.message ? e.message : e); process.exit(3); });`;
    await run("node", ["--input-type=module", "-e", check]).catch((err) => {
      throw new Error(`bundle failed to load as ESM: ${String(err.stderr || err.message).trim()}`);
    });

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
      depth: manifest.depth,
      dependencies: [],
      dependsOn: manifest.dependsOn ?? [],
      triggers: manifest.triggers ?? [],
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
    //
    // Reproducible: fix every entry's mtime to a constant and zip a sorted file list with -X (no
    // extra attributes). Otherwise the archive embeds build-time timestamps, so identical content
    // yields a different sha on every republish and integrity verification is meaningless.
    await run("find", [".", "-exec", "touch", "-t", "202001010000", "{}", "+"], { cwd: templateDir });
    const { stdout: fileList } = await run("sh", ["-c", "find . -type f | LC_ALL=C sort"], { cwd: templateDir });
    const files = fileList.split("\n").filter((f) => f !== "");
    await run("zip", ["-q", "-X", "-D", path.join(outDir, `${id}.zip`), ...files], { cwd: templateDir });

    // Digest + size for the console's integrity check and download UI.
    const zipContents = await readFile(path.join(outDir, `${id}.zip`));
    const sha256 = createHash("sha256").update(zipContents).digest("hex");

    // Card-level fields live in the index so the console can render the browse grid from one fetch
    // (id, title, description, depth, billing, capabilities badges) and deploy from it (functionSlug,
    // zip, sha256) without fetching every template.json.
    templates.push({
      rank: manifest.rank,
      entry: {
        id,
        provider: "neon",
        title: manifest.name,
        description: manifest.summary,
        depth: manifest.depth,
        billing: manifest.billing,
        capabilities: manifest.capabilities ?? [],
        dependsOn: manifest.dependsOn ?? [],
        functionSlug: functionSlugFor(id),
        path: `${id}/template.json`,
        zip: `${id}.zip`,
        sha256,
        bytes: zipContents.byteLength,
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

const lightweightRoot = path.join(root, "templates");
const lightweightDirs = await readdir(lightweightRoot, { withFileTypes: true }).catch(() => []);

for (const entry of lightweightDirs.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  const dir = path.join(lightweightRoot, entry.name);

  try {
    const template = JSON.parse(await readFile(path.join(dir, "template.json"), "utf8"));
    if (template.id !== entry.name) {
      throw new Error(`template id "${template.id}" must match directory "${entry.name}"`);
    }
    if (templates.some((candidate) => candidate.entry.id === template.id)) {
      throw new Error(`template id "${template.id}" conflicts with an existing block`);
    }

    const templateDir = path.join(outDir, template.id);
    await cp(dir, templateDir, { recursive: true });
    const { logo, ...publishedTemplate } = template;
    await writeFile(path.join(templateDir, "template.json"), `${JSON.stringify(publishedTemplate, null, 2)}\n`);

    templates.push({
      rank: Number.MAX_SAFE_INTEGER,
      entry: {
        id: template.id,
        ...(template.provider ? { provider: template.provider } : {}),
        title: template.title,
        description: template.description,
        path: `${template.id}/template.json`,
        ...(logo ? { logo } : {}),
      },
    });

    console.log(`  ${template.id.padEnd(22)} source  ${template.operations?.length ?? 0} op(s)`);
  } catch (err) {
    failures++;
    console.error(`  ${entry.name.padEnd(22)} FAILED: ${err instanceof Error ? err.message : err}`);
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
