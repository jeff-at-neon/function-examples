/**
 * Vector search over ingested chunks.
 *
 * Kept minimal here — full BM25 + vector + RRF fusion is block 7 (hybrid-search). This exists
 * because ingestion without any retrieval is half a product, and because it validates that
 * embeddings actually landed.
 */

import type { Queryable } from "@neon-blocks/core";
import { toVectorLiteral, type EmbeddingProvider } from "@neon-blocks/ai";

export interface SearchOptions {
  query: string;
  embeddings: EmbeddingProvider;
  limit?: number;
  /** Cosine distance ceiling, 0..2. Lower is stricter. */
  maxDistance?: number;
}

export interface SearchHit {
  documentId: string;
  objectKey: string;
  chunkIndex: number;
  content: string;
  /** Cosine distance: 0 is identical, 2 is opposite. */
  distance: number;
  startOffset: number;
  endOffset: number;
}

export async function searchChunks(
  db: Queryable,
  opts: SearchOptions,
): Promise<{ hits: SearchHit[]; model: string }> {
  const limit = Math.min(opts.limit ?? 10, 100);
  const embedded = await opts.embeddings.embed([opts.query]);
  const vector = embedded.vectors[0];
  if (!vector) throw new Error("Embedding provider returned no vector for the query");

  interface HitRow {
    [column: string]: unknown;
    document_id: string;
    object_key: string;
    chunk_index: number;
    content: string;
    distance: number;
    start_offset: number;
    end_offset: number;
  }

  // `<=>` is pgvector's cosine-distance operator and the one the HNSW index serves. Ordering by
  // anything else silently drops to a sequential scan over every chunk.
  const { rows } = await db.query<HitRow>(
    `SELECT c.document_id,
            d.object_key,
            c.chunk_index,
            c.content,
            c.embedding <=> $1::vector AS distance,
            c.start_offset,
            c.end_offset
     FROM blocks_rag.chunks c
     JOIN blocks_rag.documents d ON d.id = c.document_id
     WHERE c.embedding IS NOT NULL
       AND d.deleted_at IS NULL
       AND d.status = 'ready'
       AND ($3::float8 IS NULL OR c.embedding <=> $1::vector <= $3)
     ORDER BY c.embedding <=> $1::vector
     LIMIT $2`,
    [toVectorLiteral(vector), limit, opts.maxDistance ?? null],
  );

  return {
    hits: rows.map((row) => ({
      documentId: row.document_id,
      objectKey: row.object_key,
      chunkIndex: row.chunk_index,
      content: row.content,
      distance: Number(row.distance),
      startOffset: row.start_offset,
      endOffset: row.end_offset,
    })),
    model: embedded.model,
  };
}
