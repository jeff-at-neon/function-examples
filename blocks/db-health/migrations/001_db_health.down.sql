-- Reverse 001_db_health.

DROP VIEW IF EXISTS blocks_db_health.v_status;
DROP TABLE IF EXISTS blocks_db_health.query_stats CASCADE;
DROP TABLE IF EXISTS blocks_db_health.findings CASCADE;
DROP TABLE IF EXISTS blocks_db_health.snapshots CASCADE;
DROP SCHEMA IF EXISTS blocks_db_health CASCADE;
