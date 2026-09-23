-- Block 17, migration 2: audit-chain verification and re-anchoring.
--
-- Purging expired audit entries with a plain DELETE breaks the hash chain and makes the log
-- unverifiable — which defeats the point of chaining it. These functions recompute the chain from
-- the new anchor after a purge. The hash input order is IDENTICAL to the capture trigger in 001, so
-- recomputation is faithful; reproducing Postgres's jsonb->text canonicalization in application code
-- is not, which is why this lives in SQL.

-- Shared hash. TG_OP was uppercase in the trigger and stored as lower(action), so upper(action)
-- reconstructs it. Everything else matches the trigger's concatenation exactly.
CREATE OR REPLACE FUNCTION blocks_compliance.audit_entry_hash(
  p_prev      text,
  p_action    text,
  p_schema    text,
  p_table     text,
  p_target_id text,
  p_old       jsonb,
  p_new       jsonb,
  p_actor     text
) RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT encode(
    sha256(
      convert_to(
        COALESCE(p_prev, '') || upper(p_action) || p_schema || p_table ||
        COALESCE(p_target_id, '') || COALESCE(p_old::text, '') || COALESCE(p_new::text, '') ||
        COALESCE(p_actor, ''),
        'UTF8'
      )
    ),
    'hex'
  );
$$;

-- Walk the chain in id order and return the first entry whose linkage or content hash does not
-- verify. No rows returned means the chain is intact.
CREATE OR REPLACE FUNCTION blocks_compliance.verify_audit_chain()
RETURNS TABLE(broken_at bigint, reason text)
LANGUAGE plpgsql
AS $$
DECLARE
  r          record;
  v_prev     text := NULL;
  v_expected text;
BEGIN
  FOR r IN SELECT * FROM blocks_compliance.audit_log ORDER BY id LOOP
    IF COALESCE(r.prev_hash, '') <> COALESCE(v_prev, '') THEN
      broken_at := r.id; reason := 'prev_hash does not match the previous entry'; RETURN NEXT;
      RETURN;
    END IF;
    v_expected := blocks_compliance.audit_entry_hash(
      r.prev_hash, r.action, r.target_schema, r.target_table, r.target_id, r.old_row, r.new_row, r.actor
    );
    IF r.entry_hash IS DISTINCT FROM v_expected THEN
      broken_at := r.id; reason := 'entry_hash does not match recomputed content (tampered)'; RETURN NEXT;
      RETURN;
    END IF;
    v_prev := r.entry_hash;
  END LOOP;
END;
$$;

-- Delete audit entries older than the cutoff, then recompute prev_hash/entry_hash for the survivors
-- from the new first row, so the chain verifies again from a clean anchor. Returns rows deleted.
CREATE OR REPLACE FUNCTION blocks_compliance.reanchor_audit_chain(p_cutoff timestamptz)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  r         record;
  v_prev    text := NULL;
  v_hash    text;
  v_deleted bigint;
BEGIN
  DELETE FROM blocks_compliance.audit_log WHERE occurred_at < p_cutoff;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  -- FOR UPDATE serialises against concurrent audit writes while re-anchoring.
  FOR r IN SELECT * FROM blocks_compliance.audit_log ORDER BY id FOR UPDATE LOOP
    v_hash := blocks_compliance.audit_entry_hash(
      v_prev, r.action, r.target_schema, r.target_table, r.target_id, r.old_row, r.new_row, r.actor
    );
    UPDATE blocks_compliance.audit_log SET prev_hash = v_prev, entry_hash = v_hash WHERE id = r.id;
    v_prev := v_hash;
  END LOOP;

  RETURN v_deleted;
END;
$$;
