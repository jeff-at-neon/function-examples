-- Reverse 001_pii_anonymizer.

DROP VIEW IF EXISTS blocks_pii_anonymizer.v_status;
DROP TABLE IF EXISTS blocks_pii_anonymizer.runs CASCADE;
DROP TABLE IF EXISTS blocks_pii_anonymizer.rules CASCADE;
DROP SCHEMA IF EXISTS blocks_pii_anonymizer CASCADE;
