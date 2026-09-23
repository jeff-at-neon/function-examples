/**
 * Block 7 — Hybrid Search.
 *
 * BM25 + vector + trigram, combined by reciprocal rank fusion. Completes block 2: ingestion without
 * good retrieval is half a product.
 *
 * Routes:
 *   POST /search  hybrid query
 *   POST /click   record a click, for relevance measurement
 *   GET  /health  observability
 *
 * No cron trigger: this block only reads. Nothing drifts, so there is nothing to reconcile.
 */

import {
  checkHealth,
  createLogger,
  getPool,
  json,
  loadConfig,
  Router,
  ValidationError,
  type Logger,
} from "@neon-blocks/core";
import { autoMigrate } from "@neon-blocks/migrate";
import { defaultEmbeddings } from "@neon-blocks/ai";
import { hybridSearch, logQuery } from "./search.js";

const log: Logger = createLogger({ block: "hybrid-search" });

const SPEC = {
  block: "hybrid-search",
  optional: {
    SEARCH_EMBEDDING_MODEL: "text-embedding-3-small",
    SEARCH_EMBEDDING_DIMENSIONS: "1536",
    SEARCH_WEIGHT_VECTOR: "1",
    SEARCH_WEIGHT_FULLTEXT: "1",
    SEARCH_WEIGHT_TRIGRAM: "0.5",
    SEARCH_RRF_K: "60",
    SEARCH_DEFAULT_LIMIT: "10",
    SEARCH_LOG_QUERIES: "true",
  },
} as const;

function config() {
  const raw = loadConfig(SPEC);
  return {
    model: raw.get("SEARCH_EMBEDDING_MODEL"),
    dimensions: raw.int("SEARCH_EMBEDDING_DIMENSIONS", { min: 1, max: 16_000 }),
    weights: {
      // Weights are floats, so parsed directly rather than via int().
      vector: Number(raw.get("SEARCH_WEIGHT_VECTOR")),
      fulltext: Number(raw.get("SEARCH_WEIGHT_FULLTEXT")),
      trigram: Number(raw.get("SEARCH_WEIGHT_TRIGRAM")),
    },
    rrfK: raw.int("SEARCH_RRF_K", { min: 1, max: 1_000 }),
    defaultLimit: raw.int("SEARCH_DEFAULT_LIMIT", { min: 1, max: 100 }),
    logQueries: raw.bool("SEARCH_LOG_QUERIES"),
  };
}

const router = new Router();

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

  const { query, limit, documentId, tenant, weights } = body as Record<string, unknown>;
  if (typeof query !== "string" || query.trim() === "") {
    throw new ValidationError('"query" is required and must be a non-empty string');
  }

  const cfg = config();
  const pool = getPool();

  const outcome = await hybridSearch(pool, {
    query,
    embeddings: defaultEmbeddings({ model: cfg.model, dimensions: cfg.dimensions }),
    limit: typeof limit === "number" ? limit : cfg.defaultLimit,
    // Per-request weight overrides, so relevance can be A/B tested without a redeploy.
    weights:
      typeof weights === "object" && weights !== null
        ? { ...cfg.weights, ...(weights as Record<string, number>) }
        : cfg.weights,
    rrfK: cfg.rrfK,
    ...(typeof documentId === "string" ? { documentId } : {}),
    logger: log,
  });

  let queryId: string | null = null;
  if (cfg.logQueries) {
    queryId = await logQuery(pool, {
      query,
      retrievers: outcome.retrieversRun,
      resultCount: outcome.hits.length,
      durationMs: outcome.durationMs,
      ...(typeof tenant === "string" ? { tenant } : {}),
    });
  }

  return json({
    query,
    queryId,
    count: outcome.hits.length,
    durationMs: outcome.durationMs,
    // Returned so a caller can see which retrievers contributed — the thing that makes a
    // surprising ranking debuggable rather than mysterious.
    retrievers: outcome.retrieversRun,
    hits: outcome.hits,
  });
});

router.post("/click", async (request) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ValidationError("Request body is not valid JSON");
  }
  const { queryId, chunkId, rank } = (body ?? {}) as Record<string, unknown>;

  if (typeof queryId !== "string") throw new ValidationError('"queryId" is required');
  if (typeof chunkId !== "string") throw new ValidationError('"chunkId" is required');
  if (typeof rank !== "number" || rank < 1) {
    throw new ValidationError('"rank" is required and must be a 1-based position');
  }

  await getPool().query(
    `INSERT INTO blocks_hybrid_search.clicks (query_id, chunk_id, rank)
     VALUES ($1::bigint, $2::bigint, $3)`,
    [queryId, chunkId, rank],
  );

  return json({ recorded: true }, { status: 201 });
});

router.get("/health", async () => {
  const report = await checkHealth(getPool(), {
    block: "hybrid-search",
    schema: "blocks_hybrid_search",
    extra: async (db) => {
      // Searching an empty corpus returns nothing and looks like a broken ranking, so surface it
      // directly. Guarded because the rag block may not be installed.
      try {
        const { rows } = await db.query<{ chunks: string; embedded: string }>(
          `SELECT count(*)::text AS chunks,
                  count(*) FILTER (WHERE embedding IS NOT NULL)::text AS embedded
           FROM blocks_rag.chunks`,
        );
        return {
          corpus_chunks: Number(rows[0]?.chunks ?? 0),
          corpus_embedded: Number(rows[0]?.embedded ?? 0),
        };
      } catch {
        return { corpus_chunks: null, corpus_note: "blocks_rag.chunks not found; install the rag block" };
      }
    },
    evaluate: (status) => {
      const problems: string[] = [];
      const zeroPct = Number(status["zero_result_pct"] ?? 0);
      const total = Number(status["queries_total"] ?? 0);
      const corpus = status["corpus_chunks"];

      if (corpus === null) {
        problems.push("no searchable corpus: blocks_rag.chunks does not exist");
      } else if (corpus === 0) {
        problems.push("corpus is empty; every search will return nothing");
      }

      // Ratio, not count. A handful of empty results is normal; a quarter of all queries returning
      // nothing means the corpus or the retrieval is wrong.
      if (total >= 20 && zeroPct > 25) {
        problems.push(
          `${zeroPct}% of queries return no results. Review ` +
            `blocks_hybrid_search.v_zero_result_queries — each row is either missing content or a ` +
            `retrieval gap.`,
        );
      }
      return problems;
    },
  });

  return json(report, { status: report.status === "ok" ? 200 : 503 });
});

export default autoMigrate({
  block: "hybrid-search",
  migrationsUrl: new URL("./migrations/", import.meta.url),
  fetch: (request: Request): Promise<Response> => router.handle(request),
});

export { hybridSearch, logQuery } from "./search.js";
export {
  reciprocalRankFusion,
  toRanked,
  normalizeSearchQuery,
  shouldUseTrigram,
  DEFAULT_RRF_K,
  type FusedItem,
  type RetrieverResult,
} from "./fusion.js";
