/**
 * Context assembly. Ordering and selection are pure and unit tested; the vector search is the thin
 * impure edge.
 */

import type { Queryable } from "@neon-blocks/core";
import { toVectorLiteral } from "@neon-blocks/ai";

export type SummaryRow = {
  from_turn: number;
  to_turn: number;
  summary: string;
  token_count: number;
};

export type TurnRow = {
  turn_index: number;
  role: string;
  content: string;
  token_count?: number;
};

export type RetrievedTurn = TurnRow & {
  distance: number;
};

/**
 * Rank retrieved candidates by similarity (nearest first), drop any turn already present verbatim in
 * the recent window (no point retrieving what is already in context), and take the top `k`.
 */
export function selectRetrieved(
  candidates: readonly RetrievedTurn[],
  k: number,
  excludeTurnIndexes: ReadonlySet<number>,
): RetrievedTurn[] {
  return candidates
    .filter((c) => !excludeTurnIndexes.has(c.turn_index))
    .slice()
    .sort((a, b) => a.distance - b.distance)
    .slice(0, k);
}

/**
 * Order the pieces of context chronologically in intent: summaries of what happened earlier (by
 * turn range), then the relevant retrieved turns, then the recent turns verbatim in ascending order.
 */
export function assembleContext(input: {
  summaries: readonly SummaryRow[];
  retrieved: readonly RetrievedTurn[];
  recent: readonly TurnRow[];
}): { summaries: SummaryRow[]; retrievedTurns: RetrievedTurn[]; recentTurns: TurnRow[] } {
  return {
    summaries: input.summaries.slice().sort((a, b) => a.from_turn - b.from_turn),
    retrievedTurns: input.retrieved.slice(),
    recentTurns: input.recent.slice().sort((a, b) => a.turn_index - b.turn_index),
  };
}

/** Nearest compacted turns to a query embedding. Impure; needs pgvector. */
export async function retrieveContext(
  db: Queryable,
  opts: { sessionId: string; queryEmbedding: readonly number[]; k: number },
): Promise<RetrievedTurn[]> {
  const { rows } = await db.query<{
    turn_index: number;
    role: string;
    content: string;
    token_count: number | null;
    distance: number;
  }>(
    `SELECT turn_index, role, content, token_count, embedding <=> $2::vector AS distance
     FROM blocks_agent_memory.turns
     WHERE session_id = $1 AND is_compacted AND embedding IS NOT NULL
     ORDER BY embedding <=> $2::vector
     LIMIT $3`,
    [opts.sessionId, toVectorLiteral(opts.queryEmbedding), opts.k],
  );
  return rows.map((r) => ({
    turn_index: r.turn_index,
    role: r.role,
    content: r.content,
    token_count: r.token_count ?? undefined,
    distance: Number(r.distance),
  }));
}
