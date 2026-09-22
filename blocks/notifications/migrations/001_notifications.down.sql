-- Reverse 001_notifications.

DROP VIEW IF EXISTS blocks_notifications.v_status;
DROP TABLE IF EXISTS blocks_notifications.notifications CASCADE;
DROP TABLE IF EXISTS blocks_notifications.preferences CASCADE;
DROP TABLE IF EXISTS blocks_notifications.templates CASCADE;
DROP SCHEMA IF EXISTS blocks_notifications CASCADE;
