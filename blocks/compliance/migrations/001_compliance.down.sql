-- Reverse 001_compliance.
--
-- This destroys the audit log. That is usually the single most compliance-significant table in the database, and its whole value is that it cannot be quietly removed. Export it, with the chain intact, before rolling back.

DROP VIEW IF EXISTS blocks_compliance.v_status;
DROP FUNCTION IF EXISTS blocks_compliance.attach_audit_trigger(text, text, text) CASCADE;
DROP FUNCTION IF EXISTS blocks_compliance.audit_row_trigger() CASCADE;
DROP TABLE IF EXISTS blocks_compliance.legal_holds CASCADE;
DROP TABLE IF EXISTS blocks_compliance.subject_requests CASCADE;
DROP TABLE IF EXISTS blocks_compliance.subject_links CASCADE;
DROP TABLE IF EXISTS blocks_compliance.audit_log CASCADE;
DROP SCHEMA IF EXISTS blocks_compliance CASCADE;
