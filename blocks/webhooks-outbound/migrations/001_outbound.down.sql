-- Reverse 001_outbound.
--
-- Destroys endpoint registrations INCLUDING their signing secrets. Subscribers cannot re-derive
-- those, so every integration would need re-provisioning. Export endpoints before rolling back.

DROP VIEW IF EXISTS blocks_webhooks_outbound.v_status;
DROP VIEW IF EXISTS blocks_webhooks_outbound.v_endpoint_health;
DROP TRIGGER IF EXISTS endpoints_touch ON blocks_webhooks_outbound.endpoints;
DROP FUNCTION IF EXISTS blocks_webhooks_outbound.touch_updated_at();
DROP TABLE IF EXISTS blocks_webhooks_outbound.attempts;
DROP TABLE IF EXISTS blocks_webhooks_outbound.deliveries;
DROP TABLE IF EXISTS blocks_webhooks_outbound.endpoints;
DROP SCHEMA IF EXISTS blocks_webhooks_outbound CASCADE;
