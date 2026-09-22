import { INJECTED_DB, INJECTED_STORAGE, INJECTED_AI, TRIGGER_SECRET } from "./lib/generate.mjs";

/** @type {import("./lib/generate.mjs").BlockSpec[]} */
export const SPECS = [
  {
    slug: "doc-extraction",
    rank: 16,
    name: "Structured Document Extraction",
    summary:
      "Invoices, receipts, and forms become typed rows with per-field confidence and a human-review queue.",
    billing: "meter",
    capabilities: ["postgres", "object_storage", "ai_gateway"],
    dependsOn: ["queue"],
    why:
      "The alternative is someone typing invoice totals into a form, so the bar is low -- but the part " +
      "that makes it usable in production is not the extraction, it is the confidence scoring and the " +
      "review queue. An extraction system with no review step either needs a human to check " +
      "everything, which defeats the purpose, or silently books wrong numbers.",
    notes: [
      "**Confidence is per field, not per document.** An invoice where the total is certain and the tax line is a guess needs the tax line reviewed and nothing else. A single document-level score forces all-or-nothing review.",
      "**Below-threshold fields queue for review; above-threshold ones apply.** That split is what makes the block save labour rather than relocate it.",
      "**Schemas are declared per document type**, with field types and required flags. The model is asked for exactly those fields, so a missing one is a detectable error rather than an absent key nobody notices.",
      "**A reviewed correction is stored alongside the extraction**, never overwriting it. The pair is training data and an audit trail: 'the model said 1,240.00 and a human changed it to 1,204.00' is the record you need when the numbers are disputed.",
    ],
    limits: [
      "**The extraction call is a TODO seam.** Schema-to-prompt generation and response validation are the remaining work, and they mirror block 9's tolerant-parse approach closely.",
      "**PDF rendering for vision models is not implemented.** A scanned invoice is an image and works; a born-digital PDF needs either text extraction (block 2's seam) or rasterisation, which is CPU-bound.",
      "**No table extraction.** Line items in an invoice are the hardest part of this problem and are deliberately out of scope for a first version — getting a total right is useful on its own.",
      "**Confidence is model self-reported and uncalibrated.** Useful for ranking a review queue, not for deciding a threshold without measuring against your own corpus first.",
    ],
    env: [
      INJECTED_DB,
      ...INJECTED_STORAGE,
      INJECTED_AI,
      {
        name: "EXTRACT_BUCKET",
        description: "Bucket to watch for documents.",
        required: true,
        example: "documents",
      },
      {
        name: "EXTRACT_PREFIX",
        description: "Watched key prefix.",
        required: false,
        default: "documents/",
      },
      {
        name: "EXTRACT_MODEL",
        description: "Vision-capable model. Must accept image input.",
        required: false,
        default: "gpt-4o-mini",
      },
      {
        name: "EXTRACT_CONFIDENCE_THRESHOLD",
        description:
          "Fields below this confidence queue for human review. Measure against your own corpus before trusting a value; model confidence is uncalibrated.",
        required: false,
        default: "0.8",
      },
      {
        name: "EXTRACT_MAX_BYTES",
        description: "Largest document to process.",
        required: false,
        default: "20971520",
      },
      TRIGGER_SECRET,
    ],
    triggers: [
      {
        type: "storage_object_created",
        bucketEnv: "EXTRACT_BUCKET",
        prefixEnv: "EXTRACT_PREFIX",
        functionPath: "/extract",
        description: "Extract structured fields from an uploaded document.",
      },
      {
        type: "schedule",
        cron: "43 * * * *",
        functionPath: "/reconcile",
        description:
          "Required by §5. Retries failures and picks up documents the trigger never delivered.",
      },
    ],
    tables: `
-- What to extract, per document type. Declared rather than inferred so a missing field is a
-- detectable error rather than an absent key nobody notices.
CREATE TABLE IF NOT EXISTS blocks_doc_extraction.schemas (
  code        text        PRIMARY KEY,
  description text,
  -- field name -> {type, required, description}. The description is sent to the model, so it is
  -- prompt text as much as documentation.
  fields      jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS blocks_doc_extraction.extractions (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_name   text        NOT NULL,
  object_key    text        NOT NULL,
  -- Each extraction is a paid model call, so identity includes the etag: an unchanged document is
  -- never re-extracted, an overwritten one always is.
  etag          text        NOT NULL,
  schema_code   text        REFERENCES blocks_doc_extraction.schemas(code),

  status        text        NOT NULL DEFAULT 'pending',
  -- field -> value, as extracted.
  extracted     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- field -> 0..1. Per field, not per document: an invoice with a certain total and a guessed tax
  -- line needs the tax line reviewed and nothing else.
  confidence    jsonb       NOT NULL DEFAULT '{}'::jsonb,

  model         text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  extracted_at  timestamptz,

  CONSTRAINT extractions_status_valid
    CHECK (status IN ('pending', 'extracting', 'ready', 'needs_review', 'failed', 'skipped')),
  CONSTRAINT extractions_identity UNIQUE (bucket_name, object_key, etag)
);

CREATE INDEX IF NOT EXISTS extractions_status_idx
  ON blocks_doc_extraction.extractions (status, created_at);

-- One row per field needing human attention. Queued per field so a reviewer corrects the tax line
-- without re-entering the whole invoice.
CREATE TABLE IF NOT EXISTS blocks_doc_extraction.review_queue (
  id            bigserial   PRIMARY KEY,
  extraction_id uuid        NOT NULL REFERENCES blocks_doc_extraction.extractions(id) ON DELETE CASCADE,
  field_name    text        NOT NULL,
  extracted_value text,
  confidence    real,

  -- The human's answer. Stored ALONGSIDE the extraction, never overwriting it: the pair is training
  -- data and an audit trail for when the numbers are disputed.
  corrected_value text,
  reviewed_by   text,
  reviewed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT review_field_once UNIQUE (extraction_id, field_name)
);

CREATE INDEX IF NOT EXISTS review_pending_idx
  ON blocks_doc_extraction.review_queue (confidence NULLS FIRST, created_at)
  WHERE reviewed_at IS NULL;`,
    statusView: `
  count(*)                                              AS extractions_total,
  count(*) FILTER (WHERE status = 'ready')               AS extractions_ready,
  count(*) FILTER (WHERE status = 'needs_review')        AS extractions_needs_review,
  count(*) FILTER (WHERE status = 'failed')              AS extractions_failed,
  count(*) FILTER (WHERE status IN ('pending', 'extracting')
                     AND updated_at < now() - interval '1 hour') AS extractions_stuck,
  (SELECT count(*) FROM blocks_doc_extraction.review_queue WHERE reviewed_at IS NULL)
                                                        AS review_pending,
  -- Ageing review items are the real operational signal: an extraction pipeline whose review queue
  -- is never worked is just a slower manual process.
  (SELECT count(*) FROM blocks_doc_extraction.review_queue
     WHERE reviewed_at IS NULL AND created_at < now() - interval '7 days') AS review_stale,
  (SELECT count(*) FROM blocks_doc_extraction.review_queue WHERE reviewed_at IS NOT NULL)
                                                        AS review_completed,
  (SELECT count(*) FROM blocks_doc_extraction.schemas)   AS schemas_count
FROM blocks_doc_extraction.extractions`,
    dropOrder: [
      "TABLE blocks_doc_extraction.review_queue",
      "TABLE blocks_doc_extraction.extractions",
      "TABLE blocks_doc_extraction.schemas",
    ],
    routes: [
      { method: "POST", path: "/schemas", purpose: "Declare what to extract for a document type." },
      { method: "POST", path: "/extract", purpose: "Storage trigger. Extract one document." },
      { method: "POST", path: "/reconcile", purpose: "Cron. Retries and missed deliveries." },
      { method: "GET", path: "/review", purpose: "Fields awaiting review, least confident first." },
      { method: "POST", path: "/review/:id", purpose: "Submit a correction." },
    ],
    imports: [
      'import { StorageClient, detectKind, ObjectNotFoundError } from "@neon-blocks/storage";',
    ],
    handlerBody: `
router.post("/schemas", async (request) => {
  const body = await readJsonObject(request);
  const fields = body["fields"];
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    throw new ValidationError('"fields" must be an object mapping field name to {type, required}');
  }

  await getPool().query(
    \`INSERT INTO blocks_doc_extraction.schemas (code, description, fields)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description, fields = EXCLUDED.fields\`,
    [requireString(body, "code"), body["description"] ?? null, JSON.stringify(fields)],
  );

  return json({ declared: body["code"], fieldCount: Object.keys(fields).length }, { status: 201 });
});

router.post("/extract", async (request) => {
  assertTriggerAuthentic(request, { requireSecret: false });
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "storage_object_created") {
    return problem(400, "wrong_trigger", \`/extract expects a storage trigger, got \${event.type}\`);
  }

  const cfg = config();
  if (event.bucketName !== cfg.get("EXTRACT_BUCKET")) {
    return problem(403, "wrong_bucket", "This function only handles its configured bucket");
  }

  const storage = StorageClient.fromEnv();
  const kind = detectKind({ key: event.objectKey });

  // No suffix filter on storage triggers, so everything under the prefix arrives here.
  if (kind !== "image" && kind !== "pdf") {
    return json({ ok: true, status: "skipped", reason: \`\${kind} is not an extractable document\` });
  }

  // HEAD-verify: trigger delivery is unauthenticated (§7), and each extraction costs a model call,
  // so a forged event would cost real money.
  let metadata;
  try {
    metadata = await storage.headVerified(event.bucketName, event.objectKey);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      return json({ ok: true, status: "skipped", reason: "object does not exist" });
    }
    throw err;
  }

  const maxBytes = cfg.int("EXTRACT_MAX_BYTES", { min: 1024 });
  if (metadata.size > maxBytes) {
    log.capped("document too large to extract", { size: metadata.size, maxBytes });
    return json({ ok: true, status: "skipped", reason: "over size limit" });
  }

  if (kind === "pdf") {
    // Stated rather than silently attempted: a born-digital PDF is not an image, and sending its
    // bytes to a vision model produces nothing useful.
    return json({
      ok: true,
      status: "skipped",
      reason:
        "PDF rendering is not wired. Scanned images work; born-digital PDFs need text extraction " +
        "(see block 2's parser seam) or rasterisation.",
    });
  }

  // TODO(doc-extraction): the extraction call.
  //   1. load the schema for this document type and generate a prompt from schemas.fields --
  //      including each field's description, which is prompt text as much as documentation
  //   2. request a per-field confidence alongside each value, not one document-level score
  //   3. parse tolerantly, mirroring block 9's extractJsonObject (fences, prose, nested braces)
  //   4. fields below EXTRACT_CONFIDENCE_THRESHOLD go to review_queue; the rest apply.
  //      That split is what makes this save labour rather than relocate it.
  //   5. set status to 'needs_review' when any field queued, else 'ready'
  return problem(
    501,
    "not_implemented",
    "Extraction is not yet wired. See the TODO in src/index.ts. The confidence-per-field split and " +
      "the review queue are the design decisions that matter and are already in the schema.",
  );
});

router.post("/reconcile", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", \`/reconcile expects a schedule trigger, got \${event.type}\`);
  }

  // Reset extractions abandoned mid-run. Complete and useful on its own: without it, a function that
  // dies mid-extraction leaves the document in limbo forever.
  const { rowCount } = await getPool().query(
    \`UPDATE blocks_doc_extraction.extractions
     SET status = 'pending', error = 'reset by reconciler: stuck in ' || status
     WHERE status IN ('pending', 'extracting') AND updated_at < now() - interval '1 hour'\`,
  );

  return json({ ok: true, scheduledAt: event.scheduledAt, stuckReset: rowCount ?? 0 });
});

router.get("/review", async (_request, ctx) => {
  const limit = Math.min(Number(ctx.url.searchParams.get("limit") ?? "50"), 500);

  // Least confident first: that ordering is what makes a review queue efficient to work.
  const { rows } = await getPool().query(
    \`SELECT r.id, r.extraction_id, r.field_name, r.extracted_value, r.confidence,
            e.object_key, e.schema_code
     FROM blocks_doc_extraction.review_queue r
     JOIN blocks_doc_extraction.extractions e ON e.id = r.extraction_id
     WHERE r.reviewed_at IS NULL
     ORDER BY r.confidence ASC NULLS FIRST, r.created_at
     LIMIT $1\`,
    [limit],
  );

  return json({ count: rows.length, queue: rows });
});

router.post("/review/:id", async (request, ctx) => {
  const body = await readJsonObject(request);
  const corrected = body["correctedValue"];
  if (typeof corrected !== "string") {
    throw new ValidationError('"correctedValue" is required and must be a string');
  }

  // The correction is stored alongside the extraction, never overwriting it. The pair is the audit
  // trail: "the model said 1,240.00 and a human changed it to 1,204.00".
  const { rowCount } = await getPool().query(
    \`UPDATE blocks_doc_extraction.review_queue
     SET corrected_value = $2, reviewed_by = $3, reviewed_at = now()
     WHERE id = $1 AND reviewed_at IS NULL\`,
    [ctx.params["id"], corrected, typeof body["reviewedBy"] === "string" ? body["reviewedBy"] : null],
  );

  if ((rowCount ?? 0) === 0) throw new NotFoundError("No such unreviewed queue item");
  return json({ reviewed: ctx.params["id"] });
});`,
    healthEval: `
      const stuck = Number(status["extractions_stuck"] ?? 0);
      const failed = Number(status["extractions_failed"] ?? 0);
      const reviewStale = Number(status["review_stale"] ?? 0);
      const schemas = Number(status["schemas_count"] ?? 0);

      if (schemas === 0) {
        problems.push("no extraction schemas declared; there is nothing to extract");
      }
      if (stuck > 0) problems.push(\`\${stuck} extraction(s) stuck mid-run for over an hour\`);
      if (failed > 0) problems.push(\`\${failed} extraction(s) failed\`);
      if (reviewStale > 0) {
        // An extraction pipeline whose review queue is never worked is just a slower manual process.
        problems.push(
          \`\${reviewStale} review item(s) have been waiting over 7 days; an unworked review queue \` +
            \`means this pipeline is not saving labour\`,
        );
      }`,
  },

  {
    slug: "compliance",
    rank: 17,
    name: "Compliance Pack",
    summary:
      "Hash-chained audit log, soft delete with TTL purge, and GDPR export and hard-delete.",
    billing: "meter",
    capabilities: ["postgres"],
    dependsOn: [],
    why:
      "The audit log is the part that is hard to retrofit, which is the reason to have it early. An " +
      "audit trail added after the fact covers only what the application remembers to log; a " +
      "trigger-based one captures writes from any client including psql, which is what auditors " +
      "actually ask about. Row-event triggers would make this considerably better -- see " +
      "docs/ROW_EVENTS.md.",
    notes: [
      "**Audit entries are optionally hash-chained.** Each row includes a hash of the previous row, so deleting or editing history breaks the chain detectably. Without it an audit log is only as trustworthy as the person with table access — which is precisely who you are auditing.",
      "**Capture is via a Postgres trigger, not application code.** It records writes from any client, including a human at a psql prompt. Application-level logging misses exactly the events an auditor cares about.",
      "**Soft delete and hard delete are separate operations with separate authority.** Soft delete is reversible and routine; hard delete satisfies an erasure request and is not. Conflating them means an accidental click is unrecoverable.",
      "**GDPR export assembles from declared subject links**, so adding a table to the export is a config change rather than a code change. An export that silently misses a table is a compliance failure that looks like success.",
    ],
    limits: [
      "**The chain verifier is a TODO seam.** The chain is written correctly by the trigger below; walking it to detect tampering is not implemented, and it should be a scheduled job rather than an endpoint.",
      "**Hash chaining serialises writes to the audit table.** Each entry needs the previous hash, so concurrent writes contend. Acceptable for audit volumes; not acceptable if you audit every read.",
      "**Export and erasure are per-subject and synchronous.** A subject with data across many large tables will need the queue, and the current shape does not chunk.",
      "**Retention purge is TTL-only.** Legal hold — suspending purge for data under litigation — is declared in the schema but not enforced, and enforcing it is the difference between a retention policy and a compliance control.",
    ],
    env: [
      INJECTED_DB,
      {
        name: "COMPLIANCE_HASH_CHAIN",
        description:
          "Enable hash chaining on the audit log. Makes tampering detectable at the cost of serialising audit writes.",
        required: false,
        default: "true",
      },
      {
        name: "COMPLIANCE_RETENTION_DAYS",
        description:
          "Days before soft-deleted rows are eligible for purge. Audit entries are never purged by this.",
        required: false,
        default: "30",
      },
      {
        name: "COMPLIANCE_AUDIT_RETENTION_DAYS",
        description:
          "Days audit entries are kept. Long by default: shortening it below your obligation is a compliance failure, not a storage optimisation.",
        required: false,
        default: "2555",
      },
      TRIGGER_SECRET,
    ],
    triggers: [
      {
        type: "schedule",
        cron: "23 4 * * *",
        functionPath: "/purge",
        description:
          "Purge soft-deleted rows past retention and expired audit entries. Off-peak and off the hour.",
      },
    ],
    tables: `
-- The audit log. Append-only by intent and by convention; the chain below makes violations
-- detectable rather than merely forbidden.
CREATE TABLE IF NOT EXISTS blocks_compliance.audit_log (
  id            bigserial   PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),

  -- Who and what. actor is set from a session variable, so it survives writes made outside the
  -- application -- which is exactly the case an auditor asks about.
  actor         text,
  action        text        NOT NULL,
  target_schema text        NOT NULL,
  target_table  text        NOT NULL,
  target_id     text,

  old_row       jsonb,
  new_row       jsonb,

  -- Hash of this entry's content plus the previous entry's hash. Deleting or editing history breaks
  -- the chain detectably; without it, an audit log is only as trustworthy as whoever has table
  -- access, who is precisely the person being audited.
  entry_hash    text,
  prev_hash     text,

  CONSTRAINT audit_action_valid CHECK (action IN ('insert', 'update', 'delete'))
);

CREATE INDEX IF NOT EXISTS audit_occurred_idx ON blocks_compliance.audit_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_target_idx
  ON blocks_compliance.audit_log (target_schema, target_table, target_id);
CREATE INDEX IF NOT EXISTS audit_actor_idx ON blocks_compliance.audit_log (actor, occurred_at DESC);

-- Which tables hold data for a data subject, and how to find it. Declared so adding a table to an
-- export is configuration rather than code: an export that silently misses a table is a compliance
-- failure that looks like success.
CREATE TABLE IF NOT EXISTS blocks_compliance.subject_links (
  id            bigserial   PRIMARY KEY,
  target_schema text        NOT NULL,
  target_table  text        NOT NULL,
  -- Column holding the subject identifier.
  subject_column text       NOT NULL,
  -- 'export' includes it in exports; 'erase' also hard-deletes it; 'anonymize' masks in place, for
  -- rows that must survive for accounting reasons.
  handling      text        NOT NULL DEFAULT 'export',

  CONSTRAINT subject_links_uniq UNIQUE (target_schema, target_table, subject_column),
  CONSTRAINT subject_links_handling_valid CHECK (handling IN ('export', 'erase', 'anonymize'))
);

-- Erasure and export requests, with an audit trail of their own. Regulators ask when a request was
-- received and when it was satisfied, so both timestamps are recorded.
CREATE TABLE IF NOT EXISTS blocks_compliance.subject_requests (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_ref   text        NOT NULL,
  kind          text        NOT NULL,
  status        text        NOT NULL DEFAULT 'pending',

  -- Per-table counts, so a partial completion can be understood rather than guessed at.
  detail        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  error         text,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,

  CONSTRAINT subject_requests_kind_valid CHECK (kind IN ('export', 'erase')),
  CONSTRAINT subject_requests_status_valid
    CHECK (status IN ('pending', 'running', 'complete', 'failed'))
);

CREATE INDEX IF NOT EXISTS subject_requests_pending_idx
  ON blocks_compliance.subject_requests (requested_at) WHERE status IN ('pending', 'running');

-- Suspends purge for data under litigation. Declared here; enforcement is a TODO, and that gap is
-- the difference between a retention policy and a compliance control.
CREATE TABLE IF NOT EXISTS blocks_compliance.legal_holds (
  id            bigserial   PRIMARY KEY,
  subject_ref   text,
  target_schema text,
  target_table  text,
  reason        text        NOT NULL,
  placed_by     text,
  placed_at     timestamptz NOT NULL DEFAULT now(),
  released_at   timestamptz
);

CREATE INDEX IF NOT EXISTS legal_holds_active_idx
  ON blocks_compliance.legal_holds (subject_ref) WHERE released_at IS NULL;

-- ---------------------------------------------------------------------------
-- Capture trigger
-- ---------------------------------------------------------------------------
-- Attach to your own tables. Captures writes from ANY client, including a human at a psql prompt --
-- application-level logging misses exactly the events an auditor cares about.

CREATE OR REPLACE FUNCTION blocks_compliance.audit_row_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_key_column text := COALESCE(TG_ARGV[0], 'id');
  v_old        jsonb;
  v_new        jsonb;
  v_target_id  text;
  v_prev_hash  text;
  v_entry_hash text;
  v_actor      text;
BEGIN
  v_old := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  v_new := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  v_target_id := COALESCE(v_new ->> v_key_column, v_old ->> v_key_column);

  -- Set by the application with SET LOCAL. Falls back to the database user, which is still useful:
  -- an unattributed write by 'postgres' is itself an audit finding.
  v_actor := COALESCE(
    current_setting('blocks_compliance.actor', true),
    session_user
  );

  -- Chain to the previous entry. FOR UPDATE serialises audit writes, which is the cost of making
  -- tampering detectable -- acceptable at audit volumes, not if you audit every read.
  SELECT entry_hash INTO v_prev_hash
  FROM blocks_compliance.audit_log
  ORDER BY id DESC LIMIT 1
  FOR UPDATE;

  v_entry_hash := encode(
    sha256(
      convert_to(
        COALESCE(v_prev_hash, '') || TG_OP || TG_TABLE_SCHEMA || TG_TABLE_NAME ||
        COALESCE(v_target_id, '') || COALESCE(v_old::text, '') || COALESCE(v_new::text, '') ||
        COALESCE(v_actor, ''),
        'UTF8'
      )
    ),
    'hex'
  );

  INSERT INTO blocks_compliance.audit_log
    (actor, action, target_schema, target_table, target_id, old_row, new_row, entry_hash, prev_hash)
  VALUES
    (v_actor, lower(TG_OP), TG_TABLE_SCHEMA, TG_TABLE_NAME, v_target_id,
     v_old, v_new, v_entry_hash, v_prev_hash);

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION blocks_compliance.audit_row_trigger() IS
  'Captures row changes into the hash-chained audit log. Attach with attach_audit_trigger().';

CREATE OR REPLACE FUNCTION blocks_compliance.attach_audit_trigger(
  p_schema     text,
  p_table      text,
  p_key_column text DEFAULT 'id'
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_trigger_name text := 'blocks_audit_' || p_table;
BEGIN
  -- format() with %I quotes identifiers, so a hostile or awkward table name cannot break out.
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I.%I', v_trigger_name, p_schema, p_table);
  EXECUTE format(
    'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I.%I '
    'FOR EACH ROW EXECUTE FUNCTION blocks_compliance.audit_row_trigger(%L)',
    v_trigger_name, p_schema, p_table, p_key_column
  );
END;
$$;`,
    statusView: `
  (SELECT count(*) FROM blocks_compliance.audit_log)                    AS audit_entries,
  (SELECT count(*) FROM blocks_compliance.audit_log
     WHERE occurred_at > now() - interval '1 day')                      AS audit_entries_last_day,
  -- Entries with no hash. Either chaining was disabled, or someone inserted directly -- both worth
  -- knowing about, because the chain cannot be verified across a gap.
  (SELECT count(*) FROM blocks_compliance.audit_log WHERE entry_hash IS NULL) AS audit_unchained,
  (SELECT count(*) FROM blocks_compliance.subject_links)                AS subject_links,
  (SELECT count(*) FROM blocks_compliance.subject_requests
     WHERE status IN ('pending', 'running'))                            AS requests_open,
  -- GDPR gives a one-month deadline. An open request past 30 days is a regulatory exposure, not a
  -- backlog item.
  (SELECT count(*) FROM blocks_compliance.subject_requests
     WHERE status IN ('pending', 'running')
       AND requested_at < now() - interval '30 days')                   AS requests_overdue,
  (SELECT count(*) FROM blocks_compliance.subject_requests WHERE status = 'failed')
                                                                        AS requests_failed,
  (SELECT count(*) FROM blocks_compliance.legal_holds WHERE released_at IS NULL)
                                                                        AS legal_holds_active`,
    dropOrder: [
      "FUNCTION blocks_compliance.attach_audit_trigger(text, text, text)",
      "FUNCTION blocks_compliance.audit_row_trigger()",
      "TABLE blocks_compliance.legal_holds",
      "TABLE blocks_compliance.subject_requests",
      "TABLE blocks_compliance.subject_links",
      "TABLE blocks_compliance.audit_log",
    ],
    routes: [
      { method: "POST", path: "/subject-links", purpose: "Declare where a data subject's rows live." },
      { method: "POST", path: "/requests", purpose: "Open an export or erasure request." },
      { method: "GET", path: "/requests/:id", purpose: "Request status and per-table detail." },
      { method: "POST", path: "/purge", purpose: "Cron. TTL purge of soft-deleted rows." },
    ],
    imports: ['import { quoteIdent } from "@neon-blocks/core";'],
    downNote:
      "This destroys the audit log. That is usually the single most compliance-significant table in the database, and its whole value is that it cannot be quietly removed. Export it, with the chain intact, before rolling back.",
    handlerBody: `
router.post("/subject-links", async (request) => {
  const body = await readJsonObject(request);

  // These identifiers reach generated SQL during export and erasure, so validate them at declaration
  // time rather than when a regulator is waiting.
  for (const identifier of [
    requireString(body, "schema"),
    requireString(body, "table"),
    requireString(body, "subjectColumn"),
  ]) {
    quoteIdent(identifier);
  }

  const handling = typeof body["handling"] === "string" ? body["handling"] : "export";
  if (!["export", "erase", "anonymize"].includes(handling)) {
    throw new ValidationError('"handling" must be one of export, erase, anonymize');
  }

  await getPool().query(
    \`INSERT INTO blocks_compliance.subject_links
       (target_schema, target_table, subject_column, handling)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (target_schema, target_table, subject_column) DO UPDATE
       SET handling = EXCLUDED.handling\`,
    [
      requireString(body, "schema"),
      requireString(body, "table"),
      requireString(body, "subjectColumn"),
      handling,
    ],
  );

  return json({ declared: \`\${body["schema"]}.\${body["table"]}\`, handling }, { status: 201 });
});

router.post("/requests", async (request) => {
  const body = await readJsonObject(request);
  const kind = requireString(body, "kind");
  if (kind !== "export" && kind !== "erase") {
    throw new ValidationError('"kind" must be "export" or "erase"');
  }

  const pool = getPool();
  const subjectRef = requireString(body, "subjectRef");

  // A hold means data is under litigation. Erasing it would destroy evidence, so the request is
  // refused rather than queued -- the conflict needs a human decision.
  const { rows: holds } = await pool.query<{ reason: string }>(
    \`SELECT reason FROM blocks_compliance.legal_holds
     WHERE released_at IS NULL AND (subject_ref = $1 OR subject_ref IS NULL)\`,
    [subjectRef],
  );

  if (kind === "erase" && holds.length > 0) {
    return problem(
      409,
      "legal_hold",
      \`Refusing to queue erasure: \${holds.length} active legal hold(s) cover this subject \` +
        \`(\${holds[0]?.reason}). Erasing data under litigation destroys evidence, so this needs a \` +
        \`human decision and an explicit hold release.\`,
    );
  }

  const { rows } = await pool.query<{ id: string }>(
    \`INSERT INTO blocks_compliance.subject_requests (subject_ref, kind)
     VALUES ($1, $2) RETURNING id\`,
    [subjectRef, kind],
  );

  // TODO(compliance): execute the request.
  //   * export: SELECT from every subject_links row with handling in (export, erase, anonymize),
  //     assembling one JSON document. Declared links are why adding a table is config, not code.
  //   * erase: DELETE where handling='erase', apply masking where handling='anonymize' (rows that
  //     must survive for accounting), and record per-table counts in detail
  //   * both should run through the queue for subjects with data in large tables; the current shape
  //     does not chunk
  return json(
    {
      id: rows[0]?.id,
      kind,
      status: "pending",
      note:
        "Request recorded. Execution is not yet wired -- see the TODO in src/index.ts. The " +
        "legal-hold check above is enforced.",
    },
    { status: 202 },
  );
});

router.get("/requests/:id", async (_request, ctx) => {
  const { rows } = await getPool().query(
    \`SELECT id, subject_ref, kind, status, detail, error, requested_at, completed_at
     FROM blocks_compliance.subject_requests WHERE id = $1\`,
    [ctx.params["id"]],
  );
  if (rows.length === 0) throw new NotFoundError("No such request");
  return json({ request: rows[0] });
});

router.post("/purge", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", \`/purge expects a schedule trigger, got \${event.type}\`);
  }

  const cfg = config();
  const auditRetention = cfg.int("COMPLIANCE_AUDIT_RETENTION_DAYS", { min: 1, max: 36_500 });

  // TODO(compliance): soft-delete purge across declared tables, honouring legal_holds. The hold
  // check is the part that makes this a compliance control rather than a cron job.
  //
  // Audit purge is deliberately NOT implemented here either: deleting audit entries breaks the hash
  // chain, so it needs chain re-anchoring rather than a plain DELETE. Doing it naively would make
  // the log unverifiable, which defeats the point of chaining it.
  return json({
    ok: true,
    scheduledAt: event.scheduledAt,
    auditRetentionDays: auditRetention,
    purged: 0,
    note:
      "Purge is not yet wired. Note that audit purge needs hash-chain re-anchoring, not a plain " +
      "DELETE -- otherwise the log becomes unverifiable.",
  });
});`,
    healthEval: `
      const unchained = Number(status["audit_unchained"] ?? 0);
      const overdue = Number(status["requests_overdue"] ?? 0);
      const failed = Number(status["requests_failed"] ?? 0);
      const links = Number(status["subject_links"] ?? 0);

      if (links === 0) {
        problems.push(
          "no subject links declared; an export would return nothing and appear to succeed",
        );
      }
      if (unchained > 0) {
        problems.push(
          \`\${unchained} audit entry/entries have no hash. The chain cannot be verified across a \` +
            \`gap, so tampering before that point would not be detectable.\`,
        );
      }
      if (overdue > 0) {
        // GDPR's deadline is one month. This is regulatory exposure, not a backlog item.
        problems.push(
          \`\${overdue} subject request(s) have been open for over 30 days, past the GDPR deadline\`,
        );
      }
      if (failed > 0) problems.push(\`\${failed} subject request(s) failed\`);`,
  },

  {
    slug: "moderation",
    rank: 18,
    name: "Moderation and Quarantine",
    summary:
      "Classifies uploads and text for abuse, and quarantines by default so unreviewed content is never served.",
    billing: "meter",
    capabilities: ["postgres", "object_storage", "ai_gateway"],
    dependsOn: ["queue"],
    why:
      "A trust-and-safety requirement for any app with user-generated content, and the one design " +
      "decision that matters is fail-closed: content is quarantined until it passes, not served until " +
      "it fails. Fail-open moderation means the window between upload and classification is a window " +
      "in which anything can be served, and that window is exactly when abuse is posted.",
    notes: [
      "**Quarantine by default, release on pass.** The alternative — serve immediately, remove on fail — guarantees a serving window for the worst content. Ordering is the whole control.",
      "**Categories are scored independently.** 'Adult' and 'violence' and 'self-harm' have genuinely different thresholds and different escalation paths; one aggregate score forces one policy.",
      "**Thresholds are configurable per category and default strict.** A moderation block with permissive defaults is worse than none, because it creates a belief that content was checked.",
      "**A human decision always beats a model score, and is recorded as such.** Appeals exist, models are wrong, and 'a human approved this on the 14th' is what you need when a decision is challenged.",
    ],
    limits: [
      "**Classification calls are TODO seams**, for both image and text. The quarantine state machine, thresholds, and decision recording are real; the model calls are not written.",
      "**Malware scanning is not implemented.** It needs a real engine (ClamAV or a scanning API) and cannot be done by an LLM. The status is modelled so the field is not silently absent, but nothing populates it.",
      "**No CSAM detection or reporting.** This requires hash-matching against law-enforcement databases, specific legal obligations, and cannot responsibly be a generic block. If you host user uploads, you need a dedicated provider for this — stated plainly because implying coverage here would be harmful.",
      "**No perceptual-hash matching** against previously-blocked content, so the same image must be re-classified on every upload.",
    ],
    env: [
      INJECTED_DB,
      ...INJECTED_STORAGE,
      INJECTED_AI,
      {
        name: "MODERATION_BUCKET",
        description: "Bucket to watch for uploads.",
        required: true,
        example: "uploads",
      },
      {
        name: "MODERATION_PREFIX",
        description: "Watched key prefix.",
        required: false,
        default: "uploads/",
      },
      {
        name: "MODERATION_QUARANTINE_PREFIX",
        description:
          "Prefix quarantined objects move to. Must be disjoint from the watched prefix, or moving an object retriggers moderation of itself.",
        required: false,
        default: "quarantine/",
      },
      {
        name: "MODERATION_MODEL",
        description: "Vision-capable model for image classification.",
        required: false,
        default: "gpt-4o-mini",
      },
      {
        name: "MODERATION_THRESHOLDS",
        description:
          'Per-category block thresholds as JSON, e.g. {"adult":0.5,"violence":0.7}. Strict by default: permissive defaults create a false belief that content was checked.',
        required: false,
        default: '{"adult":0.5,"violence":0.6,"self_harm":0.4,"hate":0.4,"harassment":0.6}',
      },
      TRIGGER_SECRET,
    ],
    triggers: [
      {
        type: "storage_object_created",
        bucketEnv: "MODERATION_BUCKET",
        prefixEnv: "MODERATION_PREFIX",
        functionPath: "/scan",
        description: "Classify a newly uploaded object.",
      },
      {
        type: "schedule",
        cron: "31 * * * *",
        functionPath: "/reconcile",
        description:
          "Required by §5, and load-bearing here: an object the trigger missed stays quarantined, so a missed delivery is a stuck upload rather than unmoderated content.",
      },
    ],
    tables: `
CREATE TABLE IF NOT EXISTS blocks_moderation.items (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Either a storage object or inline text. One table so the review queue and the decision history
  -- are shared rather than duplicated per content type.
  bucket_name   text,
  object_key    text,
  etag          text,
  content_text  text,

  kind          text        NOT NULL,

  -- Quarantined until proven otherwise. Fail-closed: the alternative -- serve now, remove on fail --
  -- guarantees a window in which the worst content is served, and that window is exactly when abuse
  -- is posted.
  status        text        NOT NULL DEFAULT 'quarantined',

  -- category -> 0..1. Scored independently because adult, violence, and self-harm warrant different
  -- thresholds and different escalation paths.
  scores        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- Categories that crossed their threshold.
  flagged       text[]      NOT NULL DEFAULT '{}',

  -- Modelled so the field is not silently absent, but nothing populates it: malware scanning needs a
  -- real engine and cannot be done by an LLM.
  malware_status text       NOT NULL DEFAULT 'unscanned',

  model         text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,

  CONSTRAINT items_kind_valid CHECK (kind IN ('image', 'video', 'text', 'document', 'other')),
  CONSTRAINT items_status_valid
    CHECK (status IN ('quarantined', 'scanning', 'approved', 'blocked', 'needs_review', 'failed')),
  CONSTRAINT items_malware_valid
    CHECK (malware_status IN ('unscanned', 'clean', 'infected', 'scan_failed')),
  -- Either an object or text, never neither.
  CONSTRAINT items_has_content CHECK (object_key IS NOT NULL OR content_text IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS items_status_idx ON blocks_moderation.items (status, created_at);
CREATE INDEX IF NOT EXISTS items_object_idx ON blocks_moderation.items (bucket_name, object_key);
CREATE INDEX IF NOT EXISTS items_flagged_idx ON blocks_moderation.items USING gin (flagged);
-- Serves the "what is stuck in quarantine?" question, which is the operational one.
CREATE INDEX IF NOT EXISTS items_quarantined_idx
  ON blocks_moderation.items (created_at) WHERE status IN ('quarantined', 'needs_review');

-- Decision history. A human decision always beats a model score and is recorded as such: appeals
-- exist, models are wrong, and "a human approved this on the 14th" is what you need when a decision
-- is challenged.
CREATE TABLE IF NOT EXISTS blocks_moderation.decisions (
  id          bigserial   PRIMARY KEY,
  item_id     uuid        NOT NULL REFERENCES blocks_moderation.items(id) ON DELETE CASCADE,
  decision    text        NOT NULL,
  -- 'model' or 'human'. The distinction is the audit trail.
  source      text        NOT NULL,
  actor       text,
  reason      text,
  decided_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT decisions_decision_valid CHECK (decision IN ('approve', 'block', 'escalate')),
  CONSTRAINT decisions_source_valid CHECK (source IN ('model', 'human'))
);

CREATE INDEX IF NOT EXISTS decisions_item_idx ON blocks_moderation.decisions (item_id, decided_at);`,
    statusView: `
  count(*)                                              AS items_total,
  count(*) FILTER (WHERE status = 'quarantined')         AS items_quarantined,
  count(*) FILTER (WHERE status = 'approved')            AS items_approved,
  count(*) FILTER (WHERE status = 'blocked')             AS items_blocked,
  count(*) FILTER (WHERE status = 'needs_review')        AS items_needs_review,
  count(*) FILTER (WHERE status = 'failed')              AS items_failed,

  -- Quarantined for over an hour. Because this block fails closed, a stuck item is a user's upload
  -- that never appeared -- a functional bug, not a safety one.
  count(*) FILTER (WHERE status IN ('quarantined', 'scanning')
                     AND created_at < now() - interval '1 hour') AS items_stuck,
  count(*) FILTER (WHERE malware_status = 'infected')    AS items_infected,
  -- Nothing populates malware scanning yet, so this counts everything. Surfaced rather than hidden.
  count(*) FILTER (WHERE malware_status = 'unscanned')   AS items_unscanned,
  (SELECT count(*) FROM blocks_moderation.decisions WHERE source = 'human') AS human_decisions
FROM blocks_moderation.items`,
    dropOrder: ["TABLE blocks_moderation.decisions", "TABLE blocks_moderation.items"],
    routes: [
      { method: "POST", path: "/scan", purpose: "Storage trigger. Classify an upload." },
      { method: "POST", path: "/text", purpose: "Classify inline text synchronously." },
      { method: "POST", path: "/reconcile", purpose: "Cron. Rescan stuck items." },
      { method: "GET", path: "/review", purpose: "Items awaiting human review." },
      { method: "POST", path: "/decide/:id", purpose: "Record a human decision." },
    ],
    imports: [
      'import { StorageClient, detectKind, ObjectNotFoundError } from "@neon-blocks/storage";',
    ],
    handlerBody: `
router.post("/scan", async (request) => {
  assertTriggerAuthentic(request, { requireSecret: false });
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "storage_object_created") {
    return problem(400, "wrong_trigger", \`/scan expects a storage trigger, got \${event.type}\`);
  }

  const cfg = config();
  if (event.bucketName !== cfg.get("MODERATION_BUCKET")) {
    return problem(403, "wrong_bucket", "This function only moderates its configured bucket");
  }

  // §8: quarantined objects are moved within storage, so the quarantine prefix must be disjoint from
  // the watched prefix or moving an object would retrigger moderation of itself, forever.
  assertNoLoop({
    inputBucket: cfg.get("MODERATION_BUCKET"),
    inputPrefix: cfg.get("MODERATION_PREFIX"),
    outputBucket: cfg.get("MODERATION_BUCKET"),
    outputPrefix: cfg.get("MODERATION_QUARANTINE_PREFIX"),
  });

  const storage = StorageClient.fromEnv();

  let metadata;
  try {
    metadata = await storage.headVerified(event.bucketName, event.objectKey);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      return json({ ok: true, status: "skipped", reason: "object does not exist" });
    }
    throw err;
  }

  const kind = detectKind({ key: event.objectKey, contentType: metadata.contentType });

  // Recorded as quarantined FIRST, before any classification. If this function dies mid-scan the
  // object stays quarantined, which is the safe direction -- the failure mode is a user's upload not
  // appearing, not unmoderated content being served.
  const { rows } = await getPool().query<{ id: string }>(
    \`INSERT INTO blocks_moderation.items (bucket_name, object_key, etag, kind, status)
     VALUES ($1, $2, $3, $4, 'quarantined')
     ON CONFLICT DO NOTHING
     RETURNING id\`,
    [event.bucketName, event.objectKey, metadata.etag, kind === "unknown" ? "other" : kind],
  );

  // TODO(moderation): classification.
  //   1. for images: presign a short-lived GET and ask the vision model for per-category scores
  //   2. for text: classify content_text
  //   3. compare each score against MODERATION_THRESHOLDS -- per category, since adult, violence,
  //      and self-harm warrant different thresholds
  //   4. all clear -> status 'approved'; any breach -> 'blocked' and move the object under
  //      MODERATION_QUARANTINE_PREFIX; borderline -> 'needs_review'
  //   5. record a decisions row with source='model'
  //
  //   Malware scanning is NOT part of this: it needs a real engine (ClamAV or a scanning API) and
  //   cannot be done by an LLM. malware_status stays 'unscanned'.
  return json({
    ok: true,
    itemId: rows[0]?.id ?? null,
    status: "quarantined",
    note:
      "Recorded and quarantined. Classification is not yet wired -- see the TODO in src/index.ts. " +
      "The item stays quarantined, which is the fail-closed direction.",
  });
});

router.post("/text", async (request) => {
  const body = await readJsonObject(request);
  const text = requireString(body, "text");

  const { rows } = await getPool().query<{ id: string }>(
    \`INSERT INTO blocks_moderation.items (content_text, kind, status)
     VALUES ($1, 'text', 'quarantined') RETURNING id\`,
    [text.slice(0, 100_000)],
  );

  // TODO(moderation): text classification. Same threshold comparison as /scan.
  return json({
    itemId: rows[0]?.id,
    status: "quarantined",
    note: "Text classification is not yet wired. The item is quarantined, not approved.",
  }, { status: 202 });
});

router.post("/reconcile", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", \`/reconcile expects a schedule trigger, got \${event.type}\`);
  }

  // Reset items abandoned mid-scan so they are classified rather than sitting quarantined forever.
  // Load-bearing for this block specifically: because it fails closed, a missed delivery is a user's
  // upload that never appeared.
  const { rowCount } = await getPool().query(
    \`UPDATE blocks_moderation.items
     SET status = 'quarantined', error = 'reset by reconciler: stuck in scanning'
     WHERE status = 'scanning' AND updated_at < now() - interval '1 hour'\`,
  );

  return json({ ok: true, scheduledAt: event.scheduledAt, stuckReset: rowCount ?? 0 });
});

router.get("/review", async (_request, ctx) => {
  const limit = Math.min(Number(ctx.url.searchParams.get("limit") ?? "50"), 500);
  const { rows } = await getPool().query(
    \`SELECT id, bucket_name, object_key, kind, status, scores, flagged, created_at
     FROM blocks_moderation.items
     WHERE status IN ('needs_review', 'quarantined')
     ORDER BY created_at
     LIMIT $1\`,
    [limit],
  );
  return json({ count: rows.length, queue: rows });
});

router.post("/decide/:id", async (request, ctx) => {
  const body = await readJsonObject(request);
  const decision = requireString(body, "decision");
  if (!["approve", "block", "escalate"].includes(decision)) {
    throw new ValidationError('"decision" must be one of approve, block, escalate');
  }

  const pool = getPool();

  // A human decision overrides the model score. Recorded with source='human' so the override is
  // visible -- which is what you need when a decision is challenged.
  const { rowCount } = await pool.query(
    \`UPDATE blocks_moderation.items
     SET status = CASE $2
                    WHEN 'approve' THEN 'approved'
                    WHEN 'block' THEN 'blocked'
                    ELSE 'needs_review' END,
         decided_at = now()
     WHERE id = $1\`,
    [ctx.params["id"], decision],
  );
  if ((rowCount ?? 0) === 0) throw new NotFoundError("No such item");

  await pool.query(
    \`INSERT INTO blocks_moderation.decisions (item_id, decision, source, actor, reason)
     VALUES ($1, $2, 'human', $3, $4)\`,
    [
      ctx.params["id"],
      decision,
      typeof body["actor"] === "string" ? body["actor"] : null,
      typeof body["reason"] === "string" ? body["reason"] : null,
    ],
  );

  return json({ itemId: ctx.params["id"], decision, source: "human" });
});`,
    healthEval: `
      const stuck = Number(status["items_stuck"] ?? 0);
      const failed = Number(status["items_failed"] ?? 0);
      const infected = Number(status["items_infected"] ?? 0);
      const review = Number(status["items_needs_review"] ?? 0);

      if (infected > 0) problems.push(\`\${infected} item(s) are flagged as infected\`);
      if (stuck > 0) {
        // Fail-closed means a stuck item is a functional bug, not a safety gap.
        problems.push(
          \`\${stuck} item(s) stuck in quarantine for over an hour. Because this block fails closed, \` +
            \`those are uploads that never became visible to their owners.\`,
        );
      }
      if (failed > 0) problems.push(\`\${failed} item(s) failed classification and remain quarantined\`);
      if (review > 50) problems.push(\`\${review} item(s) awaiting human review\`);`,
  },

  {
    slug: "transcription",
    rank: 19,
    name: "Audio and Video Transcription",
    summary:
      "Whisper-class transcription with timestamps, feeding the same search index as documents.",
    billing: "meter",
    capabilities: ["postgres", "object_storage", "ai_gateway"],
    dependsOn: ["queue", "rag"],
    why:
      "Makes spoken content searchable, which is the point: a two-hour meeting recording is unusable " +
      "until you can find the thirty seconds that matter. It writes into the same chunk table the RAG " +
      "block owns, so hybrid search covers audio and documents with one query rather than two.",
    notes: [
      "**Orchestrate, never transcode in-function.** Transcoding is the most CPU-expensive thing you could do here, and functions run at a fixed size. The provider accepts the original file, or the file is rejected — no ffmpeg.",
      "**Segments with timestamps, not a wall of text.** A transcript without timestamps can be searched but not navigated, and 'somewhere in this two-hour recording' is barely better than nothing.",
      "**Chunks are written into the RAG block's table** so hybrid search covers audio and documents together. Declared via `dependsOn`, which is what makes that cross-schema write legitimate.",
      "**Long media is expected to exceed provider limits.** The block records a specific 'too long' status rather than failing generically, because that is a routine outcome needing a different remedy (split the file) than a transient error.",
    ],
    limits: [
      "**The transcription call is a TODO seam.** Provider APIs differ in how they accept media — URL versus multipart upload — and that choice determines whether bytes flow through the function at all.",
      "**No diarisation.** 'Who said what' needs a provider that supports speaker labels; segments carry no speaker field yet.",
      "**No transcoding, by design.** A format the provider rejects is rejected here too. That is a deliberate cost decision, and the README states it rather than implying broad format support.",
      "**Duration is not verified before the call.** A file over the provider's limit fails at the provider rather than being caught locally, which wastes a call — reading media duration needs a parser.",
    ],
    env: [
      INJECTED_DB,
      ...INJECTED_STORAGE,
      INJECTED_AI,
      {
        name: "TRANSCRIBE_BUCKET",
        description: "Bucket to watch for media.",
        required: true,
        example: "media",
      },
      {
        name: "TRANSCRIBE_PREFIX",
        description: "Watched key prefix.",
        required: false,
        default: "media/",
      },
      {
        name: "TRANSCRIBE_MODEL",
        description: "Transcription model.",
        required: false,
        default: "whisper-1",
      },
      {
        name: "TRANSCRIBE_MAX_BYTES",
        description:
          "Largest media file to attempt. Provider limits are usually well below this, so keep it conservative.",
        required: false,
        default: "26214400",
      },
      {
        name: "TRANSCRIBE_INDEX_CHUNKS",
        description:
          "Write transcript chunks into blocks_rag.chunks so hybrid search covers spoken content.",
        required: false,
        default: "true",
      },
      TRIGGER_SECRET,
    ],
    triggers: [
      {
        type: "storage_object_created",
        bucketEnv: "TRANSCRIBE_BUCKET",
        prefixEnv: "TRANSCRIBE_PREFIX",
        functionPath: "/transcribe",
        description: "Transcribe newly uploaded media.",
      },
      {
        type: "schedule",
        cron: "53 * * * *",
        functionPath: "/reconcile",
        description: "Required by §5. Retries and missed deliveries.",
      },
    ],
    tables: `
CREATE TABLE IF NOT EXISTS blocks_transcription.transcripts (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_name   text        NOT NULL,
  object_key    text        NOT NULL,
  -- Transcription is among the most expensive calls in the catalog per invocation, so identity
  -- includes the etag: unchanged media is never re-transcribed.
  etag          text        NOT NULL,

  status        text        NOT NULL DEFAULT 'pending',
  kind          text,

  -- Full text, for display and for a quick LIKE. Segments below are the navigable form.
  full_text     text,
  language      text,
  duration_seconds real,

  model         text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  transcribed_at timestamptz,

  CONSTRAINT transcripts_status_valid
    CHECK (status IN ('pending', 'transcribing', 'ready', 'failed', 'skipped', 'too_long')),
  CONSTRAINT transcripts_identity UNIQUE (bucket_name, object_key, etag)
);

CREATE INDEX IF NOT EXISTS transcripts_status_idx
  ON blocks_transcription.transcripts (status, created_at);

-- Timestamped segments. A transcript without timestamps can be searched but not navigated, and
-- "somewhere in this two-hour recording" is barely better than nothing.
CREATE TABLE IF NOT EXISTS blocks_transcription.segments (
  id            bigserial   PRIMARY KEY,
  transcript_id uuid        NOT NULL REFERENCES blocks_transcription.transcripts(id) ON DELETE CASCADE,
  segment_index integer     NOT NULL,
  start_seconds real        NOT NULL,
  end_seconds   real        NOT NULL,
  text          text        NOT NULL,

  CONSTRAINT segments_order_uniq UNIQUE (transcript_id, segment_index),
  CONSTRAINT segments_times_sane CHECK (end_seconds >= start_seconds)
);

CREATE INDEX IF NOT EXISTS segments_transcript_idx
  ON blocks_transcription.segments (transcript_id, segment_index);

-- Full-text over segments, so a search result can jump to a timestamp rather than a document.
ALTER TABLE blocks_transcription.segments
  ADD COLUMN IF NOT EXISTS text_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', text)) STORED;

CREATE INDEX IF NOT EXISTS segments_tsv_idx ON blocks_transcription.segments USING gin (text_tsv);`,
    statusView: `
  count(*)                                              AS transcripts_total,
  count(*) FILTER (WHERE status = 'ready')               AS transcripts_ready,
  count(*) FILTER (WHERE status = 'failed')              AS transcripts_failed,
  count(*) FILTER (WHERE status = 'skipped')             AS transcripts_skipped,
  -- A routine outcome with a specific remedy (split the file), not a generic failure.
  count(*) FILTER (WHERE status = 'too_long')            AS transcripts_too_long,
  count(*) FILTER (WHERE status IN ('pending', 'transcribing')
                     AND updated_at < now() - interval '2 hours') AS transcripts_stuck,
  COALESCE(round(sum(duration_seconds)::numeric / 3600, 1), 0) AS hours_transcribed,
  (SELECT count(*) FROM blocks_transcription.segments)   AS segments_total,
  -- Ready transcripts with no segments have text but cannot be navigated, which defeats the point.
  count(*) FILTER (WHERE status = 'ready'
    AND NOT EXISTS (SELECT 1 FROM blocks_transcription.segments s
                    WHERE s.transcript_id = blocks_transcription.transcripts.id)) AS ready_without_segments
FROM blocks_transcription.transcripts`,
    dropOrder: [
      "TABLE blocks_transcription.segments",
      "TABLE blocks_transcription.transcripts",
    ],
    routes: [
      { method: "POST", path: "/transcribe", purpose: "Storage trigger. Transcribe one file." },
      { method: "POST", path: "/reconcile", purpose: "Cron. Retries and missed deliveries." },
      { method: "GET", path: "/search", purpose: "Search spoken content, returning timestamps." },
      { method: "GET", path: "/transcripts/:id", purpose: "A transcript with its segments." },
    ],
    imports: [
      'import { StorageClient, detectKind, ObjectNotFoundError } from "@neon-blocks/storage";',
    ],
    handlerBody: `
router.post("/transcribe", async (request) => {
  assertTriggerAuthentic(request, { requireSecret: false });
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "storage_object_created") {
    return problem(400, "wrong_trigger", \`/transcribe expects a storage trigger, got \${event.type}\`);
  }

  const cfg = config();
  if (event.bucketName !== cfg.get("TRANSCRIBE_BUCKET")) {
    return problem(403, "wrong_bucket", "This function only transcribes its configured bucket");
  }

  const storage = StorageClient.fromEnv();
  const kind = detectKind({ key: event.objectKey });

  if (kind !== "audio" && kind !== "video") {
    return json({ ok: true, status: "skipped", reason: \`\${kind} is not media\` });
  }

  let metadata;
  try {
    metadata = await storage.headVerified(event.bucketName, event.objectKey);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      return json({ ok: true, status: "skipped", reason: "object does not exist" });
    }
    throw err;
  }

  const maxBytes = cfg.int("TRANSCRIBE_MAX_BYTES", { min: 1024 });
  if (metadata.size > maxBytes) {
    // Recorded as too_long rather than failed: the remedy is to split the file, which is different
    // from retrying.
    await getPool().query(
      \`INSERT INTO blocks_transcription.transcripts
         (bucket_name, object_key, etag, kind, status, error)
       VALUES ($1, $2, $3, $4, 'too_long', $5)
       ON CONFLICT (bucket_name, object_key, etag) DO UPDATE
         SET status = 'too_long', error = EXCLUDED.error\`,
      [event.bucketName, event.objectKey, metadata.etag, kind,
       \`file is \${metadata.size} bytes, over the \${maxBytes} limit; split it and re-upload\`],
    );
    log.capped("media too large to transcribe", { size: metadata.size, maxBytes });
    return json({ ok: true, status: "too_long", reason: "over size limit" });
  }

  // TODO(transcription): the provider call.
  //   * decide URL-based versus multipart submission. This choice determines whether media bytes
  //     flow through the function at all, which dominates both cost and latency -- prefer a
  //     presigned URL the provider fetches itself.
  //   * request timestamped segments, not just text: a transcript you cannot navigate is barely
  //     better than nothing for long recordings
  //   * insert segments, set full_text, language, duration_seconds
  //   * when TRANSCRIBE_INDEX_CHUNKS is true, also write chunks into blocks_rag.chunks so hybrid
  //     search covers spoken content in the same query as documents (this is why the block declares
  //     dependsOn: rag)
  //
  //   Do NOT transcode. It is the most CPU-expensive thing possible here, functions run at a fixed
  //   size, and a format the provider rejects should be rejected here too.
  return problem(
    501,
    "not_implemented",
    "Transcription is not yet wired. See the TODO in src/index.ts -- note that media should be " +
      "fetched by the provider from a presigned URL rather than streamed through the function.",
  );
});

router.post("/reconcile", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", \`/reconcile expects a schedule trigger, got \${event.type}\`);
  }

  // Two hours rather than one: transcription is genuinely slow, so a shorter window would reset
  // work that is still legitimately in progress.
  const { rowCount } = await getPool().query(
    \`UPDATE blocks_transcription.transcripts
     SET status = 'pending', error = 'reset by reconciler: stuck in ' || status
     WHERE status IN ('pending', 'transcribing') AND updated_at < now() - interval '2 hours'\`,
  );

  return json({ ok: true, scheduledAt: event.scheduledAt, stuckReset: rowCount ?? 0 });
});

router.get("/search", async (_request, ctx) => {
  const query = ctx.url.searchParams.get("q");
  if (!query) throw new ValidationError("?q= is required");
  const limit = Math.min(Number(ctx.url.searchParams.get("limit") ?? "25"), 200);

  // Returns timestamps, which is the whole point: a hit lets the caller jump to the moment rather
  // than to the file.
  const { rows } = await getPool().query(
    \`SELECT t.object_key, s.start_seconds, s.end_seconds, s.text,
            ts_rank_cd(s.text_tsv, websearch_to_tsquery('english', $1)) AS rank
     FROM blocks_transcription.segments s
     JOIN blocks_transcription.transcripts t ON t.id = s.transcript_id
     WHERE s.text_tsv @@ websearch_to_tsquery('english', $1)
       AND t.status = 'ready'
     ORDER BY rank DESC
     LIMIT $2\`,
    [query, limit],
  );

  return json({ query, count: rows.length, hits: rows });
});

router.get("/transcripts/:id", async (_request, ctx) => {
  const pool = getPool();
  const { rows } = await pool.query(
    \`SELECT * FROM blocks_transcription.transcripts WHERE id = $1\`,
    [ctx.params["id"]],
  );
  if (rows.length === 0) throw new NotFoundError("No such transcript");

  const { rows: segments } = await pool.query(
    \`SELECT segment_index, start_seconds, end_seconds, text
     FROM blocks_transcription.segments WHERE transcript_id = $1
     ORDER BY segment_index\`,
    [ctx.params["id"]],
  );

  return json({ transcript: rows[0], segments });
});`,
    healthEval: `
      const stuck = Number(status["transcripts_stuck"] ?? 0);
      const failed = Number(status["transcripts_failed"] ?? 0);
      const noSegments = Number(status["ready_without_segments"] ?? 0);

      if (stuck > 0) problems.push(\`\${stuck} transcript(s) stuck for over two hours\`);
      if (failed > 0) problems.push(\`\${failed} transcription(s) failed\`);
      if (noSegments > 0) {
        problems.push(
          \`\${noSegments} ready transcript(s) have no segments, so they cannot be navigated by \` +
            \`timestamp -- which is most of the value for long recordings\`,
        );
      }`,
  },

  {
    slug: "semantic-cache",
    rank: 20,
    name: "Semantic Cache for LLM Calls",
    summary:
      "Caches model responses by embedding similarity, so a rephrased question reuses an existing answer.",
    billing: "free",
    capabilities: ["postgres", "pgvector", "ai_gateway"],
    dependsOn: [],
    why:
      "Cuts AI spend on repeated questions. An exact-match cache misses almost everything, because " +
      "nobody asks the same question the same way twice -- similarity matching is what makes a cache " +
      "hit at all.",
    notes: [
      "**Similarity threshold is the entire design.** Too low and you return an answer to a different question, which is worse than a cache miss because it is silently wrong. Default is deliberately strict.",
      "**Namespaces keep prompts separate.** A cached answer for one system prompt or one tenant must never serve another; conflating them is a cross-tenant data leak wearing a performance improvement.",
      "**The model identity is part of the key.** A cached response from a weaker model must not be served as if it came from a stronger one, so entries are scoped by model rather than shared.",
      "**Cost saved is tracked explicitly.** A cache nobody can measure gets removed during the next cleanup, and the token counts are what justify keeping it.",
    ],
    limits: [
      "**The lookup and store path is a TODO seam.** Schema, indexes, and the threshold policy are specified; the embed-then-search call is not written.",
      "**A cache hit still costs one embedding call.** Cheaper than the completion it replaces, but not free — so for very short prompts the saving is thin, and the README says so rather than implying it is free.",
      "**No invalidation on knowledge change.** If your underlying data changes, cached answers go stale with nothing to detect it. TTL is the only defence, and it is blunt.",
      "**Similarity is not equivalence.** Two prompts can be semantically close and still require different answers ('delete my account' versus 'do not delete my account'). Negation is the known weak spot of embedding similarity, and no threshold fixes it.",
    ],
    env: [
      INJECTED_DB,
      INJECTED_AI,
      {
        name: "CACHE_SIMILARITY_THRESHOLD",
        description:
          "Cosine similarity required for a hit, 0..1. Strict by default: a loose threshold returns answers to different questions, which is worse than a miss because it is silently wrong.",
        required: false,
        default: "0.95",
      },
      {
        name: "CACHE_TTL_HOURS",
        description:
          "How long an entry is servable. The only defence against staleness, and a blunt one.",
        required: false,
        default: "168",
      },
      {
        name: "CACHE_EMBEDDING_MODEL",
        description: "Must be consistent across the cache, or similarity is meaningless.",
        required: false,
        default: "text-embedding-3-small",
      },
      {
        name: "CACHE_EMBEDDING_DIMENSIONS",
        description: "Must match the model and the vector column.",
        required: false,
        default: "1536",
      },
      TRIGGER_SECRET,
    ],
    triggers: [
      {
        type: "schedule",
        cron: "37 3 * * *",
        functionPath: "/sweep",
        description: "Expire entries past TTL and report hit rate. Without it the table grows without bound.",
      },
    ],
    tables: `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS blocks_semantic_cache.entries (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Keeps prompts separate. A cached answer for one system prompt or tenant must never serve
  -- another: conflating them is a cross-tenant data leak wearing a performance improvement.
  namespace     text        NOT NULL DEFAULT 'default',

  prompt        text        NOT NULL,
  -- Exact-match fast path. Cheap to check and skips the embedding call entirely on a repeat.
  prompt_hash   text        NOT NULL,
  prompt_embedding vector(1536),

  response      text        NOT NULL,
  -- Part of the key, not metadata: a response from a weaker model must not be served as if it came
  -- from a stronger one.
  model         text        NOT NULL,

  -- What the original call cost, so savings can be measured. A cache nobody can measure gets
  -- removed during the next cleanup.
  prompt_tokens integer,
  completion_tokens integer,

  hit_count     integer     NOT NULL DEFAULT 0,
  last_hit_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,

  CONSTRAINT entries_namespace_hash_model_uniq UNIQUE (namespace, prompt_hash, model)
);

CREATE INDEX IF NOT EXISTS entries_expiry_idx ON blocks_semantic_cache.entries (expires_at);
CREATE INDEX IF NOT EXISTS entries_namespace_idx ON blocks_semantic_cache.entries (namespace, model);

-- HNSW over cosine distance. No training step, so it works on an empty table -- unlike IVFFlat,
-- which silently performs terribly when built before any rows exist.
CREATE INDEX IF NOT EXISTS entries_embedding_idx
  ON blocks_semantic_cache.entries USING hnsw (prompt_embedding vector_cosine_ops);

-- Hit and miss counters. Aggregated rather than per-request rows: the cache exists to save money,
-- and logging every lookup would add write volume to the path meant to be cheap.
CREATE TABLE IF NOT EXISTS blocks_semantic_cache.stats (
  namespace     text        NOT NULL,
  day           date        NOT NULL,
  hits          bigint      NOT NULL DEFAULT 0,
  misses        bigint      NOT NULL DEFAULT 0,
  -- Tokens the cache avoided spending. The number that justifies keeping it.
  tokens_saved  bigint      NOT NULL DEFAULT 0,

  PRIMARY KEY (namespace, day)
);`,
    statusView: `
  (SELECT count(*) FROM blocks_semantic_cache.entries)                  AS entries_total,
  (SELECT count(*) FROM blocks_semantic_cache.entries WHERE expires_at > now())
                                                                        AS entries_live,
  -- Expired but not swept. A growing number means the sweeper is not running.
  (SELECT count(*) FROM blocks_semantic_cache.entries WHERE expires_at <= now())
                                                                        AS entries_expired,
  -- Entries with no vector can never be matched by similarity, only by exact hash.
  (SELECT count(*) FROM blocks_semantic_cache.entries WHERE prompt_embedding IS NULL)
                                                                        AS entries_unembedded,
  (SELECT COALESCE(sum(hits), 0) FROM blocks_semantic_cache.stats)      AS hits_total,
  (SELECT COALESCE(sum(misses), 0) FROM blocks_semantic_cache.stats)    AS misses_total,
  -- The number that decides whether this block is worth keeping.
  (SELECT COALESCE(round(100.0 * sum(hits) / GREATEST(sum(hits) + sum(misses), 1), 1), 0)
     FROM blocks_semantic_cache.stats)                                  AS hit_rate_pct,
  (SELECT COALESCE(sum(tokens_saved), 0) FROM blocks_semantic_cache.stats) AS tokens_saved,
  (SELECT count(DISTINCT model) FROM blocks_semantic_cache.entries)      AS models_cached`,
    dropOrder: ["TABLE blocks_semantic_cache.stats", "TABLE blocks_semantic_cache.entries"],
    routes: [
      { method: "POST", path: "/lookup", purpose: "Find a cached response for a prompt." },
      { method: "POST", path: "/store", purpose: "Cache a response." },
      { method: "POST", path: "/sweep", purpose: "Cron. Expire entries and report hit rate." },
      { method: "GET", path: "/stats", purpose: "Hit rate and tokens saved by namespace." },
    ],
    imports: ['import { createHash } from "node:crypto";'],
    handlerBody: `
router.post("/lookup", async (request) => {
  const body = await readJsonObject(request);
  const prompt = requireString(body, "prompt");
  const model = requireString(body, "model");
  const namespace = typeof body["namespace"] === "string" ? body["namespace"] : "default";

  const promptHash = createHash("sha256").update(\`\${namespace}:\${model}:\${prompt}\`).digest("hex");
  const pool = getPool();

  // Exact-match fast path first: it skips the embedding call entirely, so a repeated identical
  // prompt costs one indexed lookup and nothing else.
  const { rows: exact } = await pool.query<{ id: string; response: string; model: string }>(
    \`UPDATE blocks_semantic_cache.entries
     SET hit_count = hit_count + 1, last_hit_at = now()
     WHERE namespace = $1 AND prompt_hash = $2 AND model = $3 AND expires_at > now()
     RETURNING id, response, model\`,
    [namespace, promptHash, model],
  );

  if (exact[0]) {
    await recordStat(pool, namespace, "hit", 0);
    return json({ hit: true, kind: "exact", response: exact[0].response, model: exact[0].model });
  }

  // TODO(semantic-cache): the similarity path.
  //   1. embed the prompt with CACHE_EMBEDDING_MODEL
  //   2. SELECT ... ORDER BY prompt_embedding <=> $1 LIMIT 1, scoped to namespace AND model --
  //      scoping is not optional: crossing namespaces is a cross-tenant leak, and crossing models
  //      serves a weaker model's answer as a stronger one's
  //   3. accept only when 1 - distance >= CACHE_SIMILARITY_THRESHOLD. Strict by default: a loose
  //      threshold returns an answer to a DIFFERENT question, which is worse than a miss because it
  //      is silently wrong.
  //   4. on a hit, increment hit_count and record tokens_saved from the stored counts
  //
  //   Known limitation no threshold fixes: negation. "delete my account" and "do not delete my
  //   account" embed very closely and require opposite answers.
  await recordStat(pool, namespace, "miss", 0);
  return json({
    hit: false,
    note:
      "Exact-match lookup ran and missed. Similarity matching is not yet wired -- see the TODO in " +
      "src/index.ts.",
  });
});

router.post("/store", async (request) => {
  const body = await readJsonObject(request);
  const prompt = requireString(body, "prompt");
  const response = requireString(body, "response");
  const model = requireString(body, "model");
  const namespace = typeof body["namespace"] === "string" ? body["namespace"] : "default";

  const cfg = config();
  const ttlHours = cfg.int("CACHE_TTL_HOURS", { min: 1, max: 8_760 });
  const promptHash = createHash("sha256").update(\`\${namespace}:\${model}:\${prompt}\`).digest("hex");

  // Stored without an embedding for now, so the exact-match path works immediately. The similarity
  // path needs the embedding, which is part of the TODO above -- v_status surfaces unembedded
  // entries so this gap is visible rather than silent.
  const { rows } = await getPool().query<{ id: string }>(
    \`INSERT INTO blocks_semantic_cache.entries
       (namespace, prompt, prompt_hash, response, model, prompt_tokens, completion_tokens, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(hours => $8::int))
     ON CONFLICT (namespace, prompt_hash, model) DO UPDATE
       SET response = EXCLUDED.response,
           expires_at = EXCLUDED.expires_at
     RETURNING id\`,
    [
      namespace, prompt, promptHash, response, model,
      typeof body["promptTokens"] === "number" ? body["promptTokens"] : null,
      typeof body["completionTokens"] === "number" ? body["completionTokens"] : null,
      ttlHours,
    ],
  );

  return json({ id: rows[0]?.id, embedded: false }, { status: 201 });
});

router.post("/sweep", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", \`/sweep expects a schedule trigger, got \${event.type}\`);
  }

  // Complete and worth running on its own: without it the table grows without bound and every
  // similarity search gets slower.
  const { rowCount } = await getPool().query(
    \`DELETE FROM blocks_semantic_cache.entries WHERE expires_at <= now()\`,
  );

  return json({ ok: true, scheduledAt: event.scheduledAt, expired: rowCount ?? 0 });
});

router.get("/stats", async (_request, ctx) => {
  const namespace = ctx.url.searchParams.get("namespace");
  const { rows } = await getPool().query(
    \`SELECT namespace, day, hits, misses, tokens_saved,
            round(100.0 * hits / GREATEST(hits + misses, 1), 1) AS hit_rate_pct
     FROM blocks_semantic_cache.stats
     WHERE ($1::text IS NULL OR namespace = $1)
     ORDER BY day DESC, namespace
     LIMIT 90\`,
    [namespace],
  );
  return json({ stats: rows });
});

/**
 * Record a hit or miss.
 *
 * Aggregated per day rather than one row per lookup: this block exists to save money, and adding
 * write volume to the path meant to be cheap would undercut it.
 */
async function recordStat(
  db: { query: (sql: string, params?: readonly unknown[]) => Promise<unknown> },
  namespace: string,
  kind: "hit" | "miss",
  tokensSaved: number,
): Promise<void> {
  await db.query(
    \`INSERT INTO blocks_semantic_cache.stats (namespace, day, hits, misses, tokens_saved)
     VALUES ($1, CURRENT_DATE, $2, $3, $4)
     ON CONFLICT (namespace, day) DO UPDATE
       SET hits = blocks_semantic_cache.stats.hits + EXCLUDED.hits,
           misses = blocks_semantic_cache.stats.misses + EXCLUDED.misses,
           tokens_saved = blocks_semantic_cache.stats.tokens_saved + EXCLUDED.tokens_saved\`,
    [namespace, kind === "hit" ? 1 : 0, kind === "miss" ? 1 : 0, tokensSaved],
  );
}`,
    healthEval: `
      const expired = Number(status["entries_expired"] ?? 0);
      const unembedded = Number(status["entries_unembedded"] ?? 0);
      const live = Number(status["entries_live"] ?? 0);

      if (expired > 1_000) {
        problems.push(
          \`\${expired} expired entry/entries not yet swept; the /sweep trigger may be disabled\`,
        );
      }
      if (unembedded > 0 && live > 0) {
        problems.push(
          \`\${unembedded} entry/entries have no embedding and can only be matched exactly, not by \` +
            \`similarity -- which is most of the value\`,
        );
      }`,
  },
];
