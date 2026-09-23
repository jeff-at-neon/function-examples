/**
 * Scan orchestration: the impure edge that needs Postgres and an embedding provider. Detection and
 * the watermark advance are delegated to the pure helpers in freshness.ts; this file only issues
 * the queries and the embedding calls, which cannot run offline.
 */

import { quoteIdent, type Queryable } from "@neon-blocks/core";
import { toVectorLiteral, type EmbeddingProvider } from "@neon-blocks/ai";
import {
  buildCandidateSql,
  buildRowText,
  contentHash,
  diffRows,
  nextWatermark,
  type Candidate,
  type FreshnessSource,
} from "./freshness.js";

export interface ScanResult {
  source: string;
  examined: number;
  queued: number;
  embedded: number;
  failed: number;
}

/**
 * Detect changed rows for one source, record them in `pending`, and advance the watermark to the
 * highest row examined. Sources with no `updated_column` are outbox-driven only and skipped here.
 */
export async function detectChanges(
  db: Queryable,
  source: FreshnessSource,
  opts: { batchSize: number },
): Promise<{ examined: number; queued: number }> {
  if (!source.updated_column) return { examined: 0, queued: 0 };

  const { rows } = await db.query<Record<string, unknown> & { row_key: unknown; updated_at: string | Date }>(
    buildCandidateSql(source),
    [source.watermark, opts.batchSize],
  );
  if (rows.length === 0) return { examined: 0, queued: 0 };

  const candidates: Candidate[] = rows.map((r) => ({
    rowKey: String(r.row_key),
    contentHash: contentHash(buildRowText(r, source.text_columns)),
  }));

  const { rows: stateRows } = await db.query<{ row_key: string; content_hash: string }>(
    `SELECT row_key, content_hash
     FROM blocks_embedding_freshness.embedded_state
     WHERE source_code = $1 AND row_key = ANY($2)`,
    [source.code, candidates.map((c) => c.rowKey)],
  );
  const embeddedByKey = new Map(stateRows.map((s) => [String(s.row_key), String(s.content_hash)]));
  const { toReembed } = diffRows(candidates, embeddedByKey);

  for (const c of toReembed) {
    await db.query(
      `INSERT INTO blocks_embedding_freshness.pending (source_code, row_key, reason)
       VALUES ($1, $2, 'content changed')
       ON CONFLICT (source_code, row_key)
       DO UPDATE SET reason = EXCLUDED.reason, detected_at = now()`,
      [source.code, c.rowKey],
    );
  }

  // Advance to the highest row examined — never now() — so a row modified during the scan is caught
  // next time rather than skipped forever.
  const watermark = nextWatermark(
    rows.map((r) => r.updated_at),
    source.watermark,
  );
  await db.query(`UPDATE blocks_embedding_freshness.sources SET watermark = $2 WHERE code = $1`, [
    source.code,
    watermark,
  ]);

  return { examined: rows.length, queued: toReembed.length };
}

/**
 * Embed a bounded batch of pending rows and write their vectors. This is the thin untestable
 * boundary: it re-reads current text, calls the provider, and updates the vector column and
 * embedded_state, clearing pending as it goes.
 */
export async function processPending(
  db: Queryable,
  source: FreshnessSource,
  opts: { batchSize: number; embeddings: EmbeddingProvider; model: string },
): Promise<{ embedded: number; failed: number }> {
  const { rows: pend } = await db.query<{ row_key: string }>(
    `SELECT row_key FROM blocks_embedding_freshness.pending
     WHERE source_code = $1 ORDER BY detected_at LIMIT $2`,
    [source.code, opts.batchSize],
  );
  if (pend.length === 0) return { embedded: 0, failed: 0 };

  const table = `${quoteIdent(source.source_schema)}.${quoteIdent(source.source_table)}`;
  const keyCol = quoteIdent(source.key_column);
  const cols = source.text_columns.map((c) => quoteIdent(c)).join(", ");
  const { rows: current } = await db.query<Record<string, unknown> & { row_key: unknown }>(
    `SELECT ${keyCol} AS row_key, ${cols} FROM ${table} WHERE ${keyCol} = ANY($1)`,
    [pend.map((p) => String(p.row_key))],
  );

  const texts = current.map((r) => buildRowText(r, source.text_columns));
  const { vectors } = await opts.embeddings.embed(texts);

  const vtable = `${quoteIdent(source.vector_schema)}.${quoteIdent(source.vector_table)}`;
  const vcol = quoteIdent(source.vector_column);

  let embedded = 0;
  for (let i = 0; i < current.length; i++) {
    const rowKey = String(current[i]?.row_key);
    const vec = vectors[i];
    const text = texts[i];
    if (!vec || text === undefined) continue;

    await db.query(`UPDATE ${vtable} SET ${vcol} = $2::vector WHERE ${keyCol} = $1`, [
      rowKey,
      toVectorLiteral(vec),
    ]);
    await db.query(
      `INSERT INTO blocks_embedding_freshness.embedded_state (source_code, row_key, content_hash, model)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (source_code, row_key)
       DO UPDATE SET content_hash = EXCLUDED.content_hash, model = EXCLUDED.model, embedded_at = now()`,
      [source.code, rowKey, contentHash(text), opts.model],
    );
    await db.query(
      `DELETE FROM blocks_embedding_freshness.pending WHERE source_code = $1 AND row_key = $2`,
      [source.code, rowKey],
    );
    embedded++;
  }

  return { embedded, failed: pend.length - embedded };
}
