-- Reverse 001_router.

DROP VIEW IF EXISTS blocks_ingest_router.v_status;
DROP VIEW IF EXISTS blocks_ingest_router.v_by_kind;
DROP TABLE IF EXISTS blocks_ingest_router.dispatches;
DROP SCHEMA IF EXISTS blocks_ingest_router CASCADE;
