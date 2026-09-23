# Block 4 — File uploads

Presigned uploads to Object Storage with a queryable SQL index

**Rank #4 of 25 — the keystone of the storage family.** Blocks 5, 9, 11, 18, 19, and 23 all read
from this table.

## Why it exists

Neon Object Storage branches with your data without duplicating storage cost, which is genuinely
great. But it is a bucket: you cannot ask it

```sql
SELECT * FROM files WHERE tenant = $1 ORDER BY created_at DESC;   -- impossible against S3 alone
```

…nor join files to your domain tables, enforce a quota, or cascade a delete. This block is that
index. Everything else in the storage family becomes possible once it exists.

## Install

```bash
neon-blocks migrate file-registry
neon function deploy file-registry --src blocks/file-registry/src

neon triggers create --function-slug file-registry --name registry-finalize \
  --bucket uploads --prefix 'uploads/' --function-path '/finalize'
neon triggers create --function-slug file-registry --name registry-reconcile \
  --schedule '41 * * * *' --function-path '/reconcile'
```

## The upload flow

```
1. client → POST /uploads {tenant, filename}     → pending row + presigned PUT URL
2. client → PUT <url> (direct to storage)         → bytes never touch a function
3. storage trigger → POST /finalize               → HEAD, then pending → ready
4. cron → POST /reconcile                         → fixes whatever step 3 missed
```

**Step 2 is the point.** Proxying upload bytes through a function would bill Capacity-Hours to do
nothing but copy — a 100 MB upload streamed through a handler is pure waste. Direct-to-storage
keeps the function out of the data path entirely.

## Security properties

Key layout is `<prefix>/<tenant>/<id>/<filename>`, and the **key is the tenant boundary**. Four
things protect it:

1. **Tenant and id charsets exclude dots entirely**, so `..` is not expressible — not escaped,
   not sanitized, *inexpressible*.
2. **Filenames are sanitized, never trusted.** Only the final path segment survives
   (`../../etc/passwd` → `passwd`), leading dots are stripped, and the `id` segment above it
   already guarantees uniqueness — so the filename is cosmetic and a bad one can't collide.
3. **A forged trigger POST cannot create a row.** Delivery is unauthenticated, so `/finalize`
   requires (a) the key to parse under the configured prefix, (b) a pending row to already exist,
   and (c) a successful HEAD. Rows are never invented from trigger input.
4. **Deletes can't probe other tenants.** "Not your file" and "doesn't exist" return the same
   error, so the endpoint isn't an existence oracle.

**Upload TTL is capped at one hour** (default 15 min). A presigned PUT is a bearer write grant;
S3 permits seven days, which is almost never right.

**RLS is enabled with no policies**, which denies all access to non-owner roles. That's the safe
default — a registry readable by every role would leak file listings across tenants. Add policies
for your auth model:

```sql
CREATE POLICY tenant_isolation ON blocks_file_registry.objects
  FOR SELECT TO authenticated
  USING (tenant = current_setting('request.jwt.claims', true)::jsonb ->> 'org_id');
```

> **`POST /uploads` takes `tenant` from the request body and does not authenticate it.** It must
> sit behind your own auth or block 12 (`api-edge`). This is the most important caveat here.

## Size limits are enforced at finalize

A presigned PUT **cannot** enforce a maximum by itself. So `max_bytes` is recorded on the pending
row, and `/finalize` compares it against the HEAD-observed size, marking oversized objects
`rejected`. The declared-vs-observed columns are kept separately on purpose: their difference is
exactly how you detect a client that lied about size or content type.

## The reconciler is not optional

Storage triggers are Beta — no delivery guarantee, and **no delete or update events**. So the
hourly pass fixes three drifts:

| Drift | Cause | Fix |
|---|---|---|
| pending row, object exists | trigger missed | finalize now, and warn that delivery failed |
| ready row, object gone | **no delete events exist** | mark deleted by absence |
| pending row, no object | client abandoned | mark abandoned after the window |

Deletion detection is **skipped when the listing is truncated** — from a partial view every
unlisted object looks deleted, and live files would be wrongly marked gone. That's reported, not
silently narrowed.

## API

| Route | Purpose |
|---|---|
| `POST /uploads` | `{tenant, filename, contentType?, sizeBytes?, owner?, metadata?}` → presigned PUT. |
| `POST /finalize` | Storage trigger. |
| `POST /reconcile` | Cron. |
| `GET /files?tenant=X&limit=&offset=` | Ready files, newest first, each with a presigned GET. |
| `DELETE /files/:key?tenant=X` | Soft-delete the row, then remove the object. |
| `GET /health` | `200` / `503`. |

Delete order is registry-row-then-object deliberately: if the storage delete fails, the reconciler
sees a deleted row whose object still exists and retries. The reverse would leave a `ready` row
pointing at nothing, which reads as a working file until someone fetches it.

## Quotas

```sql
SELECT * FROM blocks_file_registry.v_tenant_usage;
```

Join against your own plan limits before calling `/uploads` to enforce a quota. The block
deliberately doesn't own plan definitions — that's block 8 (`billing`).

## Limits and honest caveats

- **No multipart upload.** Single PUT only, so practical ceiling is ~5 GB and there's no resume.
  Large-file support needs multipart, which is a real addition.
- **Tenant comes from the caller.** No authentication of its own; see above.
- **Content type is whatever the client declared** plus whatever storage reported. Neither is
  verified against the bytes — that's block 18 (`moderation`).
- **One registry per bucket.** A second bucket needs a second deployment; storage triggers watch
  exactly one bucket each.
- **Unverified against a live Neon project.** 22 unit tests cover key construction and the tenant
  boundary; the storage and SQL paths are written against documented behaviour but untested
  end-to-end.

## Uninstall

```bash
neon-blocks rollback file-registry
```

Drops the index, **not the files**. Deleting a user's objects as a side effect of uninstalling a
block would be indefensible.
