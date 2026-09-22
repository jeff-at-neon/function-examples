-- Block 8: billing spine.
--
-- Normalizes whatever your payment provider sends into tables your application can actually query,
-- so "can this customer do this?" is a local indexed lookup rather than an API call on the request
-- path. That distinction is the whole point: a Stripe API call in your authorization path means
-- Stripe's latency and Stripe's outages become yours.

CREATE SCHEMA IF NOT EXISTS blocks_billing;

-- Plans are defined here, not at the provider. Provider price objects describe money; they do not
-- describe what a plan is allowed to do. Keeping entitlements local also means a plan change does
-- not require a provider round trip to evaluate.
CREATE TABLE IF NOT EXISTS blocks_billing.plans (
  code          text        PRIMARY KEY,
  name          text        NOT NULL,
  -- Provider price/plan identifiers that map onto this plan. An array because the same plan usually
  -- has monthly and annual prices, and often legacy grandfathered ones.
  provider_ids  text[]      NOT NULL DEFAULT '{}',
  features      text[]      NOT NULL DEFAULT '{}',
  -- metric -> limit. JSON null means unlimited; an absent key means the metric is not granted at
  -- all. Those are deliberately different, and conflating them either blocks paying customers or
  -- gives usage away.
  limits        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS plans_provider_ids_idx ON blocks_billing.plans USING gin (provider_ids);

CREATE TABLE IF NOT EXISTS blocks_billing.customers (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Your identifier for the account: tenant, org, or user id. The join key to your own tables.
  account_ref        text        NOT NULL,
  provider           text        NOT NULL DEFAULT 'stripe',
  provider_customer_id text      NOT NULL,
  email              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT customers_provider_uniq UNIQUE (provider, provider_customer_id),
  CONSTRAINT customers_account_uniq UNIQUE (provider, account_ref)
);

CREATE TABLE IF NOT EXISTS blocks_billing.subscriptions (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id            uuid        NOT NULL REFERENCES blocks_billing.customers(id) ON DELETE CASCADE,
  provider               text        NOT NULL DEFAULT 'stripe',
  provider_subscription_id text      NOT NULL,

  plan_code              text        REFERENCES blocks_billing.plans(code),
  status                 text        NOT NULL,

  current_period_start   timestamptz,
  current_period_end     timestamptz,
  trial_end              timestamptz,
  cancel_at              timestamptz,
  canceled_at            timestamptz,

  -- Provider event ordering is not guaranteed, so an out-of-order webhook can otherwise overwrite
  -- newer state with older. Updates are rejected when this is not newer than what we hold.
  provider_updated_at    timestamptz,

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT subscriptions_provider_uniq UNIQUE (provider, provider_subscription_id),
  CONSTRAINT subscriptions_status_valid CHECK (
    status IN ('trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete', 'paused')
  )
);

CREATE INDEX IF NOT EXISTS subscriptions_customer_idx ON blocks_billing.subscriptions (customer_id);
CREATE INDEX IF NOT EXISTS subscriptions_status_idx ON blocks_billing.subscriptions (status);
-- Serves the dunning sweeper without scanning healthy subscriptions.
CREATE INDEX IF NOT EXISTS subscriptions_overdue_idx
  ON blocks_billing.subscriptions (current_period_end)
  WHERE status IN ('past_due', 'unpaid');
-- Serves the trial-expiry sweeper.
CREATE INDEX IF NOT EXISTS subscriptions_trial_idx
  ON blocks_billing.subscriptions (trial_end)
  WHERE status = 'trialing';

-- ---------------------------------------------------------------------------
-- Usage metering
-- ---------------------------------------------------------------------------
-- Raw events, aggregated by view rather than by incrementing a counter. A counter is a lost
-- audit trail: when a customer disputes an invoice the only useful answer is the individual
-- events, and you cannot reconstruct those from a number.

CREATE TABLE IF NOT EXISTS blocks_billing.usage_events (
  id             bigserial   PRIMARY KEY,
  customer_id    uuid        NOT NULL REFERENCES blocks_billing.customers(id) ON DELETE CASCADE,
  metric         text        NOT NULL,
  quantity       numeric     NOT NULL DEFAULT 1,

  -- Caller-supplied dedupe key. Metering is usually driven by at-least-once events, so without
  -- this a redelivery double-bills -- the most damaging bug this block could have.
  idempotency_key text,

  occurred_at    timestamptz NOT NULL DEFAULT now(),
  metadata       jsonb       NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT usage_quantity_sane CHECK (quantity >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS usage_idempotency_uniq
  ON blocks_billing.usage_events (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS usage_customer_metric_idx
  ON blocks_billing.usage_events (customer_id, metric, occurred_at);

-- Periodic rollups, so quota checks do not aggregate the full event history on every request.
CREATE TABLE IF NOT EXISTS blocks_billing.usage_rollups (
  customer_id   uuid        NOT NULL REFERENCES blocks_billing.customers(id) ON DELETE CASCADE,
  metric        text        NOT NULL,
  period_start  timestamptz NOT NULL,
  period_end    timestamptz NOT NULL,
  total         numeric     NOT NULL DEFAULT 0,
  event_count   integer     NOT NULL DEFAULT 0,
  computed_at   timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (customer_id, metric, period_start)
);

-- ---------------------------------------------------------------------------
-- Dunning
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS blocks_billing.dunning_notices (
  id              bigserial   PRIMARY KEY,
  subscription_id uuid        NOT NULL REFERENCES blocks_billing.subscriptions(id) ON DELETE CASCADE,
  -- Escalation step. Recorded so a customer who has had three notices is not sent a fourth
  -- identical one on the next cron run.
  stage           integer     NOT NULL,
  days_overdue    integer     NOT NULL,
  sent_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT dunning_stage_once UNIQUE (subscription_id, stage)
);

CREATE OR REPLACE FUNCTION blocks_billing.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS customers_touch ON blocks_billing.customers;
CREATE TRIGGER customers_touch BEFORE UPDATE ON blocks_billing.customers
  FOR EACH ROW EXECUTE FUNCTION blocks_billing.touch_updated_at();

DROP TRIGGER IF EXISTS subscriptions_touch ON blocks_billing.subscriptions;
CREATE TRIGGER subscriptions_touch BEFORE UPDATE ON blocks_billing.subscriptions
  FOR EACH ROW EXECUTE FUNCTION blocks_billing.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Entitlement lookup
-- ---------------------------------------------------------------------------

-- The view the application joins against. Denormalized on purpose: authorization happens on every
-- request, and a three-table join there is a cost you pay forever.
CREATE OR REPLACE VIEW blocks_billing.v_entitlements AS
SELECT c.account_ref,
       c.id                    AS customer_id,
       s.id                    AS subscription_id,
       s.status,
       s.plan_code,
       s.current_period_start,
       s.current_period_end,
       s.trial_end,
       s.cancel_at,
       COALESCE(p.features, '{}')      AS features,
       COALESCE(p.limits, '{}'::jsonb) AS limits
FROM blocks_billing.customers c
LEFT JOIN blocks_billing.subscriptions s ON s.customer_id = c.id
LEFT JOIN blocks_billing.plans p ON p.code = s.plan_code;

-- ---------------------------------------------------------------------------
-- Observability (§10)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW blocks_billing.v_status AS
SELECT
  (SELECT count(*) FROM blocks_billing.customers)                     AS customers_total,
  (SELECT count(*) FROM blocks_billing.subscriptions
     WHERE status = 'active')                                         AS subscriptions_active,
  (SELECT count(*) FROM blocks_billing.subscriptions
     WHERE status = 'trialing')                                       AS subscriptions_trialing,
  (SELECT count(*) FROM blocks_billing.subscriptions
     WHERE status IN ('past_due', 'unpaid'))                          AS subscriptions_overdue,

  -- Subscriptions referencing a plan code that does not exist. These evaluate to "no plan", which
  -- denies every feature -- a paying customer locked out by a config mistake, and invisible without
  -- this check.
  (SELECT count(*) FROM blocks_billing.subscriptions s
     WHERE s.plan_code IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM blocks_billing.plans p WHERE p.code = s.plan_code))
                                                                      AS subscriptions_orphan_plan,
  (SELECT count(*) FROM blocks_billing.subscriptions WHERE plan_code IS NULL)
                                                                      AS subscriptions_no_plan,

  (SELECT count(*) FROM blocks_billing.usage_events
     WHERE occurred_at > now() - interval '1 day')                    AS usage_events_last_day,
  (SELECT count(*) FROM blocks_billing.plans WHERE is_active)         AS plans_active;
