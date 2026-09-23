-- Block 26: chat + agent endpoint.
--
-- A streaming chat/agent endpoint that lives on the branch next to Postgres. Conversations and
-- their messages are persisted here rather than held in memory: a Function isolate is reused
-- across requests and evicted without warning, so anything that must survive a restart lives in
-- the database, not module scope.

CREATE SCHEMA IF NOT EXISTS blocks_chat;

CREATE TABLE IF NOT EXISTS blocks_chat.conversations (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Who owns this conversation. From the authenticated subject (Neon Auth JWT sub, or a fixed
  -- value for the shared-key path). Scoping every read and write to it is what stops one caller
  -- from reading another's history through a guessed conversation id.
  tenant      text        NOT NULL,

  title       text,
  metadata    jsonb       NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversations_tenant_idx
  ON blocks_chat.conversations (tenant, updated_at DESC);

CREATE TABLE IF NOT EXISTS blocks_chat.messages (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   uuid        NOT NULL REFERENCES blocks_chat.conversations (id) ON DELETE CASCADE,

  role              text        NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content           text        NOT NULL,

  -- What produced an assistant message, so a reply from a weaker model is never mistaken for one
  -- from a stronger one, and cost can be attributed.
  model             text,
  prompt_tokens     integer,
  completion_tokens integer,

  -- Idempotency key supplied by the client. A retried request with the same key returns the stored
  -- assistant reply instead of calling the model again, so a dropped connection does not double-bill.
  client_message_id text,

  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_conversation_idx
  ON blocks_chat.messages (conversation_id, created_at);

-- One stored assistant reply per client message id within a conversation. Partial, so unkeyed
-- messages (system/tool records, or clients that do not send a key) are never blocked.
CREATE UNIQUE INDEX IF NOT EXISTS messages_idempotency_idx
  ON blocks_chat.messages (conversation_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

-- Convention 10: is this healthy right now? Derived so the SQL answer and the /health answer
-- cannot drift.
CREATE OR REPLACE VIEW blocks_chat.v_status AS
SELECT
  (SELECT count(*) FROM blocks_chat.conversations)                         AS conversations,
  (SELECT count(*) FROM blocks_chat.messages
     WHERE created_at > now() - interval '1 hour')                         AS messages_last_hour,
  (SELECT coalesce(sum(completion_tokens), 0) FROM blocks_chat.messages
     WHERE created_at > now() - interval '1 hour')                         AS output_tokens_last_hour,
  (SELECT max(created_at) FROM blocks_chat.messages)                       AS last_message_at;
