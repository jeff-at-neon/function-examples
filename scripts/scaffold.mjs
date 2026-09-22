#!/usr/bin/env node
/**
 * Scaffold runner.
 *
 * Regenerates blocks 11-25 from their specs. Idempotent: re-running overwrites the generated files,
 * so a convention change is applied to every scaffolded block at once rather than fifteen times by
 * hand. That uniformity is the point -- divergence between blocks is what makes a catalog feel like
 * a pile of unrelated scripts.
 *
 * Authoring tool, not part of the build. Blocks 1-10 are hand-written and are NOT touched.
 */

import { generate } from "./lib/generate.mjs";
import { SPECS as SPECS_11_15 } from "./specs-11-15.mjs";
import { SPECS as SPECS_16_20 } from "./specs-16-20.mjs";
import { SPECS as SPECS_21_25 } from "./specs-21-25.mjs";

const all = [...SPECS_11_15, ...SPECS_16_20, ...SPECS_21_25];

const ranks = new Set();
for (const spec of all) {
  if (ranks.has(spec.rank)) throw new Error(`Duplicate rank ${spec.rank} in specs`);
  ranks.add(spec.rank);
}

const written = [];
for (const spec of all.sort((a, b) => a.rank - b.rank)) written.push(await generate(spec));
console.log(`generated ${written.length} blocks: ${written.join(", ")}`);
