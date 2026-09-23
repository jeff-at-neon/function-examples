# Block 15 — PII Anonymizer for Branches

Deterministically masks personal data in a branch — database and Object Storage — so a prod copy is safe to hand to a contractor or an AI agent.

**Block 15 of 25**, numbered in build order.

> **Status: implemented.** Schema, safety checks, control flow, and the core logic (deterministic
> masking with a resumable batched executor behind the branch-name interlock) are all wired, with
> pure unit tests. Object Storage masking remains out of scope. Still unverified against a live Neon project.

## Why this block

The flagship branching demo. Neon branches give you a full production copy in seconds, and Object Storage branches with it — which is exactly why handing one to a contractor or pointing an AI agent at it is a data-protection problem. This turns 'a copy of prod' into 'a safe copy of prod', which is what makes the branching feature usable for the thing people most want to do with it.

## Install

```bash
neon-blocks migrate pii-anonymizer
neon function deploy pii-anonymizer --src blocks/pii-anonymizer/src

```

## Design notes

- **Masking is deterministic, not random.** The same input always yields the same output, so joins still work and a bug that only reproduces for one customer still reproduces. Random masking destroys referential integrity and makes the copy useless for debugging.
- **HMAC with a per-branch salt, not a plain hash.** A plain hash of an email is trivially reversible with a dictionary — there are only so many email addresses. The salt must be per-branch so masked values can't be correlated between two branches.
- **Format preservation is explicit per rule.** A masked email must still look like an email or validation fails; a masked phone must still parse. This is why rules declare a strategy rather than applying one blanket transform.
- **Refuses to run against a branch it believes is production.** The whole operation is destructive by design, and the failure mode — masking your real customer data — is unrecoverable.

## API

| Route | Purpose |
|---|---|
| `POST /rules` | Declare a masking rule for a column. |
| `POST /run` | Mask this branch. Refuses unless the branch name matches the allow pattern. |
| `GET /runs` | Masking history for this branch. |
| `GET /health` | `200` / `503`. |

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `ANONYMIZE_SALT` | *required* | HMAC salt. Must be per-branch: a shared salt lets masked values be correlated across branches, and a leaked salt makes the mapping reversible. |
| `ANONYMIZE_ALLOW_BRANCH_PATTERN` | `^(dev|preview|staging|test)` | Regex a branch name must match before masking runs. The safety interlock: masking is destructive and irreversible on real data. |
| `ANONYMIZE_BATCH_ROWS` | `5000` | Rows updated per statement, so a large table does not hold one transaction open for its entire duration. |
| `NEON_BLOCKS_TRIGGER_SECRET` | `` | Shared secret authenticating trigger delivery. Neon does not sign trigger POSTs. |

Injected automatically by Neon: `DATABASE_URL`, `NEON_STORAGE_ENDPOINT`, `NEON_STORAGE_ACCESS_KEY_ID`, `NEON_STORAGE_SECRET_ACCESS_KEY`.

## Limits and honest caveats

- **The masking executor is a TODO seam.** Rules, strategies, and the safety interlock are specified; the `UPDATE` generation is not written. It must handle composite keys and very large tables in batches.
- **Object Storage masking is not implemented.** Object Storage branches with your data, so uploaded documents and images containing PII are copied too. Detecting and redacting those needs the vision and extraction blocks, and the README says so rather than implying coverage.
- **No automatic PII discovery.** Rules are declared per column. Column-name heuristics (`%email%`, `%phone%`) would find most of it and are a sensible addition, but a heuristic that misses one column gives false confidence — which is worse than no automation.
- **Determinism means the mapping is reversible if the salt leaks.** Treat the salt as a production secret, and rotate it per branch.
- **Unverified against a live Neon project.** Nothing in this repo has been run against real Neon
  infrastructure yet.

## Observability

```sql
SELECT * FROM blocks_pii_anonymizer.v_status;
```

## Uninstall

```bash
neon-blocks rollback pii-anonymizer
```
