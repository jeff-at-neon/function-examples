/**
 * Audit-chain linkage check. Pure and unit tested. It verifies only the linkage — that each entry's
 * prev_hash matches the previous entry's entry_hash — because recomputing the content hash faithfully
 * requires Postgres's jsonb->text canonicalization, which lives in SQL (migration 002's
 * verify_audit_chain / reanchor_audit_chain). This is the honest split: linkage here, content there.
 */

export interface AuditEntry {
  id: number;
  prev_hash: string | null;
  entry_hash: string | null;
}

/**
 * Walk entries in id order and report the first whose prev_hash does not match the running previous
 * entry_hash. A removed or reordered middle entry breaks the linkage and is caught here.
 */
export function verifyLinkage(entries: readonly AuditEntry[]): { ok: boolean; brokenAt: number | null } {
  let prev: string | null = null;
  for (const e of entries) {
    if ((e.prev_hash ?? "") !== (prev ?? "")) {
      return { ok: false, brokenAt: e.id };
    }
    prev = e.entry_hash;
  }
  return { ok: true, brokenAt: null };
}
