-- Reverse 001_doc_extraction.

DROP VIEW IF EXISTS blocks_doc_extraction.v_status;
DROP TABLE IF EXISTS blocks_doc_extraction.review_queue CASCADE;
DROP TABLE IF EXISTS blocks_doc_extraction.extractions CASCADE;
DROP TABLE IF EXISTS blocks_doc_extraction.schemas CASCADE;
DROP SCHEMA IF EXISTS blocks_doc_extraction CASCADE;
