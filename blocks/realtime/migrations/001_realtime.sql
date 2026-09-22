-- Block 3: realtime fan-out.
--
-- LISTEN/NOTIFY does the live delivery; these tables exist for the things NOTIFY cannot do:
--   * replay after reconnect  (NOTIFY has no history -- a client that drops loses messages)
--   * presence                (who is connected right now)
--   * payloads over 8000 bytes (NOTIFY's hard limit)

CREATE SCHEMA IF NOT EXISTS blocks_realtime;

-- Short-lived ring buffer, not an event log. Its only job is letting a reconnecting client
-- catch up on what it missed; the queue block owns durable eventing.
CREATE TABLE IF NOT EXISTS blocks_realtime.events (
  -- Monotonic cursor. bigserial rather than a timestamp because two events in the same
  -- microsecond must still have a total order for "everything after id X" to be exact.
  id           bigserial   PRIMARY KEY,
  channel      text        NOT NULL,
  event        text        NOT NULL DEFAULT 'message',
  payload      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT events_channel_shape CHECK (channel ~ '^[a-zA-Z0-9_:.-]{1,128}$')
);

CREATE INDEX IF NOT EXISTS events_channel_id_idx ON blocks_realtime.events (channel, id);
CREATE INDEX IF NOT EXISTS events_created_idx ON blocks_realtime.events (created_at);

CREATE TABLE IF NOT EXISTS blocks_realtime.presence (
  connection_id  uuid        PRIMARY KEY,
  channel        text        NOT NULL,
  -- Application-level identity: a user id, a session id, whatever the caller supplies.
  actor          text        NOT NULL,
  metadata       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  connected_at   timestamptz NOT NULL DEFAULT now(),
  -- Refreshed by each heartbeat. Connections die without unsubscribing -- a browser tab closing
  -- sends nothing -- so presence must expire on silence rather than on an explicit goodbye.
  last_seen_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT presence_channel_shape CHECK (channel ~ '^[a-zA-Z0-9_:.-]{1,128}$')
);

CREATE INDEX IF NOT EXISTS presence_channel_idx ON blocks_realtime.presence (channel);
CREATE INDEX IF NOT EXISTS presence_last_seen_idx ON blocks_realtime.presence (last_seen_at);

-- ---------------------------------------------------------------------------
-- Publish
-- ---------------------------------------------------------------------------

-- Writes the buffer row and fires NOTIFY in one statement, so a subscriber woken by the
-- notification is guaranteed to find the row already committed. Doing these separately creates a
-- race where a client is told "something happened" and then cannot find what.
CREATE OR REPLACE FUNCTION blocks_realtime.publish(
  p_channel text,
  p_event   text,
  p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_id       bigint;
  v_notify   text;
BEGIN
  INSERT INTO blocks_realtime.events (channel, event, payload)
  VALUES (p_channel, p_event, p_payload)
  RETURNING id INTO v_id;

  -- NOTIFY payloads are capped at 8000 bytes. Send only the cursor and let the subscriber read
  -- the row: a large payload would otherwise raise and roll back the caller's transaction.
  v_notify := json_build_object('id', v_id, 'channel', p_channel, 'event', p_event)::text;

  -- Single fixed channel name, not one per logical channel. Postgres LISTEN names are limited
  -- and a per-channel LISTEN would need a new connection per subscription, which does not scale
  -- to thousands of channels on a fixed-size function.
  PERFORM pg_notify('blocks_realtime', v_notify);

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION blocks_realtime.publish(text, text, jsonb) IS
  'Publish to a realtime channel. Call from app code or from a trigger on your own table.';

-- Convenience trigger function: broadcast row changes on one of your tables.
-- Not a substitute for row-event triggers into Functions (those do not exist); this is
-- Postgres-internal NOTIFY, which is why it works today.
CREATE OR REPLACE FUNCTION blocks_realtime.broadcast_row_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_channel text := TG_ARGV[0];
  v_row     jsonb;
BEGIN
  v_row := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;

  PERFORM blocks_realtime.publish(
    v_channel,
    lower(TG_OP),
    -- Deliberately does NOT include the full row: a broadcast channel may have subscribers who
    -- should not see every column. Send identity and let clients fetch what they are permitted
    -- to read through your own API or the Data API with RLS applied.
    jsonb_build_object(
      'op', TG_OP,
      'table', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
      'id', v_row ->> COALESCE(TG_ARGV[1], 'id')
    )
  );
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION blocks_realtime.broadcast_row_trigger() IS
  'Broadcasts row-change notifications (identity only, not full rows) to a realtime channel.';

-- ---------------------------------------------------------------------------
-- Observability (§10)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW blocks_realtime.v_presence_by_channel AS
SELECT channel,
       count(*)            AS connections,
       count(DISTINCT actor) AS actors,
       max(last_seen_at)   AS most_recent_heartbeat
FROM blocks_realtime.presence
GROUP BY channel;

CREATE OR REPLACE VIEW blocks_realtime.v_status AS
SELECT
  (SELECT count(*) FROM blocks_realtime.presence)                   AS connections_total,
  (SELECT count(DISTINCT channel) FROM blocks_realtime.presence)    AS channels_active,

  -- Presence records with no recent heartbeat. A growing number means the sweeper is not
  -- running, and presence lists will show ghosts.
  (SELECT count(*) FROM blocks_realtime.presence
     WHERE last_seen_at < now() - interval '2 minutes')             AS connections_stale,

  (SELECT count(*) FROM blocks_realtime.events)                     AS buffered_events,
  -- An unbounded buffer is the failure mode here: the table is a replay window, not a log.
  (SELECT count(*) FROM blocks_realtime.events
     WHERE created_at < now() - interval '1 hour')                  AS buffered_events_expired,
  (SELECT COALESCE(max(id), 0) FROM blocks_realtime.events)         AS latest_cursor;
