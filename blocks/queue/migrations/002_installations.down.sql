-- Reverse 002_installations.
--
-- Dropping this loses the record of which block versions are installed. The blocks themselves keep
-- working -- their schemas and migrations are untouched -- but the console can no longer tell what
-- version anything is, and will treat every block as not-installed. Export
-- blocks_core.installations first if that matters.

DROP VIEW IF EXISTS blocks_core.v_installed_blocks;
DROP TABLE IF EXISTS blocks_core.installation_history;
DROP TABLE IF EXISTS blocks_core.installations;
