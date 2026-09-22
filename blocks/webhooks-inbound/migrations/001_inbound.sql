-- Block 6: inbound webhook kit.
--
-- The raw archive is the point. Providers do not let you re-request a webhook, so if a handler bug
-- eats an event the only recovery is a replay from bytes you kept. Storing the raw body verbatim
-- also means signatures stay verifiable after the fact, which is what makes replay trustworthy.

CREATE SCHEMA IF NOT EXISTS blocks_webhooks_inbound;

CREATE TABLE IF NOT EXISTS blocks_webhooks_inbound.deliveries (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider        text        NOT NULL,

  -- The provider's own event id. Nullable because GitHub, Shopify and Slack do not all supply one,
  -- in which case dedupe falls back to a body hash.
  provider_event_id text,
  event_type      text,

  -- Raw bytes exactly as received. Never re-serialized -- the signature is over these bytes, and
  -- JSON.stringify(JSON.parse(x)) is a different string.
  raw_body        text        NOT NULL,
  body_sha256     text        NOT NULL,
  headers         jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- 'accepted' means the signature verified and the event was queued. 'rejected' means it did not
  -- verify -- kept deliberately, because a burst of rejections is a signal (rotated secret, or an
  -- attack) and discarding them hides it.
  status          text        NOT NULL DEFAULT 'accepted',
  reject_reason   text,

  received_at     timestamptz NOT NULL DEFAULT now(),
  -- Provider-asserted event time, where the scheme includes one.
  event_at        timestamptz,
  replayed_at     timestamptz,
  replay_count    integer     NOT NULL DEFAULT 0,

  CONSTRAINT deliveries_status_valid CHECK (status IN ('accepted', 'rejected', 'duplicate'))
);

-- Dedupe on the provider's event id where one exists. Partial and per-provider, since two
-- providers can legitimately use the same id string.
CREATE UNIQUE INDEX IF NOT EXISTS deliveries_provider_event_uniq
  ON blocks_webhooks_inbound.deliveries (provider, provider_event_id)
  WHERE provider_event_id IS NOT NULL AND status = 'accepted';

-- Fallback dedupe for providers with no event id: identical bytes within the retry window are
-- almost certainly a redelivery rather than a genuinely repeated event.
CREATE INDEX IF NOT EXISTS deliveries_body_hash_idx
  ON blocks_webhooks_inbound.deliveries (provider, body_sha256, received_at);

CREATE INDEX IF NOT EXISTS deliveries_received_idx
  ON blocks_webhooks_inbound.deliveries (received_at DESC);

CREATE INDEX IF NOT EXISTS deliveries_status_idx
  ON blocks_webhooks_inbound.deliveries (status, received_at DESC);

-- ---------------------------------------------------------------------------
-- Observability (§10)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW blocks_webhooks_inbound.v_by_provider AS
SELECT provider,
       status,
       count(*)          AS deliveries,
       max(received_at)  AS most_recent
FROM blocks_webhooks_inbound.deliveries
GROUP BY provider, status;

CREATE OR REPLACE VIEW blocks_webhooks_inbound.v_status AS
SELECT
  count(*)                                                        AS deliveries_total,
  count(*) FILTER (WHERE status = 'accepted')                      AS deliveries_accepted,
  count(*) FILTER (WHERE status = 'duplicate')                     AS deliveries_duplicate,

  -- The number that matters. A sudden rise almost always means a rotated signing secret that was
  -- not updated here; occasionally it means someone is probing the endpoint.
  count(*) FILTER (WHERE status = 'rejected')                      AS deliveries_rejected,
  count(*) FILTER (WHERE status = 'rejected'
                     AND received_at > now() - interval '1 hour')  AS deliveries_rejected_last_hour,

  count(*) FILTER (WHERE received_at > now() - interval '1 hour')  AS deliveries_last_hour,
  (SELECT count(DISTINCT provider) FROM blocks_webhooks_inbound.deliveries) AS providers_seen
FROM blocks_webhooks_inbound.deliveries;
