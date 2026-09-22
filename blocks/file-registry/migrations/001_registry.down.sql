-- Reverse 001_registry.
--
-- Note: this drops the SQL index of storage, not the objects themselves. Deleting a user's files
-- as a side effect of uninstalling a block would be indefensible.

DROP VIEW IF EXISTS blocks_file_registry.v_status;
DROP VIEW IF EXISTS blocks_file_registry.v_tenant_usage;
DROP TRIGGER IF EXISTS objects_touch ON blocks_file_registry.objects;
DROP FUNCTION IF EXISTS blocks_file_registry.touch_updated_at();
DROP TABLE IF EXISTS blocks_file_registry.objects;
DROP SCHEMA IF EXISTS blocks_file_registry CASCADE;
