/**
 * Block 2 — Document → RAG Ingestion.
 *
 * The catalog's flagship demo: drop a document in a bucket and it becomes semantically
 * searchable. Lights up Object Storage + pgvector + AI Gateway + Functions in one gesture.
 *
 * Routes:
 *   POST /ingest     storage trigger — ingest one uploaded object
 *   POST /reconcile  cron — find missed uploads, mark deletions, requeue stuck documents
 *   POST /search     HTTP — vector search over ingested chunks
 *   GET  /health     observability
 */

import {
  assertNoLoop,
  assertTriggerAuthentic,
  checkHealth,
  createLogger,
  getPool,
  json,
  loadConfig,
  parseTriggerEvent,
  problem,
  Router,
  ValidationError,
  type Logger,
} from "@neon-blocks/core";
import { autoMigrate } from "@neon-blocks/migrate";
import { defaultEmbeddings } from "@neon-blocks/ai";
import { StorageClient } from "@neon-blocks/storage";
import { ingestObject } from "./ingest.js";
import { reconcile } from "./reconcile.js";
import { searchChunks } from "./search.js";

const log: Logger = createLogger({ block: "rag" });

const SPEC = {
  block: "rag",
  required: ["RAG_BUCKET"],
  optional: {
    RAG_PREFIX: "uploads/",
    RAG_EMBEDDING_MODEL: "text-embedding-3-small",
    RAG_EMBEDDING_DIMENSIONS: "1536",
    RAG_CHUNK_CHARS: "1000",
    RAG_CHUNK_OVERLAP: "150",
    RAG_MAX_BYTES: "26214400",
  },
} as const;

function config() {
  const raw = loadConfig(SPEC);
  const cfg = {
    bucket: raw.get("RAG_BUCKET"),
    prefix: raw.get("RAG_PREFIX"),
    model: raw.get("RAG_EMBEDDING_MODEL"),
    dimensions: raw.int("RAG_EMBEDDING_DIMENSIONS", { min: 1, max: 16_000 }),
    chunkChars: raw.int("RAG_CHUNK_CHARS", { min: 100, max: 100_000 }),
    chunkOverlap: raw.int("RAG_CHUNK_OVERLAP", { min: 0, max: 10_000 }),
    maxBytes: raw.int("RAG_MAX_BYTES", { min: 1_024 }),
  };

  // This block reads and writes the same bucket only in the sense that it never writes at all —
  // but assert anyway, so that adding a "save extracted text" feature later cannot quietly
  // create a self-retriggering loop.
  assertNoLoop({
    inputBucket: cfg.bucket,
    inputPrefix: cfg.prefix,
    outputBucket: cfg.bucket,
    outputPrefix: `${cfg.prefix}__rag_derived/`,
  });

  return cfg;
}

const router = new Router();

router.post("/ingest", async (request) => {
  assertTriggerAuthentic(request, { requireSecret: false });
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "storage_object_created") {
    return problem(400, "wrong_trigger", `/ingest expects a storage trigger, got ${event.type}`);
  }

  const cfg = config();

  // The trigger is bucket-scoped, but delivery is unauthenticated, so a forged POST could name
  // any bucket. Refuse anything outside the configured one.
  if (event.bucketName !== cfg.bucket) {
    log.warn("rejecting event for unexpected bucket", {
      received: event.bucketName,
      expected: cfg.bucket,
    });
    return problem(403, "wrong_bucket", `This function only ingests from "${cfg.bucket}"`);
  }

  const result = await ingestObject(getPool(), {
    bucket: event.bucketName,
    objectKey: event.objectKey,
    storage: StorageClient.fromEnv(),
    embeddings: defaultEmbeddings({ model: cfg.model, dimensions: cfg.dimensions }),
    maxBytes: cfg.maxBytes,
    chunkChars: cfg.chunkChars,
    chunkOverlap: cfg.chunkOverlap,
    logger: log.child({ objectKey: event.objectKey }),
  });

  // 200 even for skipped/failed-because-absent: these are terminal, correct outcomes and a 5xx
  // would invite retries of work that will never succeed.
  return json({ ok: true, ...result });
});

router.post("/reconcile", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", `/reconcile expects a schedule trigger, got ${event.type}`);
  }

  const cfg = config();
  const storage = StorageClient.fromEnv();
  const pool = getPool();

  const result = await reconcile(pool, {
    bucket: cfg.bucket,
    prefix: cfg.prefix,
    storage,
    logger: log,
  });

  // Ingest what the trigger missed. Bounded per run so a large backlog is worked down over
  // several passes instead of blowing the invocation budget in one.
  const toIngest = result.missingIngested.slice(0, 25);
  const ingested: string[] = [];
  for (const objectKey of toIngest) {
    try {
      await ingestObject(pool, {
        bucket: cfg.bucket,
        objectKey,
        storage,
        embeddings: defaultEmbeddings({ model: cfg.model, dimensions: cfg.dimensions }),
        maxBytes: cfg.maxBytes,
        chunkChars: cfg.chunkChars,
        chunkOverlap: cfg.chunkOverlap,
        logger: log.child({ objectKey, via: "reconcile" }),
      });
      ingested.push(objectKey);
    } catch (err) {
      // One bad document must not abort the sweep — the rest of the backlog still needs working.
      log.error("reconcile ingestion failed", {
        objectKey,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (result.missingIngested.length > toIngest.length) {
    log.capped("reconcile ingestion batch limited", {
      found: result.missingIngested.length,
      ingested: toIngest.length,
    });
  }

  return json({
    ok: true,
    scheduledAt: event.scheduledAt,
    ...result,
    ingestedNow: ingested.length,
    remaining: result.missingIngested.length - toIngest.length,
  });
});

router.post("/search", async (request) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ValidationError("Request body is not valid JSON");
  }
  if (typeof body !== "object" || body === null) {
    throw new ValidationError("Request body must be a JSON object");
  }

  const { query, limit, maxDistance } = body as Record<string, unknown>;
  if (typeof query !== "string" || query.trim() === "") {
    throw new ValidationError('"query" is required and must be a non-empty string');
  }

  const cfg = config();
  const result = await searchChunks(getPool(), {
    query,
    embeddings: defaultEmbeddings({ model: cfg.model, dimensions: cfg.dimensions }),
    ...(typeof limit === "number" ? { limit } : {}),
    ...(typeof maxDistance === "number" ? { maxDistance } : {}),
  });

  return json({ query, model: result.model, hits: result.hits });
});

router.get("/health", async () => {
  const report = await checkHealth(getPool(), {
    block: "rag",
    schema: "blocks_rag",
    evaluate: (status) => {
      const problems: string[] = [];
      const failed = Number(status["documents_failed"] ?? 0);
      const stuck = Number(status["documents_stuck"] ?? 0);
      const unembedded = Number(status["chunks_unembedded"] ?? 0);
      const models = Number(status["embedding_models_in_use"] ?? 0);

      if (stuck > 0) {
        problems.push(`${stuck} document(s) stuck mid-pipeline for over an hour`);
      }
      if (failed > 0) problems.push(`${failed} document(s) failed ingestion`);
      if (unembedded > 0) {
        problems.push(`${unembedded} chunk(s) have no embedding and cannot be retrieved`);
      }
      if (models > 1) {
        // Silently degraded search: vectors from different models aren't comparable, so
        // retrieval quality drops without anything erroring.
        problems.push(
          `${models} different embedding models are in use; vectors are not mutually ` +
            `comparable and search quality is degraded. Re-ingest with one model.`,
        );
      }
      return problems;
    },
  });

  return json(report, { status: report.status === "ok" ? 200 : 503 });
});

export default autoMigrate({
  block: "rag",
  migrationsUrl: new URL("./migrations/", import.meta.url),
  fetch: (request: Request): Promise<Response> => router.handle(request),
});

export { ingestObject } from "./ingest.js";
export { reconcile } from "./reconcile.js";
export { searchChunks } from "./search.js";
export { extractText, stripHtml, normalizeText } from "./extract.js";
