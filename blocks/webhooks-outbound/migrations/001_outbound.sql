-- Block 10: outbound webhook delivery.
--
-- Here you are the provider: your users' customers register endpoints and you deliver signed events
-- to them. This is Svix's entire business, and it is the highest per-event pricing power in the
-- catalog because the volume grows with your customer's own success.

CREATE SCHEMA IF NOT EXISTS blocks_webhooks_outbound;

CREATE TABLE IF NOT EXISTS blocks_webhooks_outbound.endpoints (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Whose endpoint this is, in your own identifier space.
  subscriber_ref  text        NOT NULL,
  url             text        NOT NULL,
  description     text,

  -- Event types this endpoint wants. Empty means all. Supports 'order.*' wildcards.
  event_types     text[]      NOT NULL DEFAULT '{}',

  -- Signing secrets, newest first. Plural because rotation needs an overlap window: we sign with
  -- every secret, the subscriber verifies with either, and neither side needs a synchronised cutover.
  secrets         text[]      NOT NULL,

  is_active       boolean     NOT NULL DEFAULT true,

  -- Circuit breaker state. Per-endpoint so one dead endpoint cannot consume the delivery budget for
  -- every other subscriber.
  consecutive_failures integer NOT NULL DEFAULT 0,
  circuit_opened_at    timestamptz,
  -- Set after disableThreshold failures. Requires manual re-enabling: past that point the endpoint
  -- is gone rather than flaky, and automatic retries cost money to deliver to nobody.
  disabled_at          timestamptz,

  last_success_at timestamptz,
  last_failure_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT endpoints_secrets_present CHECK (cardinality(secrets) >= 1),
  CONSTRAINT endpoints_https CHECK (url LIKE 'https://%')
);

CREATE INDEX IF NOT EXISTS endpoints_subscriber_idx ON blocks_webhooks_outbound.endpoints (subscriber_ref);
CREATE INDEX IF NOT EXISTS endpoints_active_idx
  ON blocks_webhooks_outbound.endpoints (is_active) WHERE is_active AND disabled_at IS NULL;
CREATE INDEX IF NOT EXISTS endpoints_event_types_idx
  ON blocks_webhooks_outbound.endpoints USING gin (event_types);

-- One row per (event, endpoint). Separate from the event itself because the same event fans out to
-- many endpoints and each has independent retry state.
CREATE TABLE IF NOT EXISTS blocks_webhooks_outbound.deliveries (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id   uuid        NOT NULL REFERENCES blocks_webhooks_outbound.endpoints(id) ON DELETE CASCADE,

  event_type    text        NOT NULL,
  -- Stable id included in the signature, so a subscriber can dedupe and so a valid body cannot be
  -- replayed as a different event.
  event_id      text        NOT NULL,
  payload       jsonb       NOT NULL,

  status        text        NOT NULL DEFAULT 'pending',
  attempts      integer     NOT NULL DEFAULT 0,
  max_attempts  integer     NOT NULL DEFAULT 12,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),

  -- Last response, for the delivery log subscribers inspect when debugging their own endpoint.
  response_status integer,
  response_body   text,
  error           text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  delivered_at  timestamptz,

  CONSTRAINT deliveries_status_valid
    CHECK (status IN ('pending', 'delivered', 'failed', 'dead', 'skipped')),
  -- One delivery per event per endpoint. Makes fan-out idempotent: re-publishing the same event id
  -- cannot double-deliver.
  CONSTRAINT deliveries_event_endpoint_uniq UNIQUE (endpoint_id, event_id)
);

CREATE INDEX IF NOT EXISTS deliveries_due_idx
  ON blocks_webhooks_outbound.deliveries (next_attempt_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS deliveries_endpoint_idx
  ON blocks_webhooks_outbound.deliveries (endpoint_id, created_at DESC);

CREATE INDEX IF NOT EXISTS deliveries_dead_idx
  ON blocks_webhooks_outbound.deliveries (created_at DESC) WHERE status = 'dead';

-- Per-attempt history. The endpoint owner debugging their own integration needs to see the actual
-- requests, not just the final outcome -- and "it worked on attempt 4 after three 502s" is the
-- answer that resolves most support tickets.
CREATE TABLE IF NOT EXISTS blocks_webhooks_outbound.attempts (
  id            bigserial   PRIMARY KEY,
  delivery_id   uuid        NOT NULL REFERENCES blocks_webhooks_outbound.deliveries(id) ON DELETE CASCADE,
  attempt       integer     NOT NULL,
  response_status integer,
  duration_ms   integer,
  error         text,
  attempted_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS attempts_delivery_idx ON blocks_webhooks_outbound.attempts (delivery_id, attempt);

CREATE OR REPLACE FUNCTION blocks_webhooks_outbound.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS endpoints_touch ON blocks_webhooks_outbound.endpoints;
CREATE TRIGGER endpoints_touch BEFORE UPDATE ON blocks_webhooks_outbound.endpoints
  FOR EACH ROW EXECUTE FUNCTION blocks_webhooks_outbound.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Observability (§10)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW blocks_webhooks_outbound.v_endpoint_health AS
SELECT e.id,
       e.subscriber_ref,
       e.url,
       e.is_active,
       e.disabled_at IS NOT NULL                     AS is_disabled,
       e.circuit_opened_at IS NOT NULL
         AND e.consecutive_failures >= 5             AS circuit_open,
       e.consecutive_failures,
       e.last_success_at,
       e.last_failure_at,
       count(d.id) FILTER (WHERE d.status = 'pending') AS pending_deliveries,
       count(d.id) FILTER (WHERE d.status = 'dead')    AS dead_deliveries
FROM blocks_webhooks_outbound.endpoints e
LEFT JOIN blocks_webhooks_outbound.deliveries d ON d.endpoint_id = e.id
GROUP BY e.id;

CREATE OR REPLACE VIEW blocks_webhooks_outbound.v_status AS
SELECT
  (SELECT count(*) FROM blocks_webhooks_outbound.endpoints
     WHERE is_active AND disabled_at IS NULL)                     AS endpoints_active,
  (SELECT count(*) FROM blocks_webhooks_outbound.endpoints
     WHERE disabled_at IS NOT NULL)                               AS endpoints_disabled,
  -- Endpoints currently circuit-broken. Distinct from disabled: these recover on their own.
  (SELECT count(*) FROM blocks_webhooks_outbound.endpoints
     WHERE consecutive_failures >= 5 AND disabled_at IS NULL)      AS endpoints_circuit_open,

  (SELECT count(*) FROM blocks_webhooks_outbound.deliveries
     WHERE status = 'pending')                                     AS deliveries_pending,
  (SELECT count(*) FROM blocks_webhooks_outbound.deliveries
     WHERE status = 'pending' AND next_attempt_at <= now())        AS deliveries_due,
  (SELECT count(*) FROM blocks_webhooks_outbound.deliveries
     WHERE status = 'dead')                                        AS deliveries_dead,
  (SELECT count(*) FROM blocks_webhooks_outbound.deliveries
     WHERE status = 'delivered' AND delivered_at > now() - interval '1 hour')
                                                                   AS delivered_last_hour,

  -- Age of the oldest due delivery. The number to alert on: if it climbs, the sender cron is not
  -- running (child branches inherit triggers DISABLED) or every endpoint is failing.
  (SELECT COALESCE(EXTRACT(EPOCH FROM (now() - min(next_attempt_at)))::bigint, 0)
     FROM blocks_webhooks_outbound.deliveries
     WHERE status = 'pending' AND next_attempt_at <= now())         AS oldest_due_seconds;
