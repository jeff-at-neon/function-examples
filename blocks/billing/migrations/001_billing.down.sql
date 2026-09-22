-- Reverse 001_billing.
--
-- This destroys usage_events, which is the audit trail behind invoices already sent. If any billing
-- dispute could still arise, export it first -- the aggregate rollups are not a substitute, because
-- a disputed invoice can only be answered with the individual events.

DROP VIEW IF EXISTS blocks_billing.v_status;
DROP VIEW IF EXISTS blocks_billing.v_entitlements;

DROP TRIGGER IF EXISTS subscriptions_touch ON blocks_billing.subscriptions;
DROP TRIGGER IF EXISTS customers_touch ON blocks_billing.customers;
DROP FUNCTION IF EXISTS blocks_billing.touch_updated_at();

DROP TABLE IF EXISTS blocks_billing.dunning_notices;
DROP TABLE IF EXISTS blocks_billing.usage_rollups;
DROP TABLE IF EXISTS blocks_billing.usage_events;
DROP TABLE IF EXISTS blocks_billing.subscriptions;
DROP TABLE IF EXISTS blocks_billing.customers;
DROP TABLE IF EXISTS blocks_billing.plans;
DROP SCHEMA IF EXISTS blocks_billing CASCADE;
