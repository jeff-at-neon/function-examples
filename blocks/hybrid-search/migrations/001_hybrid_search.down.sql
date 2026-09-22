-- Reverse 001_hybrid_search.
--
-- Drops the retrieval-only index it added to blocks_rag.chunks, but not the table or the
-- extensions: pg_trgm and unaccent may be in use elsewhere, and the chunks belong to the rag block.

DROP INDEX IF EXISTS blocks_rag.chunks_content_trgm_idx;

DROP VIEW IF EXISTS blocks_hybrid_search.v_status;
DROP VIEW IF EXISTS blocks_hybrid_search.v_zero_result_queries;
DROP TABLE IF EXISTS blocks_hybrid_search.clicks;
DROP TABLE IF EXISTS blocks_hybrid_search.queries;
DROP SCHEMA IF EXISTS blocks_hybrid_search CASCADE;
