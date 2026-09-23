/**
 * Block 26 — Chat + Agent Endpoint.
 *
 * A streaming chat/agent endpoint deployed onto a Neon branch, running next to Postgres. Accepts a
 * prompt, streams the model's response as it arrives, and persists every turn so state survives the
 * isolate being evicted. Because a Function is long-running it can hold the response open for a
 * multi-step agent turn without the short execution caps a lambda-style runtime would impose.
 *
 * This is the consumer the AI machinery blocks (rag #2, semantic-cache #20, agent-memory #21) were
 * missing: with their URLs configured, /chat retrieves, caches, and remembers through them.
 *
 * Routes:
 *   POST   /chat        Streaming (SSE) chat/agent turn. Persists the turn.
 *   POST   /generate    Prompt to a validated JSON object (structured output).
 *   GET    /health      200 / 503, backed by the block's v_status view.
 *
 * STATUS: scaffold. The streaming model call, persistence, idempotency, input guard, and auth are
 * wired for real. The marked TODO seams are: JWKS JWT verification, the tool-calling loop, and the
 * rag/semantic-cache/agent-memory composition stages. Unimplemented behaviour is skipped cleanly,
 * never faked.
 */

import {
  checkHealth,
  createLogger,
  getPool,
  json,
  problem,
  Router,
  ValidationError,
  type Logger,
} from "@neon-blocks/core";
import { approxTokens, defaultChat, defaultChatStream, type ChatMessage } from "@neon-blocks/ai";
import { loadChatConfig, type ChatConfig } from "./config.js";
import { authenticate, type AuthResult } from "./auth.js";
import { encodeSse, SSE_HEADERS } from "./sse.js";
import { extractJson, requireObject, validateStructured } from "./structured.js";

const log: Logger = createLogger({ block: "chat" });

// Read at module scope so OPTIONS preflight needs no config load (which would throw without
// DATABASE_URL). The full config is loaded inside handlers that actually need it.
const CORS_ORIGIN = process.env["CHAT_CORS_ALLOW_ORIGIN"] ?? "*";

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": CORS_ORIGIN,
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "3600",
    vary: "origin",
  };
}

const router = new Router();

router.post("/chat", async (request) => {
  const cfg = loadChatConfig();

  const auth = await authenticate(request.headers.get("authorization"), cfg);
  if (!auth) return unauthorized();

  const body = await readJsonObject(request);
  const message = requireString(body, "message");
  const clientMessageId = optionalString(body, "clientMessageId");
  const pool = getPool();

  // Idempotency (convention 6): a retried request with the same key returns the stored reply
  // rather than calling the model again. Checked before any write so a retry is side-effect free.
  if (clientMessageId) {
    const { rows } = await pool.query<{ content: string; conversation_id: string }>(
      `SELECT m.content, m.conversation_id
       FROM blocks_chat.messages m
       JOIN blocks_chat.conversations c ON c.id = m.conversation_id
       WHERE c.tenant = $1 AND m.role = 'assistant' AND m.client_message_id = $2
       LIMIT 1`,
      [auth.subject, clientMessageId],
    );
    const prior = rows[0];
    if (prior) {
      log.info("replaying stored reply for idempotency key", { clientMessageId });
      return streamStored(prior.content, prior.conversation_id);
    }
  }

  const conversationId = await resolveConversation(pool, auth, optionalString(body, "conversationId"));

  // Build the model context from stored history plus this turn.
  //
  // TODO(chat) retrieval seam: when cfg.ragUrl is set, POST the user message to `${ragUrl}/search`
  //   and prepend the results as system context here.
  // TODO(chat) memory seam: when cfg.agentMemoryUrl is set, load compacted history from
  //   `${agentMemoryUrl}/context` instead of the local table below.
  const history = await loadHistory(pool, conversationId, cfg.historyLimit);
  const messages: ChatMessage[] = [...history, { role: "user", content: message }];

  // Input guard (convention 11): reject an oversized prompt before spending a model call. The
  // endpoint is public, so this is a denial-of-service bound, not a nicety.
  const inputTokens = messages.reduce(
    (sum, m) => sum + approxTokens(typeof m.content === "string" ? m.content : ""),
    0,
  );
  if (inputTokens > cfg.maxInputTokens) {
    throw new ValidationError(
      `Input is ~${inputTokens} tokens, over the ${cfg.maxInputTokens} limit (CHAT_MAX_INPUT_TOKENS).`,
    );
  }

  // TODO(chat) cache seam: when cfg.semanticCacheUrl is set AND this is a single-shot turn (no
  //   history), POST to `${semanticCacheUrl}/lookup` and, on a hit, stream the cached answer and
  //   skip the model. Multi-turn conversations are unique, so they are not cache-eligible.

  await insertMessage(pool, conversationId, "user", message, null, null);

  return streamModel({ pool, cfg, conversationId, messages, clientMessageId });
});

router.post("/generate", async (request) => {
  const cfg = loadChatConfig();

  const auth = await authenticate(request.headers.get("authorization"), cfg);
  if (!auth) return unauthorized();

  const body = await readJsonObject(request);
  const prompt = requireString(body, "prompt");

  const chat = defaultChat({ model: cfg.model });
  const result = await chat.chat(
    [
      {
        role: "system",
        content:
          "You return a single JSON object and nothing else. No prose, no code fences, no explanation.",
      },
      { role: "user", content: prompt },
    ],
    { jsonMode: true, maxTokens: cfg.maxOutputTokens },
  );

  // Parse and validate. A caller-supplied shape validator is a TODO seam; the default only asserts
  // the result is a JSON object. The repair retry (feed the parse error back once) also lives here.
  try {
    const object = validateStructured(result.text, requireObject);
    return json({ object, model: result.model, usage: result.usage ?? null });
  } catch {
    const repaired = await chat.chat(
      [
        { role: "system", content: "Return only a valid JSON object. Your previous reply did not parse." },
        { role: "user", content: prompt },
        { role: "assistant", content: result.text },
        { role: "user", content: "That was not valid JSON. Return only the JSON object." },
      ],
      { jsonMode: true, maxTokens: cfg.maxOutputTokens },
    );
    const object = requireObject(extractJson(repaired.text));
    return json({ object, model: repaired.model, usage: repaired.usage ?? null, repaired: true });
  }
});

router.get("/health", async () => {
  const report = await checkHealth(getPool(), {
    block: "chat",
    schema: "blocks_chat",
    // No triggers on this block, so there is no "trigger disabled on a child branch" hazard to
    // report; health is just liveness of the schema and recent activity.
  });
  return json(report, { status: report.status === "ok" ? 200 : 503 });
});

/**
 * Stream a model completion as SSE, accumulating the text and persisting the assistant turn when
 * the stream finishes.
 *
 * Persistence happens inside the stream, before the stream is closed, rather than after the
 * response is sent: waitUntil is a stub during the Functions preview, so post-response work is not
 * reliable. Doing it here keeps it inside the request lifecycle while bytes are still flowing.
 *
 * TODO(chat) tool loop: to make this an agent rather than a chat, detect tool_call deltas in the
 *   stream, execute the requested tool (bounded by cfg.maxToolIterations via tool-loop.ts), append
 *   the result, and re-enter the model call. Text deltas stream through unchanged; tool steps
 *   surface as `event: tool` frames.
 */
function streamModel(args: {
  pool: ReturnType<typeof getPool>;
  cfg: ChatConfig;
  conversationId: string;
  messages: ChatMessage[];
  clientMessageId: string | null;
}): Response {
  const { pool, cfg, conversationId, messages, clientMessageId } = args;
  const encoder = new TextEncoder();
  const provider = defaultChatStream({ model: cfg.model });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let text = "";
      let usage: { promptTokens: number; completionTokens: number } | undefined;
      let finishReason = "stop";
      try {
        for await (const chunk of provider.stream(messages, {
          maxTokens: cfg.maxOutputTokens,
          timeoutMs: cfg.streamTimeoutMs,
        })) {
          if (chunk.delta) {
            text += chunk.delta;
            controller.enqueue(encoder.encode(encodeSse({ event: "delta", data: { text: chunk.delta } })));
          }
          if (chunk.usage) usage = chunk.usage;
          if (chunk.finishReason) finishReason = chunk.finishReason;
        }

        // Persist the assistant turn while the stream is still open (see the note above).
        await insertMessage(
          pool,
          conversationId,
          "assistant",
          text,
          cfg.model,
          usage ?? null,
          clientMessageId,
        );
        await pool.query(`UPDATE blocks_chat.conversations SET updated_at = now() WHERE id = $1`, [
          conversationId,
        ]);

        // TODO(chat): when cfg.semanticCacheUrl / cfg.agentMemoryUrl are set, POST /store and /turns
        //   here, and publish a usage event on the events contract for billing (#8) to meter.

        controller.enqueue(
          encoder.encode(encodeSse({ event: "done", data: { conversationId, finishReason, usage: usage ?? null } })),
        );
        controller.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("chat stream failed", { conversationId, err: message });
        controller.enqueue(encoder.encode(encodeSse({ event: "error", data: { error: message } })));
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

/** Re-stream a stored reply for an idempotent replay, in the same SSE shape as a live turn. */
function streamStored(content: string, conversationId: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(encodeSse({ event: "delta", data: { text: content } })));
      controller.enqueue(
        encoder.encode(encodeSse({ event: "done", data: { conversationId, replayed: true } })),
      );
      controller.close();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

interface Pool {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/** Find the conversation (verifying tenant ownership) or create a new one. */
async function resolveConversation(pool: Pool, auth: AuthResult, conversationId: string | null): Promise<string> {
  if (conversationId) {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM blocks_chat.conversations WHERE id = $1 AND tenant = $2`,
      [conversationId, auth.subject],
    );
    const found = rows[0];
    // A conversation id that isn't the caller's is treated as not found, never as someone else's
    // history: the tenant check is the boundary that makes a guessable id safe.
    if (found) return found.id;
    throw new ValidationError("conversationId not found for this caller");
  }

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO blocks_chat.conversations (tenant) VALUES ($1) RETURNING id`,
    [auth.subject],
  );
  const created = rows[0];
  if (!created) throw new Error("failed to create conversation");
  return created.id;
}

/** Load the most recent turns for a conversation, oldest first, for model context. */
async function loadHistory(pool: Pool, conversationId: string, limit: number): Promise<ChatMessage[]> {
  if (limit === 0) return [];
  const { rows } = await pool.query<{ role: string; content: string }>(
    `SELECT role, content FROM (
       SELECT role, content, created_at
       FROM blocks_chat.messages
       WHERE conversation_id = $1 AND role IN ('user', 'assistant')
       ORDER BY created_at DESC
       LIMIT $2
     ) recent
     ORDER BY created_at ASC`,
    [conversationId, limit],
  );
  return rows.map((r) => ({ role: r.role as ChatMessage["role"], content: r.content }));
}

async function insertMessage(
  pool: Pool,
  conversationId: string,
  role: "user" | "assistant" | "system" | "tool",
  content: string,
  model: string | null,
  usage: { promptTokens: number; completionTokens: number } | null,
  clientMessageId: string | null = null,
): Promise<void> {
  await pool.query(
    `INSERT INTO blocks_chat.messages
       (conversation_id, role, content, model, prompt_tokens, completion_tokens, client_message_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT DO NOTHING`,
    [
      conversationId,
      role,
      content,
      model,
      usage?.promptTokens ?? null,
      usage?.completionTokens ?? null,
      clientMessageId,
    ],
  );
}

function unauthorized(): Response {
  return problem(401, "unauthorized", "Provide a valid bearer token (CHAT_API_KEY or a Neon Auth JWT).");
}

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

function optionalString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value !== "" ? value : null;
}

export default {
  fetch: async (request: Request): Promise<Response> => {
    // Client-direct calls are cross-origin, so preflight and CORS are first-class here.
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
    const response = await router.handle(request);
    for (const [key, value] of Object.entries(corsHeaders())) response.headers.set(key, value);
    return response;
  },
};

// Drain the pool when the platform evicts the isolate, so connections close cleanly.
process.on("SIGINT", () => {
  getPool()
    .end()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
});

// Re-exported so unit tests can import the pure logic directly.
export { SPEC, loadChatConfig } from "./config.js";
export { parseBearer, verifyApiKey, authenticate } from "./auth.js";
export { encodeSse, sseComment, SSE_HEADERS } from "./sse.js";
export { extractJson, validateStructured, requireObject } from "./structured.js";
export {
  withinIterationBudget,
  assertIterationBudget,
  parseToolArguments,
  resolveTool,
  ToolIterationLimit,
  ToolArgumentsError,
} from "./tool-loop.js";
