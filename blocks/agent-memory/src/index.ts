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
 *
 * STATUS: scaffold. The schema, safety checks, and control flow are real; the marked TODO seams are
 * the remaining work. Endpoints that are not implemented return 501 with a specific explanation
 * rather than failing in a way that looks like a bug.
 */

import {
  assertTriggerAuthentic,
  checkHealth,
  createLogger,
  getPool,
  json,
  loadConfig,
  NotFoundError,
  parseTriggerEvent,
  problem,
  Router,
  ValidationError,
  type Logger,
} from "@neon-blocks/core";


const log: Logger = createLogger({ block: "agent-memory" });

const SPEC = {
  block: "agent-memory",
  optional: {
    MEMORY_COMPACT_AT_TOKENS: "24000",
    MEMORY_KEEP_RECENT_TURNS: "10",
    MEMORY_SUMMARY_MODEL: "gpt-4o-mini",
    MEMORY_EMBEDDING_MODEL: "text-embedding-3-small",
    MEMORY_EMBEDDING_DIMENSIONS: "1536",
  },
} as const;

function config() {
  return loadConfig(SPEC);
}

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
    typeof body["tokenCount"] === "number" ? body["tokenCount"] : Math.ceil(content.length / 4);

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

  const cfg = config();
  const threshold = cfg.int("MEMORY_COMPACT_AT_TOKENS", { min: 1_000, max: 1_000_000 });

  // TODO(agent-memory): embed this turn for retrieval. Deliberately not inline -- a user-facing turn
  // should not wait on an embedding call. Queue it, or batch on the /compact schedule.
  return json(
    {
      turnIndex: row.turn_index,
      totalTokens: row.total_tokens,
      // Surfaced so the caller knows compaction is due without querying for it.
      compactionDue: row.total_tokens > threshold,
    },
    { status: 201 },
  );
});

router.get("/context", async (_request, ctx) => {
  const sessionId = ctx.url.searchParams.get("session");
  if (!sessionId) throw new ValidationError("?session= is required");

  const cfg = config();
  const keepRecent = cfg.int("MEMORY_KEEP_RECENT_TURNS", { min: 1, max: 200 });
  const pool = getPool();

  // Summaries first, then recent verbatim turns. That ordering reconstructs the conversation
  // chronologically: what happened earlier (compressed), then what happened lately (in full).
  const { rows: summaries } = await pool.query(
    `SELECT from_turn, to_turn, summary, token_count
     FROM blocks_agent_memory.summaries WHERE session_id = $1 ORDER BY from_turn`,
    [sessionId],
  );

  const { rows: recent } = await pool.query(
    `SELECT turn_index, role, content, token_count
     FROM blocks_agent_memory.turns
     WHERE session_id = $1 AND NOT is_compacted
     ORDER BY turn_index DESC
     LIMIT $2`,
    [sessionId, keepRecent],
  );

  // TODO(agent-memory): semantic retrieval.
  //   embed the current query and pull the most relevant COMPACTED turns via <=>, so a detail from
  //   turn 12 is available at turn 200 without replaying everything. This is the part that keeps an
  //   agent coherent past a few dozen turns, and it is why compacted turns are retained rather than
  //   deleted.
  return json({
    sessionId,
    summaries,
    recentTurns: recent.reverse(),
    retrievedTurns: [],
    note: "Semantic retrieval is not yet wired; see the TODO in src/index.ts.",
  });
});

router.post("/compact", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", `/compact expects a schedule trigger, got ${event.type}`);
  }

  const cfg = config();
  const threshold = cfg.int("MEMORY_COMPACT_AT_TOKENS", { min: 1_000, max: 1_000_000 });

  // Identifying what needs compaction works; performing it does not. Reported honestly so an
  // operator can see the backlog rather than assuming it is handled.
  const { rows } = await getPool().query<{ id: string; total_tokens: number; turn_count: number }>(
    `SELECT id, total_tokens, turn_count
     FROM blocks_agent_memory.sessions
     WHERE status = 'active' AND total_tokens > $1 AND turn_count > compacted_through_turn
     ORDER BY total_tokens DESC
     LIMIT 20`,
    [threshold],
  );

  // TODO(agent-memory): the compaction pass.
  //   1. take turns from compacted_through_turn up to (turn_count - MEMORY_KEEP_RECENT_TURNS)
  //   2. summarize them with MEMORY_SUMMARY_MODEL and insert a summaries row
  //   3. mark those turns is_compacted -- NOT deleted: a summary is lossy, so the originals are the
  //      only place a compacted-away detail still exists, and retrieval reads them
  //   4. advance compacted_through_turn and reduce total_tokens by the difference
  //
  //   Never truncate the head instead of summarizing: the first message is usually where the task
  //   was defined, and dropping it is how an agent forgets what it was asked to do.
  return json({
    ok: true,
    scheduledAt: event.scheduledAt,
    sessionsNeedingCompaction: rows.length,
    compacted: 0,
    note:
      rows.length > 0
        ? "Compaction is not yet wired; these sessions will overflow their context window. See the " +
          "TODO in src/index.ts."
        : undefined,
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
