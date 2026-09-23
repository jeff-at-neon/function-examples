#!/usr/bin/env node
/**
 * Validate a built registry against the vendored JSON Schemas.
 *
 * A dependency-free checker covering the JSON-Schema subset the two schemas use (type, required,
 * properties, additionalProperties, items, pattern, const, minLength/maxLength, minItems/maxItems,
 * contains, format:uri) — enough to fully validate schemas/{registry,template}.schema.json without
 * pulling ajv (npm is constrained here). Plus cross-checks the schemas cannot express: every
 * template path resolves, and every operation source file exists in its folder.
 *
 *   node scripts/validate-registry.mjs [--dir dist-registry]
 */

import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const dir = path.resolve(root, argOf("--dir", "dist-registry"));

const registrySchema = JSON.parse(await readFile(path.join(root, "schemas/registry.schema.json"), "utf8"));
const templateSchema = JSON.parse(await readFile(path.join(root, "schemas/template.schema.json"), "utf8"));

function validate(data, schema, ctx, errors) {
  if (schema.type) {
    const t = schema.type;
    const ok =
      t === "object" ? typeof data === "object" && data !== null && !Array.isArray(data)
      : t === "array" ? Array.isArray(data)
      : t === "string" ? typeof data === "string"
      : t === "boolean" ? typeof data === "boolean"
      : t === "number" ? typeof data === "number"
      : true;
    if (!ok) {
      errors.push(`${ctx}: expected ${t}`);
      return;
    }
  }
  if (schema.const !== undefined && data !== schema.const) {
    errors.push(`${ctx}: must equal ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(data)) {
    errors.push(`${ctx}: must be one of ${schema.enum.join(", ")}`);
  }
  if (typeof data === "string") {
    if (schema.minLength !== undefined && data.length < schema.minLength) errors.push(`${ctx}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && data.length > schema.maxLength) errors.push(`${ctx}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(data)) errors.push(`${ctx}: "${data}" does not match ${schema.pattern}`);
    if (schema.format === "uri") {
      try {
        new URL(data);
      } catch {
        errors.push(`${ctx}: not a valid uri`);
      }
    }
  }
  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) errors.push(`${ctx}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && data.length > schema.maxItems) errors.push(`${ctx}: more than ${schema.maxItems} items`);
    if (schema.items) data.forEach((v, i) => validate(v, schema.items, `${ctx}[${i}]`, errors));
    if (schema.contains) {
      const anyMatch = data.some((v) => {
        const e = [];
        validate(v, schema.contains, "x", e);
        return e.length === 0;
      });
      if (!anyMatch) errors.push(`${ctx}: no item satisfies 'contains'`);
    }
  }
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const props = schema.properties ?? {};
    for (const req of schema.required ?? []) {
      if (!(req in data)) errors.push(`${ctx}: missing required property '${req}'`);
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(data)) {
        if (!(k in props)) errors.push(`${ctx}: unexpected property '${k}'`);
      }
    }
    for (const [k, v] of Object.entries(data)) {
      if (props[k]) validate(v, props[k], `${ctx}.${k}`, errors);
    }
  }
}

const exists = async (p) => access(p).then(() => true).catch(() => false);

const errors = [];

// 1. registry.json
const registryPath = path.join(dir, "registry.json");
if (!(await exists(registryPath))) {
  console.error(`No registry.json at ${path.relative(root, registryPath)}. Run: node scripts/build-registry.mjs`);
  process.exit(1);
}
const registry = JSON.parse(await readFile(registryPath, "utf8"));
validate(registry, registrySchema, "registry.json", errors);

// 2. each template.json + cross-checks
for (const t of registry.templates ?? []) {
  const templatePath = path.join(dir, t.path);
  if (!(await exists(templatePath))) {
    errors.push(`registry.json: template path '${t.path}' does not resolve`);
    continue;
  }
  const template = JSON.parse(await readFile(templatePath, "utf8"));
  validate(template, templateSchema, t.path, errors);

  const folder = path.dirname(templatePath);
  for (const op of template.operations ?? []) {
    if (op.source && !(await exists(path.join(folder, op.source)))) {
      errors.push(`${t.path}: operation '${op.id}' source '${op.source}' is missing`);
    }
  }
}

if (errors.length > 0) {
  console.error(`Registry is invalid (${errors.length} problem(s)):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`Registry valid: ${registry.templates.length} template(s) conform to the schemas.`);
