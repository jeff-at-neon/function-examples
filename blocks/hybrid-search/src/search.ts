/**
 * Hybrid retrieval: run each retriever independently, then fuse by rank.
 *
 * The retrievers are separate queries rather than one clever SQL statement with `UNION` and a
 * hand-rolled score. Three reasons: each retriever's index is actually used (mixing `<=>` ordering
 * with a `tsquery` filter defeats both), a retriever can be disabled by weight without rewriting
 * SQL, and the fusion stays pure and testable.
 */

import { createLogger, type Logger, type Queryable } from "@neon-blocks/core";
import { toVectorLiteral, type EmbeddingProvider } from "@neon-blocks/ai";
import {
  normalizeSearchQuery,
  reciprocalRankFusion,
  shouldUseTrigram,
  toRanked,
  type RetrieverResult,
} from "./fusion.js";

export interface SearchOptions {
  query: string;
  embeddings: EmbeddingProvider;
  limit?: number;
  /** Per-retriever depth. Fusion needs more candidates than the final limit to work with. */
  candidateDepth?: number;
  weights?: { vector?: number; fulltext?: number; trigram?: number };
  rrfK?: number;
  /** Restrict to one document, for in-document search. */
  documentId?: string;
  logger?: Logger;
}

export interface SearchHit {
  chunkId: string;
  documentId: string;
  objectKey: string;
  chunkIndex: number;
  content: string;
  score: number;
  /** Which retrievers found this, and where. The explainability that makes tuning possible. */
  matchedBy: string[];
}

export interface SearchOutcome {
  hits: SearchHit[];
  retrieversRun: Record<string, number>;
  durationMs: number;
}

/**
 * Run a hybrid search.
 *
 * Candidate depth defaults to 4× the limit: fusion can only reorder what the retrievers returned,
 * so a depth equal to the limit means a document ranked 11th by vector and 1st by full-text is
 * never seen at all, which is exactly the case hybrid search exists to catch.
 */
export async function hybridSearch(db: Queryable, opts: SearchOptions): Promise<SearchOutcome> {
  const log = opts.logger ?? createLogger({ block: "hybrid-search" });
  const startedAt = Date.now();

  const query = normalizeSearchQuery(opts.query);
  const limit = Math.min(opts.limit ?? 10, 100);
  const depth = Math.min(opts.candidateDepth ?? limit * 4, 500);
  const weights = {
    vector: opts.weights?.vector ?? 1,
    fulltext: opts.weights?.fulltext ?? 1,
    trigram: opts.weights?.trigram ?? 0.5,
  };

  const results: RetrieverResult[] = [];
  const retrieversRun: Record<string, number> = {};

  // Vector retriever. Embedding the query is the one network call in the path, so it is skipped
  // entirely when the retriever is disabled — no point paying for an embedding nobody uses.
  if (weights.vector > 0) {
    const embedded = await opts.embeddings.embed([query]);
    const vector = embedded.vectors[0];
    if (vector) {
      const ids = await vectorCandidates(db, vector, depth, opts.documentId);
      results.push({ name: "vector", items: toRanked(ids), weight: weights.vector });
      retrieversRun["vector"] = ids.length;
    }
  }

  if (weights.fulltext > 0) {
    const ids = await fulltextCandidates(db, query, depth, opts.documentId);
    results.push({ name: "fulltext", items: toRanked(ids), weight: weights.fulltext });
    retrieversRun["fulltext"] = ids.length;
  }

  // Trigram only for short queries: it is expensive over large tables, and long queries already
  // give full-text enough signal for a typo not to matter.
  if (weights.trigram > 0 && shouldUseTrigram(query)) {
    const ids = await trigramCandidates(db, query, depth, opts.documentId);
    results.push({ name: "trigram", items: toRanked(ids), weight: weights.trigram });
    retrieversRun["trigram"] = ids.length;
  }

  const fused = reciprocalRankFusion(results, {
    limit,
    ...(opts.rrfK !== undefined ? { k: opts.rrfK } : {}),
  });

  if (fused.length === 0) {
    log.info("search returned nothing", { query, retrieversRun });
    return { hits: [], retrieversRun, durationMs: Date.now() - startedAt };
  }

  const hits = await hydrate(db, fused.map((f) => f.id));
  const byId = new Map(hits.map((h) => [h.chunkId, h]));

  // Reassemble in fused order: the hydration query returns rows in whatever order Postgres likes,
  // and losing the ranking here would silently undo the entire fusion step.
  const ordered = fused.flatMap((f) => {
    const hit = byId.get(f.id);
    if (!hit) return [];
    return [
      {
        ...hit,
        score: f.score,
        matchedBy: f.contributions.map((c) => c.retriever),
      },
    ];
  });

  return { hits: ordered, retrieversRun, durationMs: Date.now() - startedAt };
}

/** Vector nearest neighbours. Ordering by `<=>` is what lets the HNSW index serve the query. */
async function vectorCandidates(
  db: Queryable,
  vector: readonly number[],
  limit: number,
  documentId?: string,
): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT c.id::text AS id
     FROM blocks_rag.chunks c
     JOIN blocks_rag.documents d ON d.id = c.document_id
     WHERE c.embedding IS NOT NULL
       AND d.status = 'ready' AND d.deleted_at IS NULL
       AND ($3::uuid IS NULL OR c.document_id = $3)
     ORDER BY c.embedding <=> $1::vector
     LIMIT $2`,
    [toVectorLiteral(vector), limit, documentId ?? null],
  );
  return rows.map((r) => r.id);
}

/**
 * BM25-style full-text ranking.
 *
 * `websearch_to_tsquery` rather than `to_tsquery` because it never raises on user input — a search
 * box that returns 500 for a stray `&` is unacceptable, and `to_tsquery('a & & b')` does exactly
 * that.
 */
async function fulltextCandidates(
  db: Queryable,
  query: string,
  limit: number,
  documentId?: string,
): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT c.id::text AS id
     FROM blocks_rag.chunks c
     JOIN blocks_rag.documents d ON d.id = c.document_id
     WHERE c.content_tsv @@ websearch_to_tsquery('english', $1)
       AND d.status = 'ready' AND d.deleted_at IS NULL
       AND ($3::uuid IS NULL OR c.document_id = $3)
     ORDER BY ts_rank_cd(c.content_tsv, websearch_to_tsquery('english', $1)) DESC
     LIMIT $2`,
    [query, limit, documentId ?? null],
  );
  return rows.map((r) => r.id);
}

/**
 * Trigram similarity, for typo tolerance.
 *
 * `%` uses the GIN trigram index; `similarity()` alone would force a sequential scan over every
 * chunk, which is the difference between a fast query and a timeout on a real corpus.
 */
async function trigramCandidates(
  db: Queryable,
  query: string,
  limit: number,
  documentId?: string,
): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT c.id::text AS id
     FROM blocks_rag.chunks c
     JOIN blocks_rag.documents d ON d.id = c.document_id
     WHERE c.content % $1
       AND d.status = 'ready' AND d.deleted_at IS NULL
       AND ($3::uuid IS NULL OR c.document_id = $3)
     ORDER BY similarity(c.content, $1) DESC
     LIMIT $2`,
    [query, limit, documentId ?? null],
  );
  return rows.map((r) => r.id);
}

async function hydrate(db: Queryable, chunkIds: readonly string[]): Promise<SearchHit[]> {
  interface Row {
    [column: string]: unknown;
    id: string;
    document_id: string;
    object_key: string;
    chunk_index: number;
    content: string;
  }

  const { rows } = await db.query<Row>(
    `SELECT c.id::text AS id, c.document_id::text AS document_id, d.object_key,
            c.chunk_index, c.content
     FROM blocks_rag.chunks c
     JOIN blocks_rag.documents d ON d.id = c.document_id
     WHERE c.id = ANY($1::bigint[])`,
    [chunkIds],
  );

  return rows.map((row) => ({
    chunkId: row.id,
    documentId: row.document_id,
    objectKey: row.object_key,
    chunkIndex: row.chunk_index,
    content: row.content,
    score: 0,
    matchedBy: [],
  }));
}

/** Record a query for relevance tuning. Failures here must never fail the search. */
export async function logQuery(
  db: Queryable,
  opts: {
    query: string;
    retrievers: Record<string, number>;
    resultCount: number;
    durationMs: number;
    tenant?: string;
  },
): Promise<string | null> {
  try {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO blocks_hybrid_search.queries
         (query_text, retrievers, result_count, duration_ms, tenant)
       VALUES ($1, $2::jsonb, $3, $4, $5)
       RETURNING id::text AS id`,
      [
        opts.query.slice(0, 1_000),
        JSON.stringify(opts.retrievers),
        opts.resultCount,
        opts.durationMs,
        opts.tenant ?? null,
      ],
    );
    return rows[0]?.id ?? null;
  } catch {
    // Telemetry is not worth a failed user-facing search.
    return null;
  }
}
