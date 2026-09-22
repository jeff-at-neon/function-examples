import { INJECTED_DB, INJECTED_STORAGE, INJECTED_AI, TRIGGER_SECRET } from "./lib/generate.mjs";

/** @type {BlockSpec[]} */
export const SPECS = [
  {
    slug: "csv-import",
    rank: 11,
    name: "CSV / Excel Import",
    summary: "Spreadsheet lands in a bucket, validates into a staging table, merges typed, and writes a row-level error report back.",
    billing: "free",
    capabilities: ["postgres", "object_storage"],
    dependsOn: ["queue"],
    why:
      "Unglamorous and universally needed. \"Drop a CSV in a bucket and it lands in Postgres, with a " +
      "report of the 14 bad rows\" sells itself to every enterprise team, and the row-level error " +
      "report is the part people actually care about — an import that fails wholesale on row 4,000 is " +
      "worse than useless.",
    notes: [
      "**Staging first, always.** Rows land in a staging table, are validated there, then merge into the target. A direct COPY into the real table means a bad row on line 4,000 either aborts the whole import or leaves it half-applied.",
      "**Errors are data, not exceptions.** Every rejected row is recorded with its line number, the offending column, and the reason — then written back to storage as a CSV the user can fix and re-upload. That round trip is the feature.",
      "**Partial success is the default.** An import with 9,986 good rows and 14 bad ones applies the 9,986. Configurable via `CSV_ABORT_ON_ERROR` for callers who genuinely need all-or-nothing.",
      "**Type coercion is explicit and per-column**, declared in an import definition. Inferring types from the data means column 'zip' becomes an integer and 02134 becomes 2134.",
    ],
    limits: [
      "**Parsing is delegated to a TODO seam.** RFC 4180 CSV (quoted fields, embedded newlines, CRLF) needs a real parser; `parseCsv` is the marked insertion point. Naive `split(',')` corrupts any file containing a quoted comma, which is most real files.",
      "**Excel is not implemented.** `.xlsx` is a zip of XML and needs a library. The kind is detected and recorded as needing a parser rather than silently skipped.",
      "**No streaming.** Files are read whole, bounded by `CSV_MAX_BYTES`. Genuinely large imports need a streaming parser and chunked staging inserts.",
      "**The merge is generated from a column map**, so a definition referencing a dropped column fails at import time rather than at definition time.",
    ],
    env: [
      INJECTED_DB,
      ...INJECTED_STORAGE,
      { name: "CSV_BUCKET", description: "Bucket to watch for spreadsheets.", required: true, example: "imports" },
      { name: "CSV_PREFIX", description: "Watched key prefix.", required: false, default: "imports/" },
      { name: "CSV_REPORT_PREFIX", description: "Where error reports are written. Must be disjoint from CSV_PREFIX, or reports retrigger the importer.", required: false, default: "import-reports/" },
      { name: "CSV_MAX_BYTES", description: "Largest file to import. Read whole, so this bounds memory.", required: false, default: "52428800" },
      { name: "CSV_MAX_ROWS", description: "Row ceiling per import.", required: false, default: "100000" },
      { name: "CSV_ABORT_ON_ERROR", description: "Abort the whole import on the first bad row instead of applying the good ones.", required: false, default: "false" },
      TRIGGER_SECRET,
    ],
    triggers: [
      { type: "storage_object_created", bucketEnv: "CSV_BUCKET", prefixEnv: "CSV_PREFIX", functionPath: "/import", description: "Import an uploaded spreadsheet." },
      { type: "schedule", cron: "29 * * * *", functionPath: "/reconcile", description: "Required by §5. Finds uploads the trigger missed and resets imports stuck mid-run." },
    ],
    tables: `
-- An import definition: which target table, and how columns map and coerce. Declared rather than
-- inferred, because inferring types makes column 'zip' an integer and turns 02134 into 2134.
CREATE TABLE IF NOT EXISTS blocks_csv_import.definitions (
  code            text        PRIMARY KEY,
  target_schema   text        NOT NULL,
  target_table    text        NOT NULL,
  -- csv header -> {column, type, required, default}
  column_map      jsonb       NOT NULL,
  -- Target columns forming the natural key for upsert. Empty means insert-only.
  conflict_keys   text[]      NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS blocks_csv_import.imports (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_name     text        NOT NULL,
  object_key      text        NOT NULL,
  etag            text        NOT NULL,
  definition_code text        REFERENCES blocks_csv_import.definitions(code),

  status          text        NOT NULL DEFAULT 'pending',
  rows_total      integer     NOT NULL DEFAULT 0,
  rows_imported   integer     NOT NULL DEFAULT 0,
  rows_rejected   integer     NOT NULL DEFAULT 0,

  -- Key of the error report written back to storage. The round trip -- fix the report, re-upload --
  -- is the feature users actually want.
  report_key      text,
  error           text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,

  CONSTRAINT imports_status_valid
    CHECK (status IN ('pending', 'parsing', 'validating', 'merging', 'ready', 'failed', 'skipped')),
  CONSTRAINT imports_identity UNIQUE (bucket_name, object_key, etag)
);

CREATE INDEX IF NOT EXISTS imports_status_idx ON blocks_csv_import.imports (status, created_at);

-- One row per rejected input row. A line number and a reason, which is what makes an error report
-- actionable rather than just a failure count.
CREATE TABLE IF NOT EXISTS blocks_csv_import.row_errors (
  id          bigserial   PRIMARY KEY,
  import_id   uuid        NOT NULL REFERENCES blocks_csv_import.imports(id) ON DELETE CASCADE,
  line_number integer     NOT NULL,
  column_name text,
  reason      text        NOT NULL,
  raw_row     text,

  CONSTRAINT row_errors_line_sane CHECK (line_number >= 1)
);

CREATE INDEX IF NOT EXISTS row_errors_import_idx ON blocks_csv_import.row_errors (import_id, line_number);`,
    statusView: `
  count(*)                                              AS imports_total,
  count(*) FILTER (WHERE status = 'ready')               AS imports_ready,
  count(*) FILTER (WHERE status = 'failed')              AS imports_failed,
  count(*) FILTER (WHERE status = 'skipped')             AS imports_skipped,
  -- Stuck mid-pipeline: a function died between parsing and merging. The reconciler resets these.
  count(*) FILTER (WHERE status IN ('parsing', 'validating', 'merging')
                     AND updated_at < now() - interval '1 hour') AS imports_stuck,
  COALESCE(sum(rows_imported), 0)                        AS rows_imported_total,
  COALESCE(sum(rows_rejected), 0)                        AS rows_rejected_total,
  (SELECT count(*) FROM blocks_csv_import.definitions)   AS definitions_count`,
    dropOrder: ["TABLE blocks_csv_import.row_errors", "TABLE blocks_csv_import.imports", "TABLE blocks_csv_import.definitions"],
    routes: [
      { method: "POST", path: "/import", purpose: "Storage trigger. Import one spreadsheet." },
      { method: "POST", path: "/reconcile", purpose: "Cron. Missed uploads and stuck imports." },
      { method: "GET", path: "/imports/:id", purpose: "Import status plus its row errors." },
    ],
    imports: [
      'import { StorageClient, detectKind, ObjectNotFoundError } from "@neon-blocks/storage";',
    ],
    handlerBody: `
router.post("/import", async (request) => {
  assertTriggerAuthentic(request, { requireSecret: false });
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "storage_object_created") {
    return problem(400, "wrong_trigger", \`/import expects a storage trigger, got \${event.type}\`);
  }

  const cfg = config();
  if (event.bucketName !== cfg.get("CSV_BUCKET")) {
    return problem(403, "wrong_bucket", "This importer only handles its configured bucket");
  }

  // §8: reports are written back to storage, so the output prefix must be disjoint from the watched
  // prefix or every report would retrigger an import of itself.
  assertNoLoop({
    inputBucket: cfg.get("CSV_BUCKET"),
    inputPrefix: cfg.get("CSV_PREFIX"),
    outputBucket: cfg.get("CSV_BUCKET"),
    outputPrefix: cfg.get("CSV_REPORT_PREFIX"),
  });

  const storage = StorageClient.fromEnv();
  const kind = detectKind({ key: event.objectKey });

  if (kind !== "spreadsheet") {
    // No suffix filter on storage triggers, so non-spreadsheets arrive here routinely.
    return json({ ok: true, status: "skipped", reason: \`\${kind} is not a spreadsheet\` });
  }

  // HEAD-verify before acting: trigger delivery is unauthenticated (§7).
  let metadata;
  try {
    metadata = await storage.headVerified(event.bucketName, event.objectKey);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      return json({ ok: true, status: "skipped", reason: "object does not exist" });
    }
    throw err;
  }

  const maxBytes = cfg.int("CSV_MAX_BYTES", { min: 1024 });
  if (metadata.size > maxBytes) {
    log.capped("spreadsheet too large to import", { size: metadata.size, maxBytes });
    return json({ ok: true, status: "skipped", reason: "over size limit" });
  }

  // TODO(csv-import): the pipeline below is the remaining work.
  //   1. parseCsv(body) -- needs an RFC 4180 parser. Naive split(',') corrupts any file with a
  //      quoted comma, which is most real files. This is the main seam.
  //   2. validate each row against definitions.column_map, collecting row_errors rather than throwing
  //   3. COPY valid rows into a staging table
  //   4. MERGE staging into the target using conflict_keys
  //   5. write rejected rows as CSV to CSV_REPORT_PREFIX and record report_key
  // Status transitions are persisted at each step so the reconciler can recognise a stuck import.
  return problem(
    501,
    "not_implemented",
    "CSV parsing is not yet wired. See the TODO in src/index.ts: an RFC 4180 parser is required, " +
      "because naive comma splitting corrupts quoted fields.",
  );
});

router.post("/reconcile", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", \`/reconcile expects a schedule trigger, got \${event.type}\`);
  }

  // Reset imports abandoned mid-pipeline. This part works and is useful on its own: without it a
  // function that dies during a merge leaves an import in limbo forever.
  const { rowCount } = await getPool().query(
    \`UPDATE blocks_csv_import.imports
     SET status = 'pending',
         error = 'reset by reconciler: stuck in ' || status
     WHERE status IN ('parsing', 'validating', 'merging')
       AND updated_at < now() - interval '1 hour'\`,
  );

  return json({ ok: true, scheduledAt: event.scheduledAt, stuckReset: rowCount ?? 0 });
});

router.get("/imports/:id", async (_request, ctx) => {
  const pool = getPool();
  const { rows } = await pool.query(
    \`SELECT * FROM blocks_csv_import.imports WHERE id = $1\`,
    [ctx.params["id"]],
  );
  if (rows.length === 0) throw new NotFoundError("No such import");

  const { rows: errors } = await pool.query(
    \`SELECT line_number, column_name, reason, raw_row
     FROM blocks_csv_import.row_errors WHERE import_id = $1
     ORDER BY line_number LIMIT 1000\`,
    [ctx.params["id"]],
  );

  return json({ import: rows[0], rowErrors: errors, rowErrorsTruncated: errors.length === 1000 });
});`,
    healthEval: `
      const stuck = Number(status["imports_stuck"] ?? 0);
      const failed = Number(status["imports_failed"] ?? 0);
      const definitions = Number(status["definitions_count"] ?? 0);

      if (definitions === 0) {
        problems.push(
          "no import definitions are configured; every import will fail with no column map",
        );
      }
      if (stuck > 0) problems.push(\`\${stuck} import(s) stuck mid-pipeline for over an hour\`);
      if (failed > 0) problems.push(\`\${failed} import(s) failed\`);`,
  },

  {
    slug: "api-edge",
    rank: 12,
    name: "API Edge Pack",
    summary: "Hashed scoped API keys, per-tenant rate limits and quotas, and idempotency-key middleware.",
    billing: "free",
    capabilities: ["postgres", "neon_auth"],
    dependsOn: [],
    why:
      "Everyone rebuilds this, and everyone rebuilds it badly: keys stored in plaintext, rate limits " +
      "that reset on deploy because they live in memory, idempotency that isn't. Putting it in " +
      "Postgres makes the limits survive restarts and the keys survive a database dump landing in the " +
      "wrong place.",
    notes: [
      "**Keys are stored as SHA-256 hashes, never plaintext.** The full key is shown exactly once at creation. A database dump then leaks nothing usable — which is the entire reason to hash.",
      "**A short lookup prefix is stored alongside.** Verifying a key otherwise means hashing the candidate against every row; the prefix narrows it to one index lookup, and it's also what you display in a UI (`nb_live_a1b2…`).",
      "**Rate limiting is a fixed window in Postgres, not a token bucket in memory.** In-memory state is per-instance and resets on deploy, which means the limit isn't a limit. The tradeoff is burstiness at window boundaries, documented rather than hidden.",
      "**Idempotency stores the response, not just the key.** A retried request must get the *original* response back, not a 409. Storing only the key means the client can't recover the result of the call it already made.",
    ],
    limits: [
      "**Rate limiting is a fixed window, so it permits 2× burst at a boundary.** A sliding window needs per-request timestamps and more write volume. Documented because the alternative — pretending it's exact — leads to surprise.",
      "**Every check is a database round trip.** Correct and durable, but it adds latency to every request. A read replica or a short-lived in-process cache in front is the obvious optimisation.",
      "**Key verification is a TODO seam** for the constant-time comparison path; the hashing and prefix lookup are specified in the schema but the handler is not written.",
      "**No JWT or session handling.** Managed Better Auth owns `neon_auth`; this block is for machine-to-machine API keys, deliberately not a second auth system.",
    ],
    env: [
      INJECTED_DB,
      { name: "API_KEY_PREFIX", description: "Human-readable key prefix, e.g. nb_live. Makes leaked keys identifiable in logs and greppable in code.", required: false, default: "nb_live" },
      { name: "API_RATE_WINDOW_SECONDS", description: "Fixed window length. Shorter windows reduce burst but increase write volume.", required: false, default: "60" },
      { name: "API_DEFAULT_RATE_LIMIT", description: "Requests per window when a key has no explicit limit.", required: false, default: "1000" },
      { name: "API_IDEMPOTENCY_TTL_HOURS", description: "How long a stored idempotent response is replayed before the key is reusable.", required: false, default: "24" },
      TRIGGER_SECRET,
    ],
    triggers: [
      { type: "schedule", cron: "11 * * * *", functionPath: "/sweep", description: "Prune expired rate windows and idempotency records. Without it both tables grow without bound." },
    ],
    tables: `
CREATE TABLE IF NOT EXISTS blocks_api_edge.api_keys (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant        text        NOT NULL,
  name          text        NOT NULL,

  -- SHA-256 of the key. The plaintext is shown once at creation and never stored, so a database dump
  -- leaks nothing usable.
  key_hash      text        NOT NULL,
  -- First few characters, for lookup and for display. Without it, verifying a key means hashing the
  -- candidate against every row; with it, one index lookup.
  key_prefix    text        NOT NULL,

  -- Coarse capability strings, e.g. {read,write}. Checked by the caller, not enforced here.
  scopes        text[]      NOT NULL DEFAULT '{}',
  -- Per-key override of API_DEFAULT_RATE_LIMIT. NULL means use the default.
  rate_limit    integer,

  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT api_keys_hash_uniq UNIQUE (key_hash)
);

CREATE INDEX IF NOT EXISTS api_keys_prefix_idx ON blocks_api_edge.api_keys (key_prefix)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS api_keys_tenant_idx ON blocks_api_edge.api_keys (tenant);

-- Fixed-window counters. In Postgres rather than in memory, because in-memory state is per-instance
-- and resets on deploy -- which means the limit is not actually a limit.
CREATE TABLE IF NOT EXISTS blocks_api_edge.rate_windows (
  subject       text        NOT NULL,
  window_start  timestamptz NOT NULL,
  count         integer     NOT NULL DEFAULT 0,

  PRIMARY KEY (subject, window_start)
);

CREATE INDEX IF NOT EXISTS rate_windows_start_idx ON blocks_api_edge.rate_windows (window_start);

-- Idempotency records. Stores the RESPONSE, not just the key: a retried request must receive the
-- original response back, not a 409. Storing only the key leaves the client unable to recover the
-- result of a call it already made.
CREATE TABLE IF NOT EXISTS blocks_api_edge.idempotency (
  key           text        PRIMARY KEY,
  tenant        text        NOT NULL,
  -- Hash of the request body. A client reusing a key with a different payload is a bug, and
  -- returning the first response for a different request would be worse than erroring.
  request_hash  text        NOT NULL,
  response_status integer,
  response_body text,
  -- 'in_flight' until the handler completes, so concurrent duplicates can be told to wait rather
  -- than both executing.
  state         text        NOT NULL DEFAULT 'in_flight',
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,

  CONSTRAINT idempotency_state_valid CHECK (state IN ('in_flight', 'complete'))
);

CREATE INDEX IF NOT EXISTS idempotency_expiry_idx ON blocks_api_edge.idempotency (expires_at);`,
    statusView: `
  (SELECT count(*) FROM blocks_api_edge.api_keys WHERE revoked_at IS NULL)  AS keys_active,
  (SELECT count(*) FROM blocks_api_edge.api_keys WHERE revoked_at IS NOT NULL) AS keys_revoked,
  -- Expired but not revoked. These already fail, but they are worth cleaning up.
  (SELECT count(*) FROM blocks_api_edge.api_keys
     WHERE expires_at IS NOT NULL AND expires_at < now() AND revoked_at IS NULL) AS keys_expired,
  (SELECT count(*) FROM blocks_api_edge.api_keys
     WHERE last_used_at IS NULL AND created_at < now() - interval '30 days') AS keys_never_used,
  (SELECT count(*) FROM blocks_api_edge.rate_windows)                       AS rate_windows_live,
  -- Windows past their usefulness. A growing number means the sweeper is not running.
  (SELECT count(*) FROM blocks_api_edge.rate_windows
     WHERE window_start < now() - interval '1 hour')                        AS rate_windows_stale,
  (SELECT count(*) FROM blocks_api_edge.idempotency WHERE state = 'complete') AS idempotency_stored,
  -- In-flight for a long time means a handler crashed mid-request, and the key is now stuck.
  (SELECT count(*) FROM blocks_api_edge.idempotency
     WHERE state = 'in_flight' AND created_at < now() - interval '15 minutes') AS idempotency_stuck`,
    dropOrder: ["TABLE blocks_api_edge.idempotency", "TABLE blocks_api_edge.rate_windows", "TABLE blocks_api_edge.api_keys"],
    routes: [
      { method: "POST", path: "/keys", purpose: "Create a key. Returns the plaintext exactly once." },
      { method: "DELETE", path: "/keys/:id", purpose: "Revoke a key." },
      { method: "POST", path: "/verify", purpose: "Verify a key and consume rate budget." },
      { method: "POST", path: "/sweep", purpose: "Cron. Prune expired windows and idempotency records." },
    ],
    imports: ['import { createHash, randomBytes } from "node:crypto";'],
    handlerBody: `
router.post("/keys", async (request) => {
  const body = await readJsonObject(request);
  const tenant = requireString(body, "tenant");
  const name = requireString(body, "name");
  const cfg = config();

  // 32 bytes of CSPRNG output. base64url so the key is copy-pasteable without escaping.
  const secret = randomBytes(32).toString("base64url");
  const key = \`\${cfg.get("API_KEY_PREFIX")}_\${secret}\`;
  const keyHash = createHash("sha256").update(key).digest("hex");
  // Long enough to be selective, short enough to be safe to display and log.
  const keyPrefix = key.slice(0, cfg.get("API_KEY_PREFIX").length + 9);

  const scopes = Array.isArray(body["scopes"])
    ? (body["scopes"] as unknown[]).filter((s): s is string => typeof s === "string")
    : [];

  const { rows } = await getPool().query<{ id: string }>(
    \`INSERT INTO blocks_api_edge.api_keys (tenant, name, key_hash, key_prefix, scopes, rate_limit, expires_at)
     VALUES ($1, $2, $3, $4, $5::text[], $6, $7)
     RETURNING id\`,
    [
      tenant,
      name,
      keyHash,
      keyPrefix,
      scopes,
      typeof body["rateLimit"] === "number" ? body["rateLimit"] : null,
      typeof body["expiresAt"] === "string" ? body["expiresAt"] : null,
    ],
  );

  // The only time the plaintext exists. Not stored, not recoverable, not logged.
  return json({ id: rows[0]?.id, key, keyPrefix, scopes }, { status: 201 });
});

router.add("DELETE", "/keys/:id", async (_request, ctx) => {
  // Revoked, not deleted: the row is evidence of what that key did, and last_used_at is useful
  // after the fact.
  const { rowCount } = await getPool().query(
    \`UPDATE blocks_api_edge.api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL\`,
    [ctx.params["id"]],
  );
  if ((rowCount ?? 0) === 0) throw new NotFoundError("No such active key");
  return json({ revoked: ctx.params["id"] });
});

router.post("/verify", async (request) => {
  const body = await readJsonObject(request);
  const key = requireString(body, "key");
  const keyHash = createHash("sha256").update(key).digest("hex");

  // TODO(api-edge): verification and rate consumption.
  //   1. SELECT by key_hash (already unique-indexed), checking revoked_at and expires_at
  //   2. atomically increment the current fixed window:
  //        INSERT INTO rate_windows (subject, window_start, count) VALUES (...)
  //        ON CONFLICT (subject, window_start) DO UPDATE SET count = rate_windows.count + 1
  //        RETURNING count
  //      One statement, so concurrent requests cannot both read an under-limit count.
  //   3. compare against rate_limit or API_DEFAULT_RATE_LIMIT and return 429 with Retry-After
  //   4. update last_used_at (consider throttling this write -- it is one per request otherwise)
  void keyHash;
  return problem(
    501,
    "not_implemented",
    "Key verification is not yet wired. See the TODO in src/index.ts. The schema and the atomic " +
      "window-increment statement are specified there.",
  );
});

router.post("/sweep", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", \`/sweep expects a schedule trigger, got \${event.type}\`);
  }

  const pool = getPool();
  const cfg = config();

  // Both tables grow without bound otherwise. This part is complete and worth running on its own.
  const { rowCount: windows } = await pool.query(
    \`DELETE FROM blocks_api_edge.rate_windows WHERE window_start < now() - interval '1 hour'\`,
  );
  const { rowCount: idempotency } = await pool.query(
    \`DELETE FROM blocks_api_edge.idempotency WHERE expires_at < now()\`,
  );
  // A handler that crashed mid-request leaves a key stuck in_flight, blocking legitimate retries.
  const { rowCount: stuck } = await pool.query(
    \`DELETE FROM blocks_api_edge.idempotency
     WHERE state = 'in_flight' AND created_at < now() - interval '15 minutes'\`,
  );

  void cfg;
  return json({
    ok: true,
    scheduledAt: event.scheduledAt,
    rateWindowsPruned: windows ?? 0,
    idempotencyPruned: idempotency ?? 0,
    stuckInFlightCleared: stuck ?? 0,
  });
});`,
    healthEval: `
      const stale = Number(status["rate_windows_stale"] ?? 0);
      const stuck = Number(status["idempotency_stuck"] ?? 0);
      const expired = Number(status["keys_expired"] ?? 0);

      if (stale > 0) {
        problems.push(
          \`\${stale} stale rate window(s); the /sweep trigger may be disabled on this branch\`,
        );
      }
      if (stuck > 0) {
        problems.push(
          \`\${stuck} idempotency record(s) stuck in_flight -- handlers crashed mid-request, and \` +
            \`those keys are blocking legitimate retries\`,
        );
      }
      if (expired > 0) problems.push(\`\${expired} key(s) are past expiry but not revoked\`);`,
  },

  {
    slug: "notifications",
    rank: 13,
    name: "Notification Engine",
    summary: "Transactional email, SMS, and push behind provider adapters, with templates, per-user preferences, quiet hours, and digests.",
    billing: "free",
    capabilities: ["postgres", "neon_auth"],
    dependsOn: ["queue"],
    why:
      "Every app sends notifications and every app rebuilds preferences, quiet hours, and dedupe. The " +
      "part that actually matters is restraint: the difference between a product people keep " +
      "notifications on for and one they mute is entirely in the suppression logic, not the sending.",
    notes: [
      "**Preferences are per (user, channel, category).** A single on/off switch means users mute everything to stop one noisy category. Granularity is what keeps notifications enabled.",
      "**Quiet hours defer, never drop.** A notification suppressed at 2am is sent at 8am. Dropping it silently is how users miss things that mattered, and it's indistinguishable from a bug.",
      "**Dedupe on a caller-supplied key within a window.** Three password-reset requests in a minute should produce one email, and the queue's at-least-once delivery makes this mandatory rather than nice.",
      "**Digest rollups collapse N notifications into one.** Ten comments on a thread is one email, not ten — and the digest window is per category, since a security alert should never be digested.",
      "**Providers sit behind one interface** (`providers/`). Resend *or* SES, Twilio *or* SNS. A block that only works with one vendor's key is not reusable.",
    ],
    limits: [
      "**Provider adapters are TODO seams.** The interface and the dispatch logic are specified; the HTTP calls to Resend/SES/Twilio are not written. This is deliberate — the value is in preferences and suppression, not in wrapping a send API.",
      "**Template rendering is not implemented.** The schema holds templates and a variables jsonb; interpolation needs a real engine with escaping. Naive `replace()` on user data is an injection vector in HTML email.",
      "**Timezone handling for quiet hours requires a per-user timezone**, stored but unused until rendering lands. Cron is UTC-only, so a user's 8am is computed at send time, not scheduled.",
      "**No unsubscribe link generation or bounce handling.** Both are legally significant for bulk email and deliberately out of scope for a transactional block.",
    ],
    env: [
      INJECTED_DB,
      { name: "NOTIFY_EMAIL_PROVIDER", description: "Adapter to use: resend, ses, or none.", required: false, default: "none" },
      { name: "NOTIFY_EMAIL_FROM", description: "Default From address.", required: false, default: "" },
      { name: "NOTIFY_SMS_PROVIDER", description: "Adapter to use: twilio, sns, or none.", required: false, default: "none" },
      { name: "NOTIFY_DEDUPE_WINDOW_MINUTES", description: "Window in which an identical dedupe key is suppressed.", required: false, default: "60" },
      { name: "NOTIFY_QUIET_HOURS_DEFAULT", description: "Default quiet window as HH:MM-HH:MM in the user's timezone. Empty disables.", required: false, default: "22:00-08:00" },
      { name: "NOTIFY_BATCH_SIZE", description: "Notifications sent per invocation.", required: false, default: "50" },
      TRIGGER_SECRET,
    ],
    triggers: [
      { type: "schedule", cron: "* * * * *", functionPath: "/send", description: "Send due notifications, including those deferred past quiet hours." },
      { type: "schedule", cron: "19 8 * * *", functionPath: "/digest", description: "Build and send digest rollups." },
    ],
    tables: `
CREATE TABLE IF NOT EXISTS blocks_notifications.templates (
  code        text        PRIMARY KEY,
  channel     text        NOT NULL,
  category    text        NOT NULL,
  subject     text,
  body        text        NOT NULL,
  -- Variable names the template expects, so a missing one fails at send time with a clear message
  -- rather than rendering "Hello undefined".
  variables   text[]      NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT templates_channel_valid CHECK (channel IN ('email', 'sms', 'push', 'inapp'))
);

-- Per (user, channel, category). A single on/off switch means users mute everything to stop one
-- noisy category, so granularity is what keeps notifications enabled at all.
CREATE TABLE IF NOT EXISTS blocks_notifications.preferences (
  user_ref    text        NOT NULL,
  channel     text        NOT NULL,
  category    text        NOT NULL,
  enabled     boolean     NOT NULL DEFAULT true,
  -- 'immediate' or 'digest'. Per category, because a security alert must never be digested.
  cadence     text        NOT NULL DEFAULT 'immediate',
  timezone    text        NOT NULL DEFAULT 'UTC',
  -- Overrides NOTIFY_QUIET_HOURS_DEFAULT. Empty string means no quiet hours for this pairing.
  quiet_hours text,

  PRIMARY KEY (user_ref, channel, category),
  CONSTRAINT preferences_cadence_valid CHECK (cadence IN ('immediate', 'digest'))
);

CREATE TABLE IF NOT EXISTS blocks_notifications.notifications (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_ref      text        NOT NULL,
  channel       text        NOT NULL,
  category      text        NOT NULL,
  template_code text        REFERENCES blocks_notifications.templates(code),

  -- Where it goes: email address, phone number, device token. Resolved at enqueue time so a later
  -- profile change does not redirect a pending notification.
  destination   text        NOT NULL,
  variables     jsonb       NOT NULL DEFAULT '{}'::jsonb,

  status        text        NOT NULL DEFAULT 'pending',
  -- Set when quiet hours defer a notification. It is sent later, never dropped: silently dropping
  -- is how users miss things, and it is indistinguishable from a bug.
  deferred_until timestamptz,
  -- Caller-supplied. Three password resets in a minute should produce one email, and the queue's
  -- at-least-once delivery makes this mandatory rather than optional.
  dedupe_key    text,

  attempts      integer     NOT NULL DEFAULT 0,
  provider      text,
  provider_message_id text,
  error         text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,

  CONSTRAINT notifications_status_valid
    CHECK (status IN ('pending', 'deferred', 'sent', 'failed', 'suppressed', 'digested'))
);

CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_uniq
  ON blocks_notifications.notifications (user_ref, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'deferred', 'sent');

CREATE INDEX IF NOT EXISTS notifications_due_idx
  ON blocks_notifications.notifications (created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS notifications_deferred_idx
  ON blocks_notifications.notifications (deferred_until)
  WHERE status = 'deferred';
CREATE INDEX IF NOT EXISTS notifications_user_idx
  ON blocks_notifications.notifications (user_ref, created_at DESC);`,
    statusView: `
  count(*)                                                AS notifications_total,
  count(*) FILTER (WHERE status = 'pending')               AS notifications_pending,
  count(*) FILTER (WHERE status = 'deferred')              AS notifications_deferred,
  count(*) FILTER (WHERE status = 'sent')                  AS notifications_sent,
  count(*) FILTER (WHERE status = 'failed')                AS notifications_failed,
  count(*) FILTER (WHERE status = 'suppressed')            AS notifications_suppressed,
  -- Deferred past their own release time: the /send cron is not running.
  count(*) FILTER (WHERE status = 'deferred' AND deferred_until < now()) AS notifications_overdue,
  -- Age of the oldest unsent notification. The number to alert on.
  COALESCE(EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE status = 'pending')))::bigint, 0)
                                                          AS oldest_pending_seconds,
  (SELECT count(*) FROM blocks_notifications.templates)    AS templates_count
FROM blocks_notifications.notifications`,
    dropOrder: ["TABLE blocks_notifications.notifications", "TABLE blocks_notifications.preferences", "TABLE blocks_notifications.templates"],
    routes: [
      { method: "POST", path: "/notify", purpose: "Enqueue a notification, applying preferences and quiet hours." },
      { method: "POST", path: "/send", purpose: "Cron. Send due and released notifications." },
      { method: "POST", path: "/digest", purpose: "Cron. Roll up digested notifications." },
      { method: "GET", path: "/preferences", purpose: "A user's preferences." },
    ],
    imports: [],
    handlerBody: `
router.post("/notify", async (request) => {
  const body = await readJsonObject(request);
  const userRef = requireString(body, "userRef");
  const channel = requireString(body, "channel");
  const category = requireString(body, "category");
  const destination = requireString(body, "destination");

  const pool = getPool();

  // Preferences first. A disabled pairing is recorded as suppressed rather than dropped, so "why
  // didn't I get that email?" has an answer.
  const { rows: prefs } = await pool.query<{ enabled: boolean; cadence: string; quiet_hours: string | null; timezone: string }>(
    \`SELECT enabled, cadence, quiet_hours, timezone
     FROM blocks_notifications.preferences
     WHERE user_ref = $1 AND channel = $2 AND category = $3\`,
    [userRef, channel, category],
  );
  const pref = prefs[0];

  if (pref && !pref.enabled) {
    await pool.query(
      \`INSERT INTO blocks_notifications.notifications
         (user_ref, channel, category, destination, variables, status, dedupe_key)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'suppressed', $6)
       ON CONFLICT DO NOTHING\`,
      [userRef, channel, category, destination, JSON.stringify(body["variables"] ?? {}),
       typeof body["dedupeKey"] === "string" ? body["dedupeKey"] : null],
    );
    return json({ status: "suppressed", reason: "user disabled this channel and category" });
  }

  // TODO(notifications): quiet-hours evaluation and digest routing.
  //   * parse quiet_hours (HH:MM-HH:MM) in the user's timezone, handling windows that cross midnight
  //   * if inside, set status='deferred' and deferred_until to the window's end -- deferred, never
  //     dropped
  //   * if pref.cadence = 'digest', set status='digested' for /digest to collect
  // Cron is UTC-only, so the user's local release time must be computed at send time.
  const { rows } = await pool.query<{ id: string }>(
    \`INSERT INTO blocks_notifications.notifications
       (user_ref, channel, category, template_code, destination, variables, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT DO NOTHING
     RETURNING id\`,
    [
      userRef, channel, category,
      typeof body["templateCode"] === "string" ? body["templateCode"] : null,
      destination,
      JSON.stringify(body["variables"] ?? {}),
      typeof body["dedupeKey"] === "string" ? body["dedupeKey"] : null,
    ],
  );

  const id = rows[0]?.id;
  // No row means the dedupe key matched a live notification -- deliberate, not an error.
  return json({ status: id ? "queued" : "deduplicated", id: id ?? null }, { status: id ? 202 : 200 });
});

router.post("/send", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", \`/send expects a schedule trigger, got \${event.type}\`);
  }

  const pool = getPool();
  const cfg = config();

  // Release deferred notifications whose quiet window has passed. Complete and useful on its own.
  const { rowCount: released } = await pool.query(
    \`UPDATE blocks_notifications.notifications
     SET status = 'pending', deferred_until = NULL
     WHERE status = 'deferred' AND deferred_until <= now()\`,
  );

  const { rows: due } = await pool.query(
    \`SELECT id, channel, destination, template_code, variables
     FROM blocks_notifications.notifications
     WHERE status = 'pending'
     ORDER BY created_at
     FOR UPDATE SKIP LOCKED
     LIMIT $1\`,
    [cfg.int("NOTIFY_BATCH_SIZE", { min: 1, max: 500 })],
  );

  // TODO(notifications): render and dispatch.
  //   * render the template with escaping appropriate to the channel. Naive replace() on user data
  //     is an HTML injection vector in email, which is why this is not a one-liner.
  //   * dispatch through providers/<name>.ts behind one interface (Resend or SES, Twilio or SNS)
  //   * record provider_message_id, or increment attempts and set error
  if (due.length > 0 && cfg.get("NOTIFY_EMAIL_PROVIDER") === "none") {
    log.warn("notifications are due but no provider is configured", { due: due.length });
  }

  return json({
    ok: true,
    scheduledAt: event.scheduledAt,
    released: released ?? 0,
    due: due.length,
    sent: 0,
    note: due.length > 0
      ? "Provider adapters are not yet wired; see the TODO in src/index.ts."
      : undefined,
  });
});

router.post("/digest", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", \`/digest expects a schedule trigger, got \${event.type}\`);
  }

  // TODO(notifications): collapse 'digested' notifications per (user, category) into one send.
  // Ten comments on a thread should be one email, not ten.
  const { rows } = await getPool().query<{ user_ref: string; category: string; n: string }>(
    \`SELECT user_ref, category, count(*)::text AS n
     FROM blocks_notifications.notifications
     WHERE status = 'digested'
     GROUP BY user_ref, category\`,
  );

  return json({ ok: true, scheduledAt: event.scheduledAt, pendingDigests: rows.length, groups: rows });
});

router.get("/preferences", async (_request, ctx) => {
  const userRef = ctx.url.searchParams.get("user");
  if (!userRef) throw new ValidationError("?user= is required");

  const { rows } = await getPool().query(
    \`SELECT channel, category, enabled, cadence, timezone, quiet_hours
     FROM blocks_notifications.preferences WHERE user_ref = $1
     ORDER BY channel, category\`,
    [userRef],
  );
  return json({ userRef, preferences: rows });
});`,
    healthEval: `
      const overdue = Number(status["notifications_overdue"] ?? 0);
      const failed = Number(status["notifications_failed"] ?? 0);
      const oldestPending = Number(status["oldest_pending_seconds"] ?? 0);
      const templates = Number(status["templates_count"] ?? 0);

      if (templates === 0) problems.push("no templates are defined");
      if (overdue > 0) {
        problems.push(
          \`\${overdue} deferred notification(s) are past their release time; the /send trigger may \` +
            \`be disabled on this branch\`,
        );
      }
      if (oldestPending > 600) {
        problems.push(\`oldest pending notification is \${oldestPending}s old\`);
      }
      if (failed > 0) problems.push(\`\${failed} notification(s) failed to send\`);`,
  },

  {
    slug: "embedding-freshness",
    rank: 14,
    name: "Embedding Freshness Worker",
    summary: "Re-embeds rows whose source text changed, driven by a watermark or the outbox. Fixes pgvector's most common failure mode.",
    billing: "free",
    capabilities: ["postgres", "pgvector", "ai_gateway"],
    dependsOn: ["queue", "rag"],
    why:
      "Stale vectors are pgvector's number one failure mode: text is edited, the embedding is not " +
      "regenerated, and search silently returns the old meaning. Nothing errors, so nobody notices " +
      "until a user reports that search is 'wrong'. This is also the block that row-event triggers " +
      "would most improve — see docs/ROW_EVENTS.md, where it moves from rank 14 to about 6.",
    notes: [
      "**Two drive modes, one interface.** Watermark polling (compare `updated_at` against a stored high-water mark) works on any table today. Outbox-driven re-embedding is more precise and arrives when the producer attaches `blocks_core.attach_outbox_trigger`. Neither requires the consumer to change.",
      "**Content hashing prevents pointless spend.** An `updated_at` bump from an unrelated column change must not trigger a re-embed. Comparing a hash of the *embedded text* is what makes the difference between a cheap no-op and paying to re-embed a corpus.",
      "**The outbox trigger carries both `old` and `new`**, specifically so a consumer can diff and skip no-op writes. That's why block 1's trigger function includes the old row.",
      "**Re-embedding is queued, never inline.** A bulk update touching 50,000 rows must not attempt 50,000 model calls in one invocation.",
    ],
    limits: [
      "**The re-embed worker is a TODO seam.** Change detection and the watermark are specified in the schema; the embed-and-update step is not written. It is a small amount of code that mirrors block 2's ingestion path.",
      "**Watermark polling has a floor of one minute** (cron), and it cannot detect deletes. Outbox mode handles deletes; watermark mode needs a periodic full reconciliation.",
      "**Registering a source table requires the table to have an `updated_at`-equivalent column.** Tables without one can only use outbox mode.",
      "**No backfill throttling beyond batch size.** Registering a large existing table queues the whole thing; a token budget would be a sensible addition.",
    ],
    env: [
      INJECTED_DB,
      INJECTED_AI,
      { name: "FRESHNESS_BATCH_SIZE", description: "Rows examined per invocation. Each stale row becomes one queued re-embed job.", required: false, default: "200" },
      { name: "FRESHNESS_EMBEDDING_MODEL", description: "Must match the model used originally, or re-embedded vectors are not comparable with the rest of the index.", required: false, default: "text-embedding-3-small" },
      { name: "FRESHNESS_EMBEDDING_DIMENSIONS", description: "Must match the model and the vector column width.", required: false, default: "1536" },
      TRIGGER_SECRET,
    ],
    triggers: [
      { type: "schedule", cron: "*/5 * * * *", functionPath: "/scan", description: "Detect rows whose embedded text changed and queue re-embeds. Five minutes is a deliberate compromise: row-event triggers would make this near-instant." },
    ],
    tables: `
-- A registered source of embeddable text. Generic so the block works against user tables, not just
-- the rag block's corpus.
CREATE TABLE IF NOT EXISTS blocks_embedding_freshness.sources (
  code            text        PRIMARY KEY,
  source_schema   text        NOT NULL,
  source_table    text        NOT NULL,
  -- Primary key column, for identifying rows.
  key_column      text        NOT NULL DEFAULT 'id',
  -- Columns concatenated to form the embedded text.
  text_columns    text[]      NOT NULL,
  -- Column compared against the watermark. NULL means this source is outbox-driven only.
  updated_column  text,
  -- Where the vector lives. Usually the same table.
  vector_schema   text        NOT NULL,
  vector_table    text        NOT NULL,
  vector_column   text        NOT NULL DEFAULT 'embedding',

  -- High-water mark. Rows with updated_column beyond this are candidates.
  watermark       timestamptz NOT NULL DEFAULT '-infinity',
  is_active       boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sources_text_columns_present CHECK (cardinality(text_columns) >= 1)
);

-- Hash of the text that was actually embedded, per row. This is what stops an updated_at bump from
-- an unrelated column change from triggering a paid re-embed.
CREATE TABLE IF NOT EXISTS blocks_embedding_freshness.embedded_state (
  source_code   text        NOT NULL REFERENCES blocks_embedding_freshness.sources(code) ON DELETE CASCADE,
  row_key       text        NOT NULL,
  content_hash  text        NOT NULL,
  model         text        NOT NULL,
  embedded_at   timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (source_code, row_key)
);

CREATE INDEX IF NOT EXISTS embedded_state_model_idx
  ON blocks_embedding_freshness.embedded_state (source_code, model);

-- Rows known to need re-embedding. Queued rather than embedded inline, because a bulk update
-- touching 50,000 rows must not attempt 50,000 model calls in one invocation.
CREATE TABLE IF NOT EXISTS blocks_embedding_freshness.pending (
  source_code   text        NOT NULL REFERENCES blocks_embedding_freshness.sources(code) ON DELETE CASCADE,
  row_key       text        NOT NULL,
  reason        text        NOT NULL,
  detected_at   timestamptz NOT NULL DEFAULT now(),
  attempts      integer     NOT NULL DEFAULT 0,
  last_error    text,

  PRIMARY KEY (source_code, row_key)
);

CREATE INDEX IF NOT EXISTS pending_detected_idx ON blocks_embedding_freshness.pending (detected_at);`,
    statusView: `
  (SELECT count(*) FROM blocks_embedding_freshness.sources WHERE is_active) AS sources_active,
  (SELECT count(*) FROM blocks_embedding_freshness.embedded_state)          AS rows_embedded,
  (SELECT count(*) FROM blocks_embedding_freshness.pending)                 AS rows_pending,
  -- Pending for over an hour means the worker is not keeping up, and those vectors are stale right
  -- now -- search is silently returning old meanings.
  (SELECT count(*) FROM blocks_embedding_freshness.pending
     WHERE detected_at < now() - interval '1 hour')                         AS rows_stale_over_hour,
  (SELECT count(*) FROM blocks_embedding_freshness.pending WHERE attempts >= 3) AS rows_failing,
  -- More than one model in use means vectors in the index are not mutually comparable.
  (SELECT count(DISTINCT model) FROM blocks_embedding_freshness.embedded_state) AS models_in_use,
  (SELECT COALESCE(EXTRACT(EPOCH FROM (now() - min(watermark)))::bigint, 0)
     FROM blocks_embedding_freshness.sources WHERE is_active
       AND watermark > '-infinity')                                         AS oldest_watermark_seconds`,
    dropOrder: ["TABLE blocks_embedding_freshness.pending", "TABLE blocks_embedding_freshness.embedded_state", "TABLE blocks_embedding_freshness.sources"],
    routes: [
      { method: "POST", path: "/sources", purpose: "Register a table whose text should stay embedded." },
      { method: "POST", path: "/scan", purpose: "Cron. Detect changed rows and queue re-embeds." },
      { method: "GET", path: "/pending", purpose: "Rows currently known to be stale." },
    ],
    imports: ['import { quoteIdent } from "@neon-blocks/core";'],
    handlerBody: `
router.post("/sources", async (request) => {
  const body = await readJsonObject(request);

  const textColumns = Array.isArray(body["textColumns"])
    ? (body["textColumns"] as unknown[]).filter((c): c is string => typeof c === "string")
    : [];
  if (textColumns.length === 0) {
    throw new ValidationError('"textColumns" must be a non-empty array of column names');
  }

  // Identifiers come from the caller and end up in generated SQL, so validate every one now rather
  // than interpolating them later.
  for (const identifier of [
    requireString(body, "sourceSchema"),
    requireString(body, "sourceTable"),
    ...textColumns,
  ]) {
    quoteIdent(identifier);
  }

  await getPool().query(
    \`INSERT INTO blocks_embedding_freshness.sources
       (code, source_schema, source_table, key_column, text_columns, updated_column,
        vector_schema, vector_table, vector_column)
     VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9)
     ON CONFLICT (code) DO UPDATE
       SET text_columns = EXCLUDED.text_columns, updated_column = EXCLUDED.updated_column\`,
    [
      requireString(body, "code"),
      requireString(body, "sourceSchema"),
      requireString(body, "sourceTable"),
      typeof body["keyColumn"] === "string" ? body["keyColumn"] : "id",
      textColumns,
      typeof body["updatedColumn"] === "string" ? body["updatedColumn"] : null,
      typeof body["vectorSchema"] === "string" ? body["vectorSchema"] : requireString(body, "sourceSchema"),
      typeof body["vectorTable"] === "string" ? body["vectorTable"] : requireString(body, "sourceTable"),
      typeof body["vectorColumn"] === "string" ? body["vectorColumn"] : "embedding",
    ],
  );

  return json({ registered: body["code"] }, { status: 201 });
});

router.post("/scan", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", \`/scan expects a schedule trigger, got \${event.type}\`);
  }

  const { rows: sources } = await getPool().query<{ code: string; updated_column: string | null }>(
    \`SELECT code, updated_column FROM blocks_embedding_freshness.sources WHERE is_active\`,
  );

  // TODO(embedding-freshness): the scan and re-embed pipeline.
  //   1. per source, SELECT rows where updated_column > watermark, limited to FRESHNESS_BATCH_SIZE
  //   2. concatenate text_columns and hash it; compare against embedded_state.content_hash. This
  //      step is what stops an unrelated column change from paying for a re-embed.
  //   3. INSERT differing rows into pending
  //   4. advance the watermark to the highest updated_column actually examined -- not to now(), or
  //      rows modified during the scan would be skipped forever
  //   5. embed pending rows in batches, UPDATE the vector column, upsert embedded_state
  // Outbox mode replaces steps 1-2: consume 'row.changed' events and diff old vs new, which is why
  // block 1's trigger carries both.
  void sources;

  return problem(
    501,
    "not_implemented",
    "The freshness scan is not yet wired. See the TODO in src/index.ts -- note step 4: the " +
      "watermark must advance to the highest row examined, not to now(), or rows modified during " +
      "the scan are skipped forever.",
  );
});

router.get("/pending", async (_request, ctx) => {
  const limit = Math.min(Number(ctx.url.searchParams.get("limit") ?? "100"), 1000);
  const { rows } = await getPool().query(
    \`SELECT source_code, row_key, reason, detected_at, attempts, last_error
     FROM blocks_embedding_freshness.pending
     ORDER BY detected_at
     LIMIT $1\`,
    [limit],
  );
  return json({ count: rows.length, pending: rows });
});`,
    healthEval: `
      const stale = Number(status["rows_stale_over_hour"] ?? 0);
      const failing = Number(status["rows_failing"] ?? 0);
      const models = Number(status["models_in_use"] ?? 0);
      const sources = Number(status["sources_active"] ?? 0);

      if (sources === 0) problems.push("no active sources registered; nothing is being kept fresh");
      if (stale > 0) {
        // These vectors are wrong right now, and search is silently returning old meanings.
        problems.push(
          \`\${stale} row(s) have been pending re-embedding for over an hour; their vectors are \` +
            \`stale and search is returning outdated meanings with no error\`,
        );
      }
      if (failing > 0) problems.push(\`\${failing} row(s) have failed re-embedding three or more times\`);
      if (models > 1) {
        problems.push(
          \`\${models} embedding models are in use; vectors are not mutually comparable and \` +
            \`retrieval quality is silently degraded\`,
        );
      }`,
  },

  {
    slug: "pii-anonymizer",
    rank: 15,
    name: "PII Anonymizer for Branches",
    summary: "Deterministically masks personal data in a branch — database and Object Storage — so a prod copy is safe to hand to a contractor or an AI agent.",
    billing: "meter",
    capabilities: ["postgres", "object_storage", "branching"],
    dependsOn: [],
    why:
      "The flagship branching demo. Neon branches give you a full production copy in seconds, and " +
      "Object Storage branches with it — which is exactly why handing one to a contractor or pointing " +
      "an AI agent at it is a data-protection problem. This turns 'a copy of prod' into 'a safe copy " +
      "of prod', which is what makes the branching feature usable for the thing people most want to " +
      "do with it.",
    notes: [
      "**Masking is deterministic, not random.** The same input always yields the same output, so joins still work and a bug that only reproduces for one customer still reproduces. Random masking destroys referential integrity and makes the copy useless for debugging.",
      "**HMAC with a per-branch salt, not a plain hash.** A plain hash of an email is trivially reversible with a dictionary — there are only so many email addresses. The salt must be per-branch so masked values can't be correlated between two branches.",
      "**Format preservation is explicit per rule.** A masked email must still look like an email or validation fails; a masked phone must still parse. This is why rules declare a strategy rather than applying one blanket transform.",
      "**Refuses to run against a branch it believes is production.** The whole operation is destructive by design, and the failure mode — masking your real customer data — is unrecoverable.",
    ],
    limits: [
      "**The masking executor is a TODO seam.** Rules, strategies, and the safety interlock are specified; the `UPDATE` generation is not written. It must handle composite keys and very large tables in batches.",
      "**Object Storage masking is not implemented.** Object Storage branches with your data, so uploaded documents and images containing PII are copied too. Detecting and redacting those needs the vision and extraction blocks, and the README says so rather than implying coverage.",
      "**No automatic PII discovery.** Rules are declared per column. Column-name heuristics (`%email%`, `%phone%`) would find most of it and are a sensible addition, but a heuristic that misses one column gives false confidence — which is worse than no automation.",
      "**Determinism means the mapping is reversible if the salt leaks.** Treat the salt as a production secret, and rotate it per branch.",
    ],
    env: [
      INJECTED_DB,
      ...INJECTED_STORAGE,
      { name: "ANONYMIZE_SALT", description: "HMAC salt. Must be per-branch: a shared salt lets masked values be correlated across branches, and a leaked salt makes the mapping reversible.", required: true, example: "a-long-random-per-branch-secret" },
      { name: "ANONYMIZE_ALLOW_BRANCH_PATTERN", description: "Regex a branch name must match before masking runs. The safety interlock: masking is destructive and irreversible on real data.", required: false, default: "^(dev|preview|staging|test)" },
      { name: "ANONYMIZE_BATCH_ROWS", description: "Rows updated per statement, so a large table does not hold one transaction open for its entire duration.", required: false, default: "5000" },
      TRIGGER_SECRET,
    ],
    triggers: [],
    tables: `
-- One rule per column. Declared rather than discovered: a column-name heuristic that misses one
-- column gives false confidence, which is worse than no automation at all.
CREATE TABLE IF NOT EXISTS blocks_pii_anonymizer.rules (
  id            bigserial   PRIMARY KEY,
  target_schema text        NOT NULL,
  target_table  text        NOT NULL,
  target_column text        NOT NULL,

  -- How to mask. Each strategy preserves the format the application expects, because a masked email
  -- that is not a valid email fails validation and makes the branch unusable.
  strategy      text        NOT NULL,
  -- Strategy-specific options, e.g. {"domain":"example.test"} for email.
  options       jsonb       NOT NULL DEFAULT '{}'::jsonb,

  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT rules_target_uniq UNIQUE (target_schema, target_table, target_column),
  CONSTRAINT rules_strategy_valid CHECK (strategy IN (
    'email', 'phone', 'name', 'address', 'text', 'ip', 'uuid', 'date_shift', 'null_out', 'redact'
  ))
);

-- Run history. Kept because "was this branch masked, and when?" is a question people need to answer
-- with certainty before sharing access.
CREATE TABLE IF NOT EXISTS blocks_pii_anonymizer.runs (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_name   text,
  status        text        NOT NULL DEFAULT 'running',
  rules_applied integer     NOT NULL DEFAULT 0,
  rows_masked   bigint      NOT NULL DEFAULT 0,
  -- Per-rule detail, so a partial run can be understood and resumed.
  detail        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  error         text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,

  CONSTRAINT runs_status_valid CHECK (status IN ('running', 'complete', 'failed', 'refused'))
);

CREATE INDEX IF NOT EXISTS runs_started_idx ON blocks_pii_anonymizer.runs (started_at DESC);`,
    statusView: `
  (SELECT count(*) FROM blocks_pii_anonymizer.rules WHERE is_active)     AS rules_active,
  (SELECT count(DISTINCT target_schema || '.' || target_table)
     FROM blocks_pii_anonymizer.rules WHERE is_active)                   AS tables_covered,
  (SELECT count(*) FROM blocks_pii_anonymizer.runs WHERE status = 'complete') AS runs_complete,
  (SELECT count(*) FROM blocks_pii_anonymizer.runs WHERE status = 'failed')   AS runs_failed,
  -- A refused run is the safety interlock working, not a fault.
  (SELECT count(*) FROM blocks_pii_anonymizer.runs WHERE status = 'refused')  AS runs_refused,
  -- Running for over an hour almost certainly means a function died mid-run, which leaves the branch
  -- PARTIALLY masked -- the most dangerous state, because it looks masked.
  (SELECT count(*) FROM blocks_pii_anonymizer.runs
     WHERE status = 'running' AND started_at < now() - interval '1 hour')  AS runs_stuck,
  (SELECT max(finished_at) FROM blocks_pii_anonymizer.runs WHERE status = 'complete')
                                                                          AS last_complete_run`,
    dropOrder: ["TABLE blocks_pii_anonymizer.runs", "TABLE blocks_pii_anonymizer.rules"],
    routes: [
      { method: "POST", path: "/rules", purpose: "Declare a masking rule for a column." },
      { method: "POST", path: "/run", purpose: "Mask this branch. Refuses unless the branch name matches the allow pattern." },
      { method: "GET", path: "/runs", purpose: "Masking history for this branch." },
    ],
    imports: ['import { createHmac } from "node:crypto";', 'import { quoteIdent } from "@neon-blocks/core";'],
    handlerBody: `
/**
 * Deterministic masking primitive.
 *
 * HMAC rather than a plain hash: hashing an email is trivially reversible with a dictionary, because
 * there are only so many plausible email addresses. Determinism is deliberate — the same input must
 * always produce the same output, or joins break and a bug that only reproduces for one customer
 * stops reproducing at all.
 */
export function maskValue(value: string, salt: string, strategy: string): string {
  const digest = createHmac("sha256", salt).update(value).digest("hex");

  switch (strategy) {
    case "email":
      // Format-preserving: a masked email that is not a valid email fails validation and makes the
      // branch unusable for testing.
      return \`user_\${digest.slice(0, 12)}@example.test\`;
    case "phone":
      // Keeps the +1 555 prefix so number parsers still accept it.
      return \`+1555\${parseInt(digest.slice(0, 7), 16) % 10_000_000}\`.slice(0, 12);
    case "name":
      return \`Person \${digest.slice(0, 8)}\`;
    case "address":
      return \`\${parseInt(digest.slice(0, 4), 16) % 9999} Test Street\`;
    case "ip":
      // 203.0.113.0/24 is the reserved documentation range, so a masked IP cannot be a real host.
      return \`203.0.113.\${parseInt(digest.slice(0, 2), 16) % 256}\`;
    case "uuid":
      return [digest.slice(0, 8), digest.slice(8, 12), \`4\${digest.slice(13, 16)}\`,
              \`8\${digest.slice(17, 20)}\`, digest.slice(20, 32)].join("-");
    case "redact":
      return "[REDACTED]";
    case "null_out":
      return "";
    default:
      return \`masked_\${digest.slice(0, 16)}\`;
  }
}

router.post("/rules", async (request) => {
  const body = await readJsonObject(request);

  // These identifiers are interpolated into generated UPDATE statements, so validate now.
  for (const identifier of [
    requireString(body, "schema"),
    requireString(body, "table"),
    requireString(body, "column"),
  ]) {
    quoteIdent(identifier);
  }

  await getPool().query(
    \`INSERT INTO blocks_pii_anonymizer.rules
       (target_schema, target_table, target_column, strategy, options)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (target_schema, target_table, target_column) DO UPDATE
       SET strategy = EXCLUDED.strategy, options = EXCLUDED.options, is_active = true\`,
    [
      requireString(body, "schema"),
      requireString(body, "table"),
      requireString(body, "column"),
      requireString(body, "strategy"),
      JSON.stringify(body["options"] ?? {}),
    ],
  );

  return json({ declared: \`\${body["schema"]}.\${body["table"]}.\${body["column"]}\` }, { status: 201 });
});

router.post("/run", async (request) => {
  const body = await readJsonObject(request);
  const cfg = config();
  const pool = getPool();

  // The safety interlock, checked before anything else. Masking is destructive and irreversible, and
  // the failure mode is destroying real customer data.
  const branchName = typeof body["branchName"] === "string" ? body["branchName"] : null;
  const pattern = new RegExp(cfg.get("ANONYMIZE_ALLOW_BRANCH_PATTERN"));

  if (!branchName || !pattern.test(branchName)) {
    await pool.query(
      \`INSERT INTO blocks_pii_anonymizer.runs (branch_name, status, error, finished_at)
       VALUES ($1, 'refused', $2, now())\`,
      [branchName, \`branch name does not match \${pattern.source}\`],
    );

    return problem(
      403,
      "refused",
      \`Refusing to mask: branch name \${JSON.stringify(branchName)} does not match \` +
        \`ANONYMIZE_ALLOW_BRANCH_PATTERN (\${pattern.source}). Masking is irreversible, so this \` +
        \`block will not run anywhere it cannot confirm is non-production.\`,
    );
  }

  const { rows: rules } = await pool.query<{ id: string }>(
    \`SELECT id FROM blocks_pii_anonymizer.rules WHERE is_active\`,
  );
  if (rules.length === 0) {
    return problem(400, "no_rules", "No active masking rules are declared; there is nothing to mask.");
  }

  // TODO(pii-anonymizer): the masking executor.
  //   * per rule, UPDATE in batches of ANONYMIZE_BATCH_ROWS so a large table does not hold one
  //     transaction open for its whole duration
  //   * apply maskValue() above, which is already deterministic and format-preserving
  //   * handle composite primary keys when batching
  //   * record per-rule progress in runs.detail, so a run that dies partway can be resumed --
  //     a partially masked branch is the most dangerous state, because it looks masked
  //   * Object Storage is NOT handled: it branches with your data, so documents and images
  //     containing PII are copied too. That needs the vision and extraction blocks.
  return problem(
    501,
    "not_implemented",
    \`The masking executor is not yet wired (\${rules.length} rule(s) are declared). See the TODO \` +
      \`in src/index.ts. maskValue() is implemented and deterministic; the batched UPDATE \` +
      \`generation is the remaining work.\`,
  );
});

router.get("/runs", async () => {
  const { rows } = await getPool().query(
    \`SELECT id, branch_name, status, rules_applied, rows_masked, error, started_at, finished_at
     FROM blocks_pii_anonymizer.runs ORDER BY started_at DESC LIMIT 50\`,
  );
  return json({ runs: rows });
});`,
    healthEval: `
      const rules = Number(status["rules_active"] ?? 0);
      const stuck = Number(status["runs_stuck"] ?? 0);
      const failed = Number(status["runs_failed"] ?? 0);

      if (rules === 0) problems.push("no active masking rules; a run would mask nothing");
      if (stuck > 0) {
        // The most dangerous state: it looks masked but is not.
        problems.push(
          \`\${stuck} masking run(s) have been running for over an hour. A run that died partway \` +
            \`leaves the branch PARTIALLY masked, which looks masked but is not -- do not share \` +
            \`access until a run completes.\`,
        );
      }
      if (failed > 0) problems.push(\`\${failed} masking run(s) failed\`);`,
  },
];
