# Block 21 — Agent memory

Store, summarize, and recall conversation history for LLM agents

**Block 21 of 25**, numbered in build order.

> **Status: implemented.** Schema, safety checks, control flow, and the core logic (compaction that
> keeps recent turns and never drops the head, plus semantic retrieval over compacted turns) are all
> wired, with pure unit tests. Still unverified against a live Neon project.

## Why this block

Rides the agent wave, and Neon already pitches Functions for agent tool-loops. The real problem is not storing messages — it is that a conversation outgrows the context window, and naive truncation drops the beginning, which is usually where the task was defined. Compaction plus retrieval is what keeps an agent coherent past a few dozen turns.

## Install

```bash
neon-blocks migrate agent-memory
neon function deploy agent-memory --src blocks/agent-memory/src
neon triggers create --function-slug agent-memory --name agent-memory-compact \
  --schedule '*/10 * * * *' --function-path '/compact'
```

> Child branches inherit triggers **disabled**. Enable them after promoting, or scheduled work
> silently never runs.

## Design notes

- **Compaction summarizes the oldest turns rather than dropping them.** Truncating the head of a conversation discards the original instruction, which is the one message you cannot afford to lose. Summaries are stored as first-class rows, so the record of what was compacted survives.
- **Retrieval is over embedded turns, not the whole transcript.** Pulling the semantically relevant three messages from turn 200 beats replaying the last fifty, and costs far fewer tokens.
- **Token counts are stored per message.** Deciding when to compact needs a running total, and recomputing it from text on every turn is both slow and approximate.
- **Sessions are namespaced by agent and owner.** Two agents sharing a memory store would cross-contaminate, and one tenant retrieving another's turns is a data leak, not a quirk.

## API

| Route | Purpose |
|---|---|
| `POST /sessions` | Open a session. |
| `POST /turns` | Append a turn and update the running token total. |
| `GET /context` | Assemble context: summaries, retrieved turns, recent turns. |
| `POST /compact` | Cron. Summarize the oldest turns of oversized sessions. |
| `GET /health` | `200` / `503`. |

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `MEMORY_COMPACT_AT_TOKENS` | `24000` | Running token total at which the oldest turns are summarized. Should sit well below your model's window, leaving room for retrieval and the response. |
| `MEMORY_KEEP_RECENT_TURNS` | `10` | Turns always kept verbatim, never compacted. Recent exchanges carry the most relevant detail. |
| `MEMORY_SUMMARY_MODEL` | `gpt-5-mini` | Model used to summarize compacted turns. |
| `MEMORY_EMBEDDING_MODEL` | `text-embedding-3-small` | Must stay consistent, or retrieval across a session is comparing incomparable vectors. |
| `MEMORY_EMBEDDING_DIMENSIONS` | `1536` | Must match the model and the vector column width. |
| `NEON_BLOCKS_TRIGGER_SECRET` | `` | Shared secret authenticating trigger delivery. Neon does not sign trigger POSTs. |

Injected automatically by Neon: `DATABASE_URL`, `NEON_AI_GATEWAY_API_KEY`.

## Limits and honest caveats

- **Compaction and retrieval are TODO seams.** The schema, token accounting, and the compaction trigger condition are real; the summarize-and-embed calls are not written.
- **Token counts are caller-supplied or estimated at four characters per token.** That estimate is wrong for code and for non-Latin scripts, and a real tokenizer is the fix.
- **No automatic memory expiry.** A busy agent accumulates sessions indefinitely; TTL is declared per session but nothing enforces it yet.
- **Summaries are lossy by definition.** Compaction trades fidelity for context room, and a detail summarized away is gone — which is why the original turns are retained rather than deleted.
- **Unverified against a live Neon project.** Nothing in this repo has been run against real Neon
  infrastructure yet.

## Observability

```sql
SELECT * FROM blocks_agent_memory.v_status;
```

## Uninstall

```bash
neon-blocks rollback agent-memory
```
