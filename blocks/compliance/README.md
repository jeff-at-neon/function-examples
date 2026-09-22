# Block 17 — Compliance Pack

Hash-chained audit log, soft delete with TTL purge, and GDPR export and hard-delete.

**Rank #17 of 25.** Metered.

> **Status: scaffold.** Schema, safety checks, and control flow are real and reviewable. The marked
> `TODO` seams are the remaining work, and unimplemented endpoints return `501` with a specific
> explanation rather than failing in a way that looks like a bug.

## Why this block

SOC 2 catnip, and the audit log is the part that is hard to retrofit. An audit trail added after the fact covers only what the application remembers to log; a trigger-based one captures writes from any client including psql, which is what auditors actually ask about. Row-event triggers would promote this from rank 17 to about 11 -- see docs/ROW_EVENTS.md.

## Install

```bash
neon-blocks migrate compliance
neon function deploy compliance --src blocks/compliance/src
neon triggers create --function-slug compliance --name compliance-purge \
  --schedule '23 4 * * *' --function-path '/purge'
```

> Child branches inherit triggers **disabled**. Enable them after promoting, or scheduled work
> silently never runs.

## Design notes

- **Audit entries are optionally hash-chained.** Each row includes a hash of the previous row, so deleting or editing history breaks the chain detectably. Without it an audit log is only as trustworthy as the person with table access — which is precisely who you are auditing.
- **Capture is via a Postgres trigger, not application code.** It records writes from any client, including a human at a psql prompt. Application-level logging misses exactly the events an auditor cares about.
- **Soft delete and hard delete are separate operations with separate authority.** Soft delete is reversible and routine; hard delete satisfies an erasure request and is not. Conflating them means an accidental click is unrecoverable.
- **GDPR export assembles from declared subject links**, so adding a table to the export is a config change rather than a code change. An export that silently misses a table is a compliance failure that looks like success.

## API

| Route | Purpose |
|---|---|
| `POST /subject-links` | Declare where a data subject's rows live. |
| `POST /requests` | Open an export or erasure request. |
| `GET /requests/:id` | Request status and per-table detail. |
| `POST /purge` | Cron. TTL purge of soft-deleted rows. |
| `GET /health` | `200` / `503`. |

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `COMPLIANCE_HASH_CHAIN` | `true` | Enable hash chaining on the audit log. Makes tampering detectable at the cost of serialising audit writes. |
| `COMPLIANCE_RETENTION_DAYS` | `30` | Days before soft-deleted rows are eligible for purge. Audit entries are never purged by this. |
| `COMPLIANCE_AUDIT_RETENTION_DAYS` | `2555` | Days audit entries are kept. Long by default: shortening it below your obligation is a compliance failure, not a storage optimisation. |
| `NEON_BLOCKS_TRIGGER_SECRET` | `` | Shared secret authenticating trigger delivery. Neon does not sign trigger POSTs. |

Injected automatically by Neon: `DATABASE_URL`.

## Limits and honest caveats

- **The chain verifier is a TODO seam.** The chain is written correctly by the trigger below; walking it to detect tampering is not implemented, and it should be a scheduled job rather than an endpoint.
- **Hash chaining serialises writes to the audit table.** Each entry needs the previous hash, so concurrent writes contend. Acceptable for audit volumes; not acceptable if you audit every read.
- **Export and erasure are per-subject and synchronous.** A subject with data across many large tables will need the queue, and the current shape does not chunk.
- **Retention purge is TTL-only.** Legal hold — suspending purge for data under litigation — is declared in the schema but not enforced, and enforcing it is the difference between a retention policy and a compliance control.
- **Unverified against a live Neon project.** Nothing in this repo has been run against real Neon
  infrastructure yet.

## Observability

```sql
SELECT * FROM blocks_compliance.v_status;
```

## Uninstall

```bash
neon-blocks rollback compliance
```

**This destroys the audit log. That is usually the single most compliance-significant table in the database, and its whole value is that it cannot be quietly removed. Export it, with the chain intact, before rolling back.**
