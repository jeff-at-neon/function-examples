/**
 * The similarity search itself — the one piece that needs Postgres + pgvector and cannot run
 * offline. Kept thin: it takes an already-computed embedding and returns the nearest live entry
 * scoped to the same namespace and model; the accept/reject decision is `meetsThreshold` in
 * similarity.ts.
 */

import type { Queryable } from "@neon-blocks/core";
import { toVectorLiteral } from "@neon-blocks/ai";

export interface SimilarityHit {
  id: string;
  response: string;
  model: string;
  distance: number;
  promptTokens: number | null;
  completionTokens: number | null;
}

type HitRow = {
  id: string;
  response: string;
  model: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  distance: number;
};

export async function similarityLookup(
  db: Queryable,
  opts: { embedding: readonly number[]; namespace: string; model: string },
): Promise<SimilarityHit | null> {
  const literal = toVectorLiteral(opts.embedding);
  const { rows } = await db.query<HitRow>(
    `SELECT id, response, model, prompt_tokens, completion_tokens,
            prompt_embedding <=> $1::vector AS distance
     FROM blocks_semantic_cache.entries
     WHERE namespace = $2
       AND model = $3
       AND expires_at > now()
       AND prompt_embedding IS NOT NULL
     ORDER BY prompt_embedding <=> $1::vector
     LIMIT 1`,
    [literal, opts.namespace, opts.model],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    response: row.response,
    model: row.model,
    distance: Number(row.distance),
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
  };
}
