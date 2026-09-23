/**
 * Block 21 — Agent Memory Store.
 *
 * Session transcripts, summarization compaction, and retrieval for LLM agents — so a long conversation stays inside the context window.
 *
 * Rides the agent wave, and Neon already pitches Functions for agent tool-loops. The real problem is not storing messages — it is that a conversation outgrows the context window, and naive truncation drops the beginning, which is usually where the task was defined. Compaction plus retrieval is what keeps an agent coherent past a few dozen turns.
 *
 * Routes:
 *   POST   /sessions              Open a session.
 *   POST   /turns                 Append a turn and update the running token total.
 *   GET    /context               Assemble context: summaries, retrieved turns, recent turns.
 *   POST   /compact               Cron. Summarize the oldest turns of oversized sessions.
 */

import {
  assertTriggerAuthentic,
  checkHealth,
  createLogger,
  getPool,
  json,
  NotFoundError,
  parseTriggerEvent,
  problem,
  Router,
  ValidationError,
  type Logger,
} from "@neon-blocks/core";
import { defaultChat, defaultEmbeddings } from "@neon-blocks/ai";
import { loadMemoryConfig } from "./config.js";
import { estimateTokens } from "./tokens.js";
import { compactSession, shouldCompact } from "./compact.js";
import { assembleContext, retrieveContext, selectRetrieved, type RetrievedTurn, type SummaryRow, type TurnRow } from "./context.js";

const log: Logger = createLogger({ block: "agent-memory" });

const router = new Router();

router.post("/sessions", async (request) => {
  const body = await readJsonObject(request);

  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO blocks_agent_memory.sessions (agent_code, owner_ref, title, expires_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      requireString(body, "agentCode"),
      requireString(body, "ownerRef"),
      typeof body["title"] === "string" ? body["title"] : null,
      typeof body["expiresAt"] === "string" ? body["expiresAt"] : null,
    ],
  );

  return json({ sessionId: rows[0]?.id }, { status: 201 });
});

router.post("/turns", async (request) => {
  const body = await readJsonObject(request);
  const sessionId = requireString(body, "sessionId");
  const role = requireString(body, "role");
  const content = requireString(body, "content");

  // Caller-supplied when available, else estimated. Four characters per token is wrong for code and
  // for non-Latin scripts; a real tokenizer is the fix and is noted as a limitation.
  const tokenCount =
    typeof body["tokenCount"] === "number" ? body["tokenCount"] : estimateTokens(content);

  const pool = getPool();

  // Turn index and running total advance in one statement, so two concurrent appends cannot both
  // claim the same index or lose a token count.
  const { rows } = await pool.query<{ turn_index: number; total_tokens: number }>(
    `WITH updated AS (
       UPDATE blocks_agent_memory.sessions
       SET turn_count = turn_count + 1,
           total_tokens = total_tokens + $2,
           updated_at = now()
       WHERE id = $1 AND status = 'active'
       RETURNING turn_count, total_tokens
     )
     INSERT INTO blocks_agent_memory.turns (session_id, turn_index, role, content, token_count)
     SELECT $1, updated.turn_count, $3, $4, $2 FROM updated
     RETURNING turn_index, (SELECT total_tokens FROM updated) AS total_tokens`,
    [sessionId, tokenCount, role, content],
  );

  const row = rows[0];
  if (!row) throw new NotFoundError("No such active session");

  const cfg = loadMemoryConfig();

  // Turns are embedded on the /compact schedule, not here — a user-facing turn should not wait on an
  // embedding call.
  return json(
    {
      turnIndex: row.turn_index,
      totalTokens: row.total_tokens,
      // Surfaced so the caller knows compaction is due without querying for it.
      compactionDue: row.total_tokens > cfg.compactAtTokens,
    },
    { status: 201 },
  );
});

router.get("/context", async (_request, ctx) => {
  const sessionId = ctx.url.searchParams.get("session");
  if (!sessionId) throw new ValidationError("?session= is required");

  const cfg = loadMemoryConfig();
  const keepRecent = cfg.keepRecentTurns;
  const query = ctx.url.searchParams.get("q");
  const k = Math.min(Math.max(Number(ctx.url.searchParams.get("k") ?? "5"), 1), 50);
  const pool = getPool();

  const { rows: summaries } = await pool.query<SummaryRow>(
    `SELECT from_turn, to_turn, summary, token_count
     FROM blocks_agent_memory.summaries WHERE session_id = $1 ORDER BY from_turn`,
    [sessionId],
  );

  const { rows: recent } = await pool.query<TurnRow>(
    `SELECT turn_index, role, content, token_count
     FROM blocks_agent_memory.turns
     WHERE session_id = $1 AND NOT is_compacted
     ORDER BY turn_index DESC
     LIMIT $2`,
    [sessionId, keepRecent],
  );

  // Semantic retrieval over COMPACTED turns: a detail from turn 12 is available at turn 200 without
  // replaying everything, which is why compacted turns are retained rather than deleted. Skipped
  // when no query is supplied.
  let retrieved: RetrievedTurn[] = [];
  if (query) {
    const embeddings = defaultEmbeddings({ model: cfg.embeddingModel, dimensions: cfg.dimensions });
    const { vectors } = await embeddings.embed([query]);
    const embedding = vectors[0];
    if (embedding) {
      const candidates = await retrieveContext(pool, { sessionId, queryEmbedding: embedding, k });
      const recentIndexes = new Set(recent.map((r) => r.turn_index));
      retrieved = selectRetrieved(candidates, k, recentIndexes);
    }
  }

  return json({ sessionId, ...assembleContext({ summaries, retrieved, recent }) });
});

router.post("/compact", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", `/compact expects a schedule trigger, got ${event.type}`);
  }

  const cfg = loadMemoryConfig();
  const pool = getPool();

  const { rows: sessions } = await pool.query<{
    id: string;
    total_tokens: number;
    turn_count: number;
    compacted_through_turn: number;
  }>(
    `SELECT id, total_tokens, turn_count, compacted_through_turn
     FROM blocks_agent_memory.sessions
     WHERE status = 'active' AND total_tokens > $1 AND turn_count > compacted_through_turn
     ORDER BY total_tokens DESC
     LIMIT 20`,
    [cfg.compactAtTokens],
  );

  // Summarize the oldest turns of each oversized session, keeping the most recent verbatim and never
  // dropping the head (see compactionWindow). The originals are marked compacted, not deleted, so
  // retrieval can still read a summarized-away detail.
  const chat = defaultChat({ model: cfg.summaryModel });
  let compacted = 0;
  for (const session of sessions) {
    if (!shouldCompact(session.total_tokens, cfg.compactAtTokens, session.turn_count, session.compacted_through_turn)) {
      continue;
    }
    const result = await compactSession(pool, session, {
      chat,
      keepRecentTurns: cfg.keepRecentTurns,
    });
    if (result.compacted) compacted++;
  }

  return json({
    ok: true,
    scheduledAt: event.scheduledAt,
    sessionsConsidered: sessions.length,
    compacted,
  });
});

router.get("/health", async () => {
  const report = await checkHealth(getPool(), {
    block: "agent-memory",
    schema: "blocks_agent_memory",
    evaluate: (status) => {
      const problems: string[] = [];

      const needing = Number(status["sessions_needing_compaction"] ?? 0);
      const unembedded = Number(status["turns_unembedded"] ?? 0);
      const largest = Number(status["largest_session_tokens"] ?? 0);

      if (needing > 0) {
        // This is the failure the block exists to prevent, so it is reported rather than inferred.
        problems.push(
          `${needing} session(s) are over the compaction threshold and will overflow their context ` +
            `window on the next turn`,
        );
      }
      if (largest > 100_000) {
        problems.push(`largest session is ${largest} tokens, beyond most model windows`);
      }
      if (unembedded > 0) {
        problems.push(
          `${unembedded} turn(s) have no embedding and cannot be retrieved semantically, only ` +
            `replayed in order`,
        );
      }
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
    throw new ValidationError(`"${key}" is required and must be a non-empty string`);
  }
  return value;
}

export default {
  fetch: (request: Request): Promise<Response> => router.handle(request),
};

// Re-exported so unit tests can import the pure logic directly.
export { loadMemoryConfig, SPEC } from "./config.js";
export { estimateTokens } from "./tokens.js";
export { shouldCompact, compactionWindow, tokenReduction } from "./compact.js";
export { assembleContext, selectRetrieved } from "./context.js";
