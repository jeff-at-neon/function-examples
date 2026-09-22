-- Reverse 001_queue_core.
--
-- blocks_queue is dropped entirely. blocks_core is NOT: other blocks store their own state
-- there and the migration ledger itself lives there. Only this migration's own objects in
-- blocks_core are removed.

DROP VIEW IF EXISTS blocks_queue.v_status;
DROP VIEW IF EXISTS blocks_queue.v_job_stats;
DROP VIEW IF EXISTS blocks_queue.v_dead_letters;
DROP TABLE IF EXISTS blocks_queue.jobs;
DROP SCHEMA IF EXISTS blocks_queue CASCADE;

DROP FUNCTION IF EXISTS blocks_core.attach_outbox_trigger(text, text, text, text);
-- Any triggers a user attached to their own tables depend on this function, so CASCADE is
-- required. They asked to uninstall the block; leaving orphaned triggers that error on every
-- write would be worse.
DROP FUNCTION IF EXISTS blocks_core.outbox_row_trigger() CASCADE;
DROP TABLE IF EXISTS blocks_core.outbox_events;

-- blocks_core.migrations and the schema itself are intentionally left in place.
