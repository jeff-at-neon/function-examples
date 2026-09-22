-- Reverse 001_agent_memory.

DROP VIEW IF EXISTS blocks_agent_memory.v_status;
DROP TABLE IF EXISTS blocks_agent_memory.summaries CASCADE;
DROP TABLE IF EXISTS blocks_agent_memory.turns CASCADE;
DROP TABLE IF EXISTS blocks_agent_memory.sessions CASCADE;
DROP SCHEMA IF EXISTS blocks_agent_memory CASCADE;
