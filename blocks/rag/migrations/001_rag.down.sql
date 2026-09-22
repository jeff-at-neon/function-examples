-- Reverse 001_rag.
--
-- The vector extension is intentionally NOT dropped: other blocks (hybrid-search,
-- semantic-cache, agent-memory) depend on it, and dropping a shared extension to uninstall one
-- block would break them.

DROP VIEW IF EXISTS blocks_rag.v_status;
DROP TRIGGER IF EXISTS documents_touch ON blocks_rag.documents;
DROP FUNCTION IF EXISTS blocks_rag.touch_updated_at();
DROP TABLE IF EXISTS blocks_rag.chunks;
DROP TABLE IF EXISTS blocks_rag.documents;
DROP SCHEMA IF EXISTS blocks_rag CASCADE;
