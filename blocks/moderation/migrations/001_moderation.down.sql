-- Reverse 001_moderation.

DROP VIEW IF EXISTS blocks_moderation.v_status;
DROP TABLE IF EXISTS blocks_moderation.decisions CASCADE;
DROP TABLE IF EXISTS blocks_moderation.items CASCADE;
DROP SCHEMA IF EXISTS blocks_moderation CASCADE;
