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
];
