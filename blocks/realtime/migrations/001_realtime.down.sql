-- Reverse 001_realtime.
--
-- CASCADE on broadcast_row_trigger because users may have attached it to their own tables;
-- leaving triggers that call a missing function would error on every write to those tables.

DROP VIEW IF EXISTS blocks_realtime.v_status;
DROP VIEW IF EXISTS blocks_realtime.v_presence_by_channel;
DROP FUNCTION IF EXISTS blocks_realtime.broadcast_row_trigger() CASCADE;
DROP FUNCTION IF EXISTS blocks_realtime.publish(text, text, jsonb);
DROP TABLE IF EXISTS blocks_realtime.presence;
DROP TABLE IF EXISTS blocks_realtime.events;
DROP SCHEMA IF EXISTS blocks_realtime CASCADE;
