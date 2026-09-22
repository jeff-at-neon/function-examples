-- Reverse 001_feature_flags.

DROP VIEW IF EXISTS blocks_feature_flags.v_status;
DROP TABLE IF EXISTS blocks_feature_flags.results CASCADE;
DROP TABLE IF EXISTS blocks_feature_flags.conversions CASCADE;
DROP TABLE IF EXISTS blocks_feature_flags.exposures CASCADE;
DROP TABLE IF EXISTS blocks_feature_flags.overrides CASCADE;
DROP TABLE IF EXISTS blocks_feature_flags.flags CASCADE;
DROP SCHEMA IF EXISTS blocks_feature_flags CASCADE;
