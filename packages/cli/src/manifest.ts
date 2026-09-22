/**
 * Block manifest schema and validation.
 *
 * The manifest is the contract the CLI reads to know what to install, what env vars to stub,
 * and which triggers to create. Validated strictly, because a typo here becomes a confusing
 * runtime failure in a user's project rather than an obvious error in ours.
 */

import { readFile } from "node:fs/promises";

export type BillingPosture = "free" | "meter";
export type Capability =
  | "postgres"
  | "pgvector"
  | "object_storage"
  | "ai_gateway"
  | "neon_auth"
  | "data_api"
  | "branching"
  | "custom_domain";

export interface TriggerSpec {
  type: "schedule" | "storage_object_created";
  /** Route on the function this trigger posts to. */
  functionPath: string;
  /** Five-field UTC cron. Required for schedule triggers. */
  cron?: string;
  /** Env var naming the bucket to watch. Required for storage triggers. */
  bucketEnv?: string;
  prefixEnv?: string;
  description: string;
}

export interface EnvVarSpec {
  name: string;
  description: string;
  required: boolean;
  default?: string;
  /** True when Neon injects this automatically; the CLI won't prompt for it. */
  injected?: boolean;
  example?: string;
}

export interface BlockManifest {
  slug: string;
  /** Rank in docs/CATALOG.md. Also the build order. */
  rank: number;
  name: string;
  summary: string;
  /** Owned schema. Must be `blocks_<slug with underscores>`. */
  schema: string;
  billing: BillingPosture;
  capabilities: Capability[];
  env: EnvVarSpec[];
  triggers: TriggerSpec[];
  /** Other block slugs this one needs installed. */
  dependsOn: string[];
  /** "none" when the block ships native binaries and cannot use the esbuild bundle. */
  bundler?: "esbuild" | "none";
  /** Implementation depth, surfaced in the README status table. */
  depth: "implemented" | "scaffold";
}

export class ManifestError extends Error {
  override readonly name = "ManifestError";
}

const CAPABILITIES: readonly Capability[] = [
  "postgres",
  "pgvector",
  "object_storage",
  "ai_gateway",
  "neon_auth",
  "data_api",
  "branching",
  "custom_domain",
];

/**
 * Parse and validate a manifest.
 *
 * Checks the schema-naming rule (convention §1) mechanically, because a block that quietly
 * uses the wrong schema name breaks the "install 25 blocks, no collisions" guarantee that
 * makes the catalog usable.
 */
export function parseManifest(raw: unknown, source: string): BlockManifest {
  if (typeof raw !== "object" || raw === null) {
    throw new ManifestError(`${source}: manifest is not an object`);
  }
  const m = raw as Record<string, unknown>;
  const problems: string[] = [];

  const str = (key: string): string => {
    const value = m[key];
    if (typeof value !== "string" || value === "") {
      problems.push(`${key} must be a non-empty string`);
      return "";
    }
    return value;
  };

  const slug = str("slug");
  const schema = str("schema");
  const name = str("name");
  const summary = str("summary");

  if (slug && !/^[a-z][a-z0-9-]*$/.test(slug)) {
    problems.push(`slug "${slug}" must be lowercase kebab-case`);
  }

  const expectedSchema = `blocks_${slug.replace(/-/g, "_")}`;
  if (slug && schema && schema !== expectedSchema) {
    problems.push(
      `schema "${schema}" must be "${expectedSchema}" — convention §1 requires one ` +
        `namespaced schema per block so 25 blocks can coexist without collisions`,
    );
  }

  const rank = m["rank"];
  if (typeof rank !== "number" || !Number.isInteger(rank) || rank < 1) {
    problems.push("rank must be a positive integer matching docs/CATALOG.md");
  }

  const billing = m["billing"];
  if (billing !== "free" && billing !== "meter") {
    problems.push(`billing must be "free" or "meter", got ${JSON.stringify(billing)}`);
  }

  const capabilities = asArray(m["capabilities"], "capabilities", problems);
  for (const capability of capabilities) {
    if (!CAPABILITIES.includes(capability as Capability)) {
      problems.push(
        `unknown capability ${JSON.stringify(capability)}; expected one of ${CAPABILITIES.join(", ")}`,
      );
    }
  }

  const depth = m["depth"];
  if (depth !== "implemented" && depth !== "scaffold") {
    problems.push(`depth must be "implemented" or "scaffold", got ${JSON.stringify(depth)}`);
  }

  const env = validateEnv(m["env"], problems);
  const triggers = validateTriggers(m["triggers"], problems);

  if (problems.length > 0) {
    throw new ManifestError(`${source} is invalid:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }

  return {
    slug,
    rank: rank as number,
    name,
    summary,
    schema,
    billing: billing as BillingPosture,
    capabilities: capabilities as Capability[],
    env,
    triggers,
    dependsOn: asArray(m["dependsOn"], "dependsOn", problems) as string[],
    bundler: (m["bundler"] as BlockManifest["bundler"]) ?? "esbuild",
    depth: depth as BlockManifest["depth"],
  };
}

function asArray(value: unknown, key: string, problems: string[]): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push(`${key} must be an array`);
    return [];
  }
  return value;
}

function validateEnv(value: unknown, problems: string[]): EnvVarSpec[] {
  const entries = asArray(value, "env", problems);
  return entries.flatMap((entry, i): EnvVarSpec[] => {
    if (typeof entry !== "object" || entry === null) {
      problems.push(`env[${i}] must be an object`);
      return [];
    }
    const e = entry as Record<string, unknown>;
    if (typeof e["name"] !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(e["name"])) {
      problems.push(`env[${i}].name must be SCREAMING_SNAKE_CASE`);
      return [];
    }
    if (typeof e["description"] !== "string" || e["description"] === "") {
      // Enforced because an undocumented env var is indistinguishable from a bug when a
      // user hits it.
      problems.push(`env[${i}] (${e["name"]}) needs a description`);
    }
    return [
      {
        name: e["name"],
        description: String(e["description"] ?? ""),
        required: e["required"] === true,
        ...(typeof e["default"] === "string" ? { default: e["default"] } : {}),
        ...(e["injected"] === true ? { injected: true } : {}),
        ...(typeof e["example"] === "string" ? { example: e["example"] } : {}),
      },
    ];
  });
}

function validateTriggers(value: unknown, problems: string[]): TriggerSpec[] {
  const entries = asArray(value, "triggers", problems);
  return entries.flatMap((entry, i): TriggerSpec[] => {
    if (typeof entry !== "object" || entry === null) {
      problems.push(`triggers[${i}] must be an object`);
      return [];
    }
    const t = entry as Record<string, unknown>;
    const type = t["type"];

    if (type !== "schedule" && type !== "storage_object_created") {
      problems.push(
        `triggers[${i}].type must be "schedule" or "storage_object_created" — those are the ` +
          `only types Neon has shipped`,
      );
      return [];
    }

    if (type === "schedule") {
      const cron = t["cron"];
      if (typeof cron !== "string") problems.push(`triggers[${i}] (schedule) needs a cron field`);
      else if (cron.trim().split(/\s+/).length !== 5) {
        problems.push(
          `triggers[${i}].cron "${cron}" must have exactly five fields; Neon uses ` +
            `five-field UTC cron`,
        );
      }
    }

    if (type === "storage_object_created" && typeof t["bucketEnv"] !== "string") {
      problems.push(
        `triggers[${i}] (storage) needs bucketEnv naming the env var that holds the bucket`,
      );
    }

    const functionPath = t["functionPath"];
    if (typeof functionPath !== "string" || !functionPath.startsWith("/")) {
      problems.push(`triggers[${i}].functionPath must be a path starting with "/"`);
    }

    return [
      {
        type,
        functionPath: String(functionPath ?? "/"),
        description: String(t["description"] ?? ""),
        ...(typeof t["cron"] === "string" ? { cron: t["cron"] } : {}),
        ...(typeof t["bucketEnv"] === "string" ? { bucketEnv: t["bucketEnv"] } : {}),
        ...(typeof t["prefixEnv"] === "string" ? { prefixEnv: t["prefixEnv"] } : {}),
      },
    ];
  });
}

export async function loadManifest(file: string): Promise<BlockManifest> {
  const raw = await readFile(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ManifestError(
      `${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseManifest(parsed, file);
}
