# Block 26 — Chat + Agent Endpoint

A streaming chat/agent HTTP endpoint deployed onto your branch, running next to Postgres. Accepts a
prompt, streams the model's response as it arrives, and persists every turn.

**Block 26 of the catalog**, added after the original 25.

> **Status: scaffold.** The streaming model call, turn persistence, idempotency, the input guard,
> and shared-key auth are wired for real. The marked `TODO` seams are JWKS JWT verification, the
> tool-calling loop, and the rag / semantic-cache / agent-memory composition stages. Unimplemented
> behaviour is skipped cleanly, never faked. Unverified against a live Neon project.

## Why this block

The catalog already has the machinery of an AI app — retrieval (rag #2), a response cache
(semantic-cache #20), and conversation memory (agent-memory #21) — but nothing that a client
actually talks to. This is that endpoint, and the consumer those three were missing.

It leans on the one thing a Neon Function does that a lambda-style runtime does not: it is
long-running, so it can hold a response open and stream tokens (or run a multi-step agent turn)
without hitting a short execution cap. Because it runs in the branch's region with `DATABASE_URL`
injected, retrieval and persistence are local, not a cross-region round trip.

## Install

```bash
neon-blocks migrate chat
neon function deploy chat --src blocks/chat/src
```

No triggers. Set `CHAT_API_KEY` to a long random string to protect the endpoint immediately, or set
`NEON_AUTH_BASE_URL` (injected when Neon Auth is enabled) once JWT verification is wired.

## Design notes

- **Authenticate every request.** A Function has a public URL with no app backend in front of it, so
  the handler verifies a bearer token itself and rejects anything else. There is no unauthenticated
  path.
- **Call the function directly from the client.** The point of a long-running endpoint is lost if
  the stream is proxied through a short-lived serverless route on your app host, which would cut it
  off. Clients call this endpoint directly, cross-origin, which is why CORS is first-class here.
- **State lives in Postgres, not memory.** An isolate is reused across requests and evicted without
  warning, and several run in parallel each with their own module state. Conversations and messages
  are persisted so nothing depends on a particular isolate staying alive.
- **Persist before the stream closes.** `waitUntil` is a stub during the Functions preview, so the
  assistant turn is written inside the stream, while bytes are still flowing, not after the response
  is sent.
- **Bounded by construction.** The input is size-capped before any model call and the (seam) tool
  loop has a hard iteration ceiling, because the endpoint is public and an unbounded loop burns
  Capacity-Hours.

## API

| Route | Purpose |
|---|---|
| `POST /chat` | Streaming (SSE) chat/agent turn. Persists the turn. |
| `POST /generate` | Prompt to a validated JSON object (structured output). |
| `GET /health` | `200` / `503`, backed by `blocks_chat.v_status`. |

### `POST /chat`

Request body:

```json
{ "message": "What are my most recent orders?", "conversationId": "optional-uuid", "clientMessageId": "optional-idempotency-key" }
```

Authenticate with `Authorization: Bearer <token>`. The response is `text/event-stream`. It is a
**POST that returns an SSE body**, consumed with a `fetch` reader or the Vercel AI SDK transport —
not the browser's `EventSource`, which is GET-only and cannot send a body or an auth header.

Event frames:

```
event: delta   data: {"text":"partial "}
event: delta   data: {"text":"tokens"}
event: done    data: {"conversationId":"…","finishReason":"stop","usage":{…}}
event: error   data: {"error":"…"}
```

### `POST /generate`

```json
{ "prompt": "A recipe for lemon pasta as JSON with name, ingredients[], steps[]" }
```

Returns `{ object, model, usage }`. The model is asked for JSON; the block parses and validates it,
retrying once with the parse error fed back if the first reply does not parse. Enforcing a specific
shape is a `TODO` seam — pass a stricter validator to `validateStructured`.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `CHAT_MODEL` | `gpt-4o-mini` | Model id for both routes, routed through the AI Gateway. |
| `CHAT_MAX_INPUT_TOKENS` | `24000` | Reject a larger prompt before any model call. A DoS guard on a public endpoint. |
| `CHAT_MAX_OUTPUT_TOKENS` | `2048` | Cap on generated tokens per turn. |
| `CHAT_MAX_TOOL_ITERATIONS` | `6` | Hard ceiling on the (seam) tool loop. |
| `CHAT_HISTORY_LIMIT` | `20` | Recent turns loaded into context when no external memory is set. |
| `CHAT_STREAM_TIMEOUT_MS` | `120000` | Budget for the stream's first byte. Under Neon's 15-minute ceiling. |
| `CHAT_API_KEY` | `` | Shared-secret bearer token. The zero-config way to protect the endpoint. |
| `CHAT_CORS_ALLOW_ORIGIN` | `*` | Origin echoed in CORS headers. Set to your app origin in production. |
| `RAG_URL` | `` | rag (#2) base URL. Set to retrieve context before the model call. |
| `SEMANTIC_CACHE_URL` | `` | semantic-cache (#20) base URL. Set to cache single-shot calls. |
| `AGENT_MEMORY_URL` | `` | agent-memory (#21) base URL. Set for compacted history on long conversations. |

Injected automatically by Neon: `DATABASE_URL`, `NEON_AI_GATEWAY_API_KEY`, `NEON_AI_GATEWAY_URL`,
and `NEON_AUTH_BASE_URL` (when Neon Auth is enabled).

## Limits and honest caveats

- **JWT verification is a seam.** The shared-key path (`CHAT_API_KEY`) works today; the Neon Auth
  JWKS path throws rather than silently accepting a token, so it fails closed until implemented.
- **No tool execution yet.** `/chat` streams a plain completion; the bounded tool loop that would
  make it an agent is a marked seam. The iteration guard and argument parsing it will use are
  written and unit-tested.
- **Composition stages are seams.** With `RAG_URL` / `SEMANTIC_CACHE_URL` / `AGENT_MEMORY_URL` unset
  the block is a standalone chat endpoint; the retrieve / cache / remember stages are marked TODOs.
- **Multi-turn calls are not cached.** Semantic caching applies to single-shot turns; a conversation
  with history is unique and would rarely hit.
- **Unverified against a live Neon project.** Nothing in this repo has been run against real Neon
  infrastructure yet, including whether the AI Gateway streams chat completions as chunked
  `text/event-stream`. It is OpenAI-compatible, so it is expected to, but it is not proven here.

## Observability

```sql
SELECT * FROM blocks_chat.v_status;
```

## Uninstall

```bash
neon-blocks rollback chat
```
