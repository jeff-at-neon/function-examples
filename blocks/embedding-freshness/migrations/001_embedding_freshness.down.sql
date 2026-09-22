-- Reverse 001_embedding_freshness.

DROP VIEW IF EXISTS blocks_embedding_freshness.v_status;
DROP TABLE IF EXISTS blocks_embedding_freshness.pending CASCADE;
DROP TABLE IF EXISTS blocks_embedding_freshness.embedded_state CASCADE;
DROP TABLE IF EXISTS blocks_embedding_freshness.sources CASCADE;
DROP SCHEMA IF EXISTS blocks_embedding_freshness CASCADE;
