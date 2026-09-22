# Block 3 — Realtime Fan-out

Postgres `LISTEN/NOTIFY` bridged to SSE and WebSocket, with presence, gap-free reconnects, and
live counters. **No Redis. No separate always-on broker service.**

**Rank #3 of 25 — and the one block that is genuinely hard to build anywhere else.**

## Why this is the differentiator

Neon Functions are long-running (sustained operations "lasting minutes") with native
`upgradeWebSocket` and `text/event-stream` support, deployed in the same region as the database.
That combination means:

- **Postgres does the fan-out.** `NOTIFY` is the message bus. No Redis pub/sub to operate.
- **Held connections are cheap.** A subscriber waiting on events is billed at the *waiting* rate
  of $0.025/Capacity-Hour — a **quarter** of the active rate. Idle connections are nearly free
  because the function is genuinely idle.
- **One deployment.** Competitors need an app *plus* a stateful socket service *plus* Redis.

Rough cost for 100 concurrent subscribers held continuously for a month: ~$1.80 in waiting
Capacity-Hours. That is the number that makes this viable.

## Install

```bash
neon-blocks migrate realtime
neon function deploy realtime --src blocks/realtime/src

neon triggers create --function-slug realtime --name realtime-sweep \
  --schedule '*/5 * * * *' --function-path '/sweep'
```

Client:

```js
const stream = new EventSource(`${URL}/subscribe?channels=room:42&actor=user:7`);
stream.addEventListener("message", (e) => console.log(JSON.parse(e.data)));
```

Publish from SQL, app code, or a trigger on your own table:

```sql
SELECT blocks_realtime.publish('room:42', 'message', '{"text":"hello"}');
SELECT blocks_realtime.broadcast_row_trigger();  -- attach to a table for automatic broadcasts
```

## Design decisions worth knowing

**`NOTIFY` carries only a cursor, not the payload.** Postgres caps notification payloads at 8000
bytes, and exceeding it raises — which would roll back *your* transaction. So `publish()` writes a
buffer row and notifies the id; subscribers read the row. Both happen in one statement, so a woken
subscriber is guaranteed to find the row committed.

**One Postgres channel, not one per logical channel.** `LISTEN` is per-connection, so a
channel-per-subscription design needs a connection per channel and collapses at scale. Everything
notifies `blocks_realtime` and subscribers filter in-process.

**Reconnects are gap-free.** The browser sends `Last-Event-ID` automatically; the stream replays
everything after that cursor. A dropped connection loses nothing, which plain `NOTIFY` cannot
offer since it has no history.

**Connections have a hard lifetime** (`REALTIME_MAX_CONNECTION_SECONDS`, default 900). Without it
a stream opened today is still held after a deploy, quietly accruing waiting hours forever. The
client reconnects and resumes from its cursor, so the cap is invisible to users.

**A dedicated pool client per stream, released on every exit path.** A connection in `LISTEN` mode
cannot be reused for queries, and `cancel()` — a browser tab closing — is the *primary* cleanup
path when no abort signal is present. Getting that wrong is the leak that silently exhausts a pool
after a few hundred disconnects.

**`broadcast_row_trigger` sends identity, not full rows.** A broadcast channel may have
subscribers who should not see every column. Clients receive `{op, table, id}` and fetch what
they're permitted to read through your API or the Data API with RLS applied.

## Presence is TTL-based, deliberately

A closing browser tab sends nothing. Any design that waits for an explicit unsubscribe shows
ghosts forever. So presence expires on silence: heartbeats refresh `last_seen_at`, the cron
sweeper deletes stale rows, and `listPresence` filters by TTL at read time so a five-minute cron
doesn't mean five minutes of ghosts.

`REALTIME_PRESENCE_TTL_SECONDS` must exceed `REALTIME_HEARTBEAT_SECONDS` — otherwise live
connections expire between their own heartbeats and presence flickers. The block refuses to start
if you misconfigure that.

## API

| Route | Purpose |
|---|---|
| `GET /subscribe?channels=a,b&actor=user:7` | SSE stream. Honours `Last-Event-ID`. `actor` is optional and enables presence. |
| `POST /publish` | `{channel, event?, payload?}` → `201` with the cursor. |
| `GET /presence?channel=room:42` | Who is connected now. |
| `POST /sweep` | Cron. Expires presence, prunes the replay buffer. |
| `GET /health` | `200` healthy, `503` degraded. |

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `REALTIME_MAX_CONNECTION_SECONDS` | `900` | Hard stream lifetime. Bounds held waiting hours. |
| `REALTIME_HEARTBEAT_SECONDS` | `25` | Under 30s, since proxies close idle streams around then. |
| `REALTIME_MAX_CHANNELS_PER_CONNECTION` | `16` | Counted **after** deduplication. |
| `REALTIME_PRESENCE_TTL_SECONDS` | `60` | Must exceed the heartbeat interval. |
| `REALTIME_EVENT_RETENTION_MINUTES` | `60` | Replay window, not an event log. |

## Limits and honest caveats

- **WebSocket upgrade is not implemented.** SSE covers server→client fan-out, which is the
  overwhelming majority of realtime use. Bidirectional WS is a natural follow-on via
  `upgradeWebSocket`; the channel and presence logic is transport-agnostic and would be reused.
- **The replay buffer is a window, not a log.** Events older than retention are pruned. For
  durable eventing use block 1 (`queue`).
- **Presence records one channel per connection.** A multi-channel subscriber is recorded on its
  first channel. Full multi-channel presence needs a row per channel — deliberately deferred
  rather than half-implemented.
- **No authorization.** Any client that can reach the function can subscribe to any channel. Put
  it behind your own auth, or block 12 (`api-edge`). This is the most important caveat here.
- **Not load-tested.** The connection accounting is written carefully but has not been run against
  a live Neon project, and the per-function connection ceiling is undocumented.

## Observability

```sql
SELECT * FROM blocks_realtime.v_status;
SELECT * FROM blocks_realtime.v_presence_by_channel;
```

`connections_stale` above zero means the sweeper isn't running and presence shows ghosts — check
the trigger is enabled on this branch (child branches inherit them **disabled**).

## Uninstall

```bash
neon-blocks rollback realtime
```

Drops `blocks_realtime`. Triggers you attached with `broadcast_row_trigger` are dropped with
`CASCADE`, since leaving them would error on every write to those tables.
