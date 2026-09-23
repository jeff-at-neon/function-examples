-- Reverse 002_chain_ops.
DROP FUNCTION IF EXISTS blocks_compliance.reanchor_audit_chain(timestamptz);
DROP FUNCTION IF EXISTS blocks_compliance.verify_audit_chain();
DROP FUNCTION IF EXISTS blocks_compliance.audit_entry_hash(text, text, text, text, text, jsonb, jsonb, text);
