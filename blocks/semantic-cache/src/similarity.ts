/**
 * Pure similarity and hashing helpers. The scoping guarantee (a cache key is namespace + model +
 * prompt, never just the prompt) and the threshold decision live here so they can be unit tested
 * without a database or an embedding call.
 */

import { createHash } from "node:crypto";

/** pgvector's `<=>` is cosine distance in [0, 2]; similarity is 1 - distance. */
export function distanceToSimilarity(cosineDistance: number): number {
  return 1 - cosineDistance;
}

/**
 * Accept a candidate only when its similarity meets the threshold. Strict `>=`: a request that
 * lands exactly on the threshold is a hit, anything below is a miss (which is safer than serving an
 * answer to a different question).
 */
export function meetsThreshold(cosineDistance: number, threshold: number): boolean {
  return distanceToSimilarity(cosineDistance) >= threshold;
}

/** Tokens a cache hit avoided spending. Null-safe: an entry with unknown counts saved nothing. */
export function tokensSaved(entry: {
  promptTokens?: number | null;
  completionTokens?: number | null;
}): number {
  return (entry.promptTokens ?? 0) + (entry.completionTokens ?? 0);
}

/**
 * Cache key hash. Namespace and model are part of the key on purpose: crossing namespaces is a
 * cross-tenant leak, and crossing models serves a weaker model's answer as a stronger one's.
 */
export function promptHash(namespace: string, model: string, prompt: string): string {
  return createHash("sha256").update(`${namespace}:${model}:${prompt}`).digest("hex");
}
