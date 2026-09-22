-- Reverse 001_analytics.

DROP VIEW IF EXISTS blocks_analytics.v_status;
DROP TABLE IF EXISTS blocks_analytics.actor_cohorts CASCADE;
DROP TABLE IF EXISTS blocks_analytics.daily_events CASCADE;
DROP TABLE IF EXISTS blocks_analytics.sessions CASCADE;
DROP TABLE IF EXISTS blocks_analytics.events CASCADE;
DROP SCHEMA IF EXISTS blocks_analytics CASCADE;
