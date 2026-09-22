-- Reverse 001_csv_import.

DROP VIEW IF EXISTS blocks_csv_import.v_status;
DROP TABLE IF EXISTS blocks_csv_import.row_errors CASCADE;
DROP TABLE IF EXISTS blocks_csv_import.imports CASCADE;
DROP TABLE IF EXISTS blocks_csv_import.definitions CASCADE;
DROP SCHEMA IF EXISTS blocks_csv_import CASCADE;
