-- Reverse 001_inbound.
--
-- This destroys the raw archive, which is the only copy of events providers will not resend. The
-- CLI prints no special warning for this, so it is stated here: back up
-- blocks_webhooks_inbound.deliveries before rolling back if replay matters.

DROP VIEW IF EXISTS blocks_webhooks_inbound.v_status;
DROP VIEW IF EXISTS blocks_webhooks_inbound.v_by_provider;
DROP TABLE IF EXISTS blocks_webhooks_inbound.deliveries;
DROP SCHEMA IF EXISTS blocks_webhooks_inbound CASCADE;
