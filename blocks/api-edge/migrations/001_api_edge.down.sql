-- Reverse 001_api_edge.

DROP VIEW IF EXISTS blocks_api_edge.v_status;
DROP TABLE IF EXISTS blocks_api_edge.idempotency CASCADE;
DROP TABLE IF EXISTS blocks_api_edge.rate_windows CASCADE;
DROP TABLE IF EXISTS blocks_api_edge.api_keys CASCADE;
DROP SCHEMA IF EXISTS blocks_api_edge CASCADE;
