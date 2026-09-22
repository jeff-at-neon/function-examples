#!/usr/bin/env node
/**
 * Block scaffold generator.
 *
 * Writes manifest, migrations, handler, and README from a per-block spec. Generated rather than
 * hand-written so the conventions hold *uniformly* across fifteen blocks — the same v_status shape,
 * the same reconciler pairing, the same health evaluation. Divergence between blocks is the thing
 * that makes a catalog feel like a pile of scripts.
 *
 * The specs below carry the block-specific substance: schema, the honest limits, and the design
 * notes. This is a one-shot authoring tool, not part of the build.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// Two levels up: this file lives in scripts/lib/.
const root = path.resolve(import.meta.dirname, "../..");

/**
 * @typedef {object} BlockSpec
 * @property {string} slug
 * @property {number} rank
 * @property {string} name
 * @property {string} summary
 * @property {"free"|"meter"} billing
 * @property {string[]} capabilities
 * @property {string[]} dependsOn
 * @property {string} why            Why this block exists / is ranked here.
 * @property {string[]} notes        Design decisions worth explaining.
 * @property {string[]} limits       Honest caveats.
 * @property {Array<{name:string,description:string,required?:boolean,default?:string,injected?:boolean,example?:string}>} env
 * @property {Array<{type:string,cron?:string,bucketEnv?:string,prefixEnv?:string,functionPath:string,description:string}>} triggers
 * @property {string} tables         SQL for the block's own tables.
 * @property {string} statusView     Body of the v_status view.
 * @property {string[]} dropOrder    Objects to drop, in order, for the down migration.
 * @property {Array<{method:string,path:string,purpose:string}>} routes
 * @property {string} handlerBody    Route registrations.
 * @property {string[]} imports      Extra imports for the handler.
 * @property {string} healthEval     Body of the health evaluate() callback.
 * @property {string} [downNote]     Warning for the down migration.
 */

const INJECTED_DB = {
  name: "DATABASE_URL",
  description: "Branch connection string. Injected automatically by Neon.",
  required: true,
  injected: true,
};
const INJECTED_STORAGE = [
  { name: "NEON_STORAGE_ENDPOINT", description: "Object Storage endpoint. Injected automatically by Neon.", required: true, injected: true },
  { name: "NEON_STORAGE_ACCESS_KEY_ID", description: "Object Storage access key. Injected automatically by Neon.", required: true, injected: true },
  { name: "NEON_STORAGE_SECRET_ACCESS_KEY", description: "Object Storage secret key. Injected automatically by Neon.", required: true, injected: true },
];
const INJECTED_AI = {
  name: "NEON_AI_GATEWAY_API_KEY",
  description: "AI Gateway credential. Injected automatically by Neon.",
  required: true,
  injected: true,
};
const TRIGGER_SECRET = {
  name: "NEON_BLOCKS_TRIGGER_SECRET",
  description: "Shared secret authenticating trigger delivery. Neon does not sign trigger POSTs.",
  required: false,
};


const HANDLER_TEMPLATE = (spec) => {
  const schema = `blocks_${spec.slug.replace(/-/g, "_")}`;
  const requiredEnv = spec.env.filter((e) => e.required && !e.injected).map((e) => e.name);
  const optionalEnv = spec.env.filter((e) => !e.required && e.default !== undefined && e.name !== "NEON_BLOCKS_TRIGGER_SECRET");

  const needsTrigger = spec.triggers.length > 0;
  const coreImports = [
    ...(needsTrigger ? ["assertTriggerAuthentic"] : []),
    ...(spec.handlerBody.includes("assertNoLoop") ? ["assertNoLoop"] : []),
    "checkHealth",
    "createLogger",
    "getPool",
    "json",
    "loadConfig",
    ...(spec.handlerBody.includes("NotFoundError") ? ["NotFoundError"] : []),
    ...(needsTrigger ? ["parseTriggerEvent"] : []),
    "problem",
    "Router",
    // Unconditional: the readJsonObject/requireString helpers emitted into every handler use it,
    // so conditioning on the route body alone misses it.
    "ValidationError",
  ];

  return `/**
 * Block ${spec.rank} — ${spec.name}.
 *
 * ${spec.summary}
 *
${spec.why.split("\n").map((l) => ` * ${l}`).join("\n")}
 *
 * Routes:
${spec.routes.map((r) => ` *   ${r.method.padEnd(6)} ${r.path.padEnd(22)} ${r.purpose}`).join("\n")}
 *
 * STATUS: scaffold. The schema, safety checks, and control flow are real; the marked TODO seams are
 * the remaining work. Endpoints that are not implemented return 501 with a specific explanation
 * rather than failing in a way that looks like a bug.
 */

import {
${coreImports.map((i) => `  ${i},`).join("\n")}
  type Logger,
} from "@neon-blocks/core";
${spec.imports.join("\n")}

const log: Logger = createLogger({ block: "${spec.slug}" });

const SPEC = {
  block: "${spec.slug}",${requiredEnv.length > 0 ? `\n  required: [${requiredEnv.map((e) => `"${e}"`).join(", ")}],` : ""}
  optional: {
${optionalEnv.map((e) => `    ${e.name}: ${JSON.stringify(e.default)},`).join("\n")}
  },
} as const;

function config() {
  return loadConfig(SPEC);
}

const router = new Router();
${spec.handlerBody}

router.get("/health", async () => {
  const report = await checkHealth(getPool(), {
    block: "${spec.slug}",
    schema: "${schema}",
    evaluate: (status) => {
      const problems: string[] = [];
${spec.healthEval}
      return problems;
    },
  });

  return json(report, { status: report.status === "ok" ? 200 : 503 });
});

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new ValidationError("Request body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value === "") {
    throw new ValidationError(\`"\${key}" is required and must be a non-empty string\`);
  }
  return value;
}

export default {
  fetch: (request: Request): Promise<Response> => router.handle(request),
};
`;
};

async function generate(spec) {
  const dir = path.join(root, "blocks", spec.slug);
  const schema = `blocks_${spec.slug.replace(/-/g, "_")}`;

  await mkdir(path.join(dir, "src"), { recursive: true });
  await mkdir(path.join(dir, "migrations"), { recursive: true });

  // Manifest
  await writeFile(
    path.join(dir, "block.json"),
    `${JSON.stringify(
      {
        slug: spec.slug,
        rank: spec.rank,
        name: spec.name,
        summary: spec.summary,
        schema,
        billing: spec.billing,
        depth: "scaffold",
        capabilities: spec.capabilities,
        dependsOn: spec.dependsOn,
        env: spec.env,
        triggers: spec.triggers,
      },
      null,
      2,
    )}\n`,
  );

  // package.json
  const deps = {
    "@neon-blocks/core": "0.1.0",
    ...(spec.capabilities.includes("object_storage") ? { "@neon-blocks/storage": "0.1.0" } : {}),
    ...(spec.capabilities.includes("ai_gateway") ? { "@neon-blocks/ai": "0.1.0" } : {}),
    ...(spec.dependsOn.includes("queue") ? { "@neon-blocks/queue": "0.1.0", "@neon-blocks/events": "0.1.0" } : {}),
  };
  await writeFile(
    path.join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: `@neon-blocks/block-${spec.slug}`,
        version: "0.1.0",
        private: true,
        description: `Neon Block: ${spec.name.toLowerCase()}.`,
        license: "Apache-2.0",
        type: "module",
        main: "./dist/index.js",
        dependencies: deps,
      },
      null,
      2,
    )}\n`,
  );

  const refs = [
    { path: "../../packages/core" },
    ...(deps["@neon-blocks/storage"] ? [{ path: "../../packages/storage" }] : []),
    ...(deps["@neon-blocks/ai"] ? [{ path: "../../packages/ai" }] : []),
    ...(deps["@neon-blocks/queue"] ? [{ path: "../../packages/queue" }, { path: "../../packages/events" }] : []),
  ];
  await writeFile(
    path.join(dir, "tsconfig.json"),
    `${JSON.stringify(
      {
        extends: "../../tsconfig.base.json",
        compilerOptions: { rootDir: "src", outDir: "dist" },
        include: ["src/**/*.ts"],
        references: refs,
      },
      null,
      2,
    )}\n`,
  );

  // Migration
  const migrationName = `001_${spec.slug.replace(/-/g, "_")}`;
  await writeFile(
    path.join(dir, "migrations", `${migrationName}.sql`),
    `-- Block ${spec.rank}: ${spec.name.toLowerCase()}.
--
${spec.why.split("\n").map((l) => `-- ${l}`).join("\n")}

CREATE SCHEMA IF NOT EXISTS ${schema};
${spec.tables}

-- ---------------------------------------------------------------------------
-- Observability (§10)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW ${schema}.v_status AS
SELECT${spec.statusView}${spec.statusView.includes("FROM") ? "" : ";"}
${spec.statusView.includes("FROM") ? ";" : ""}
`,
  );

  await writeFile(
    path.join(dir, "migrations", `${migrationName}.down.sql`),
    `-- Reverse ${migrationName}.
${spec.downNote ? `--\n-- ${spec.downNote}\n` : ""}
DROP VIEW IF EXISTS ${schema}.v_status;
${spec.dropOrder.map((o) => `DROP ${o.startsWith("TABLE") || o.startsWith("VIEW") || o.startsWith("FUNCTION") ? o : `TABLE ${o}`} CASCADE;`).map((l) => l.replace("DROP TABLE", "DROP TABLE IF EXISTS").replace("DROP VIEW", "DROP VIEW IF EXISTS").replace("DROP FUNCTION", "DROP FUNCTION IF EXISTS")).join("\n")}
DROP SCHEMA IF EXISTS ${schema} CASCADE;
`,
  );

  await writeFile(path.join(dir, "src", "index.ts"), HANDLER_TEMPLATE(spec));

  // README
  const envRows = spec.env
    .filter((e) => !e.injected)
    .map((e) => `| \`${e.name}\` | ${e.required ? "*required*" : `\`${e.default ?? ""}\``} | ${e.description} |`)
    .join("\n");

  await writeFile(
    path.join(dir, "README.md"),
    `# Block ${spec.rank} — ${spec.name}

${spec.summary}

**Block ${spec.rank} of 25**, numbered in build order.

> **Status: scaffold.** Schema, safety checks, and control flow are real and reviewable. The marked
> \`TODO\` seams are the remaining work, and unimplemented endpoints return \`501\` with a specific
> explanation rather than failing in a way that looks like a bug.

## Why this block

${spec.why}

## Install

\`\`\`bash
neon-blocks migrate ${spec.slug}
neon function deploy ${spec.slug} --src blocks/${spec.slug}/src
${spec.triggers
  .map((t) =>
    t.type === "schedule"
      ? `neon triggers create --function-slug ${spec.slug} --name ${spec.slug}-${t.functionPath.slice(1)} \\\n  --schedule '${t.cron}' --function-path '${t.functionPath}'`
      : `neon triggers create --function-slug ${spec.slug} --name ${spec.slug}-${t.functionPath.slice(1)} \\\n  --bucket "$${t.bucketEnv}" --function-path '${t.functionPath}'`,
  )
  .join("\n")}
\`\`\`
${spec.triggers.some((t) => t.type === "schedule") ? `
> Child branches inherit triggers **disabled**. Enable them after promoting, or scheduled work
> silently never runs.
` : ""}
## Design notes

${spec.notes.map((n) => `- ${n}`).join("\n")}

## API

| Route | Purpose |
|---|---|
${spec.routes.map((r) => `| \`${r.method} ${r.path}\` | ${r.purpose} |`).join("\n")}
| \`GET /health\` | \`200\` / \`503\`. |

## Configuration

| Variable | Default | Notes |
|---|---|---|
${envRows}

${spec.env.some((e) => e.injected) ? `Injected automatically by Neon: ${spec.env.filter((e) => e.injected).map((e) => `\`${e.name}\``).join(", ")}.` : ""}

## Limits and honest caveats

${spec.limits.map((l) => `- ${l}`).join("\n")}
- **Unverified against a live Neon project.** Nothing in this repo has been run against real Neon
  infrastructure yet.

## Observability

\`\`\`sql
SELECT * FROM ${schema}.v_status;
\`\`\`

## Uninstall

\`\`\`bash
neon-blocks rollback ${spec.slug}
\`\`\`
${spec.downNote ? `\n**${spec.downNote}**\n` : ""}`,
  );

  return spec.slug;
}


export { generate, INJECTED_DB, INJECTED_STORAGE, INJECTED_AI, TRIGGER_SECRET };
