/**
 * Compaction. The window arithmetic — which turns to summarize, always leaving the most recent
 * verbatim and never dropping the head — is pure and unit tested, because getting it wrong makes an
 * agent forget the task it was given. `compactSession` is the impure orchestration around the chat
 * call.
 */

import type { Queryable } from "@neon-blocks/core";
import type { ChatProvider } from "@neon-blocks/ai";
import { estimateTokens } from "./tokens.js";

/** Whether a session is over budget and has uncompacted turns beyond what it already summarized. */
export function shouldCompact(
  totalTokens: number,
  threshold: number,
  turnCount: number,
  compactedThroughTurn: number,
): boolean {
  return totalTokens > threshold && turnCount > compactedThroughTurn;
}

export interface CompactionWindow {
  fromTurn: number;
  toTurn: number;
}

/**
 * The inclusive turn range to summarize: everything after what was already compacted, up to but not
 * including the most recent `keepRecentTurns`. Returns null when nothing qualifies — which is how it
 * guarantees the recent turns are kept verbatim and the head is summarized rather than dropped.
 */
export function compactionWindow(
  turnCount: number,
  compactedThroughTurn: number,
  keepRecentTurns: number,
): CompactionWindow | null {
  const fromTurn = compactedThroughTurn + 1;
  const toTurn = turnCount - keepRecentTurns;
  if (toTurn < fromTurn) return null;
  return { fromTurn, toTurn };
}

/** Tokens reclaimed by replacing the originals with a summary; never negative. */
export function tokenReduction(originalTokens: number, summaryTokens: number): number {
  return Math.max(0, originalTokens - summaryTokens);
}

type TurnRow = {
  turn_index: number;
  role: string;
  content: string;
  token_count: number;
};

/**
 * Summarize one session's oldest uncompacted turns, mark them compacted (not deleted — retrieval
 * still reads them), record the summary, and advance the watermark. Impure; cannot run offline.
 */
export async function compactSession(
  db: Queryable,
  session: { id: string; turn_count: number; compacted_through_turn: number },
  opts: { chat: ChatProvider; keepRecentTurns: number },
): Promise<{ compacted: boolean; fromTurn?: number; toTurn?: number; reclaimed?: number }> {
  const window = compactionWindow(session.turn_count, session.compacted_through_turn, opts.keepRecentTurns);
  if (!window) return { compacted: false };

  const { rows: turns } = await db.query<TurnRow>(
    `SELECT turn_index, role, content, token_count
     FROM blocks_agent_memory.turns
     WHERE session_id = $1 AND turn_index BETWEEN $2 AND $3
     ORDER BY turn_index`,
    [session.id, window.fromTurn, window.toTurn],
  );
  if (turns.length === 0) return { compacted: false };

  const transcript = turns.map((t) => `${t.role}: ${t.content}`).join("\n");
  const result = await opts.chat.chat([
    {
      role: "system",
      content:
        "Summarize this conversation excerpt for an agent's long-term memory. Preserve decisions, " +
        "facts, and the task definition; be concise.",
    },
    { role: "user", content: transcript },
  ]);
  const summary = result.text;
  const summaryTokens = estimateTokens(summary);
  const originalTokens = turns.reduce((sum, t) => sum + t.token_count, 0);
  const reclaimed = tokenReduction(originalTokens, summaryTokens);

  await db.query(
    `INSERT INTO blocks_agent_memory.summaries (session_id, from_turn, to_turn, summary, token_count)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (session_id, from_turn, to_turn) DO UPDATE SET summary = EXCLUDED.summary`,
    [session.id, window.fromTurn, window.toTurn, summary, summaryTokens],
  );
  await db.query(
    `UPDATE blocks_agent_memory.turns SET is_compacted = true
     WHERE session_id = $1 AND turn_index BETWEEN $2 AND $3`,
    [session.id, window.fromTurn, window.toTurn],
  );
  await db.query(
    `UPDATE blocks_agent_memory.sessions
     SET compacted_through_turn = $2, total_tokens = GREATEST(0, total_tokens - $3)
     WHERE id = $1`,
    [session.id, window.toTurn, reclaimed],
  );

  return { compacted: true, fromTurn: window.fromTurn, toTurn: window.toTurn, reclaimed };
}
