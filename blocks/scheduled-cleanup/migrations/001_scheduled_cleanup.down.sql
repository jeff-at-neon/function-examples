-- Reverse 001_scheduled_cleanup.

DROP VIEW IF EXISTS blocks_scheduled_cleanup.v_status;
DROP TABLE IF EXISTS blocks_scheduled_cleanup.runs CASCADE;
DROP TABLE IF EXISTS blocks_scheduled_cleanup.expiring_records CASCADE;
DROP SCHEMA IF EXISTS blocks_scheduled_cleanup CASCADE;
