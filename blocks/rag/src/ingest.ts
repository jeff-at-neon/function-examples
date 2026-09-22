/**
 * The ingestion pipeline.
 *
 * upload → HEAD-verify → extract → chunk → embed → upsert
 *
 * Status transitions are persisted at each step so a function that dies mid-pipeline leaves a
 * document in a state the reconciler can recognise and retry, rather than in limbo.
 */

import { createHash } from "node:crypto";
import { createLogger, type Logger, type Queryable } from "@neon-blocks/core";
import { chunkText, toVectorLiteral, type EmbeddingProvider } from "@neon-blocks/ai";
import { ObjectNotFoundError, type StorageClient } from "@neon-blocks/storage";
import { extractText } from "./extract.js";

export interface IngestOptions {
  bucket: string;
  objectKey: string;
  storage: StorageClient;
  embeddings: EmbeddingProvider;
  maxBytes: number;
  chunkChars: number;
  chunkOverlap: number;
  logger?: Logger;
}

export type IngestResult =
  | { status: "ready"; documentId: string; chunks: number; reused: boolean }
  | { status: "skipped"; documentId: string; reason: string }
  | { status: "failed"; documentId: string | null; reason: string };

/**
 * Ingest one object.
 *
 * Begins with HEAD-verify, which is the security boundary: trigger delivery is an
 * unauthenticated POST, so a forged event naming a nonexistent object must die here rather than
 * deeper in the pipeline where a half-written document row is the outcome.
 */
export async function ingestObject(db: Queryable, opts: IngestOptions): Promise<IngestResult> {
  const log = opts.logger ?? createLogger({ block: "rag", op: "ingest" });

  let metadata;
  try {
    metadata = await opts.storage.headVerified(opts.bucket, opts.objectKey);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      // Either a forged trigger, or the object was deleted between upload and delivery. Not an
      // error worth retrying — and importantly, nothing is written.
      log.warn("ignoring event for nonexistent object", {
        bucket: opts.bucket,
        objectKey: opts.objectKey,
      });
      return { status: "failed", documentId: null, reason: "object does not exist" };
    }
    throw err;
  }

  if (metadata.size > opts.maxBytes) {
    const documentId = await upsertDocument(db, {
      bucket: opts.bucket,
      objectKey: opts.objectKey,
      etag: metadata.etag,
      contentType: metadata.contentType,
      sizeBytes: metadata.size,
      status: "skipped",
      error: `object is ${metadata.size} bytes, over the ${opts.maxBytes} byte limit`,
    });
    log.capped("document too large to ingest", {
      objectKey: opts.objectKey,
      size: metadata.size,
      maxBytes: opts.maxBytes,
    });
    return { status: "skipped", documentId, reason: "over size limit" };
  }

  // Identity is (bucket, key, etag). An unchanged re-delivery lands on the same row; an
  // overwrite creates a new one, which is what keeps embeddings from going stale.
  const existing = await findReadyDocument(db, opts.bucket, opts.objectKey, metadata.etag);
  if (existing) {
    log.info("object already ingested at this etag; nothing to do", {
      objectKey: opts.objectKey,
      documentId: existing,
    });
    return { status: "ready", documentId: existing, chunks: 0, reused: true };
  }

  const documentId = await upsertDocument(db, {
    bucket: opts.bucket,
    objectKey: opts.objectKey,
    etag: metadata.etag,
    contentType: metadata.contentType,
    sizeBytes: metadata.size,
    status: "extracting",
  });

  try {
    const { body } = await opts.storage.getObject(opts.bucket, opts.objectKey, {
      maxBytes: opts.maxBytes,
    });

    const extracted = extractText({
      key: opts.objectKey,
      contentType: metadata.contentType,
      body,
    });

    if (extracted.status !== "extracted") {
      const reason =
        extracted.status === "needsParser"
          ? `${extracted.parser} parser not wired: ${extracted.reason}`
          : extracted.reason;
      await setStatus(db, documentId, "skipped", { kind: extracted.kind, error: reason });
      log.info("document skipped", { objectKey: opts.objectKey, kind: extracted.kind, reason });
      return { status: "skipped", documentId, reason };
    }

    // Content-addressed reuse: if identical text was already embedded under a different key,
    // copy the vectors instead of paying to recompute them.
    const contentHash = createHash("sha256").update(extracted.text).digest("hex");
    const copied = await copyChunksFromTwin(db, documentId, contentHash, opts.embeddings.model);
    if (copied > 0) {
      await setStatus(db, documentId, "ready", {
        kind: extracted.kind,
        chunkCount: copied,
        contentHash,
        embeddingModel: opts.embeddings.model,
      });
      log.info("reused embeddings from identical content", {
        objectKey: opts.objectKey,
        chunks: copied,
      });
      return { status: "ready", documentId, chunks: copied, reused: true };
    }

    const chunks = chunkText(extracted.text, {
      maxChars: opts.chunkChars,
      overlapChars: opts.chunkOverlap,
    });

    if (chunks.length === 0) {
      await setStatus(db, documentId, "skipped", {
        kind: extracted.kind,
        error: "text produced no chunks",
      });
      return { status: "skipped", documentId, reason: "no chunks produced" };
    }

    await setStatus(db, documentId, "embedding", { kind: extracted.kind, contentHash });

    // The provider batches internally to its own limit; we hand it everything.
    const embedded = await opts.embeddings.embed(chunks.map((c) => c.text));

    await replaceChunks(db, documentId, chunks, embedded.vectors);
    await setStatus(db, documentId, "ready", {
      kind: extracted.kind,
      chunkCount: chunks.length,
      contentHash,
      embeddingModel: embedded.model,
      tokenEstimate: embedded.totalTokens ?? null,
    });

    log.info("document ingested", {
      objectKey: opts.objectKey,
      documentId,
      chunks: chunks.length,
      model: embedded.model,
    });

    return { status: "ready", documentId, chunks: chunks.length, reused: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Persist the failure so the document is visible in v_status rather than silently absent,
    // then rethrow so the queue's retry logic applies.
    await setStatus(db, documentId, "failed", { error: message });
    throw err;
  }
}

interface UpsertInput {
  bucket: string;
  objectKey: string;
  etag: string;
  contentType: string;
  sizeBytes: number;
  status: string;
  error?: string;
}

async function upsertDocument(db: Queryable, input: UpsertInput): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO blocks_rag.documents
       (bucket_name, object_key, etag, content_type, size_bytes, status, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (bucket_name, object_key, etag) DO UPDATE
       SET status = EXCLUDED.status,
           error = EXCLUDED.error,
           deleted_at = NULL
     RETURNING id`,
    [
      input.bucket,
      input.objectKey,
      input.etag,
      input.contentType,
      input.sizeBytes,
      input.status,
      input.error ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("Failed to upsert document row");
  return id;
}

async function findReadyDocument(
  db: Queryable,
  bucket: string,
  objectKey: string,
  etag: string,
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM blocks_rag.documents
     WHERE bucket_name = $1 AND object_key = $2 AND etag = $3
       AND status = 'ready' AND deleted_at IS NULL`,
    [bucket, objectKey, etag],
  );
  return rows[0]?.id ?? null;
}

/**
 * Copy chunks from an already-embedded document with identical content.
 *
 * Guarded on embedding model: copying vectors produced by a different model would put mutually
 * incomparable vectors in one index, which degrades search quietly rather than erroring.
 */
async function copyChunksFromTwin(
  db: Queryable,
  documentId: string,
  contentHash: string,
  model: string,
): Promise<number> {
  const { rowCount } = await db.query(
    `INSERT INTO blocks_rag.chunks
       (document_id, chunk_index, content, start_offset, end_offset, embedding, token_estimate)
     SELECT $1, c.chunk_index, c.content, c.start_offset, c.end_offset, c.embedding, c.token_estimate
     FROM blocks_rag.chunks c
     JOIN blocks_rag.documents d ON d.id = c.document_id
     WHERE d.content_hash = $2
       AND d.embedding_model = $3
       AND d.status = 'ready'
       AND d.id <> $1
       AND c.embedding IS NOT NULL
     ORDER BY c.chunk_index
     ON CONFLICT (document_id, chunk_index) DO NOTHING`,
    [documentId, contentHash, model],
  );
  return rowCount ?? 0;
}

/**
 * Replace a document's chunks wholesale.
 *
 * Delete-then-insert rather than upsert: a re-chunk with different boundaries produces a
 * different number of chunks, and leftover rows from the previous run would be retrievable
 * orphans pointing at text that no longer exists.
 */
async function replaceChunks(
  db: Queryable,
  documentId: string,
  chunks: readonly { text: string; index: number; startOffset: number; endOffset: number }[],
  vectors: readonly number[][],
): Promise<void> {
  if (chunks.length !== vectors.length) {
    throw new Error(
      `Chunk/vector count mismatch: ${chunks.length} chunks but ${vectors.length} vectors`,
    );
  }

  await db.query(`DELETE FROM blocks_rag.chunks WHERE document_id = $1`, [documentId]);

  // Single multi-row INSERT rather than a loop: one round trip instead of N, which matters when
  // a large document produces hundreds of chunks and the function is billed for the wait.
  const values: unknown[] = [documentId];
  const tuples: string[] = [];
  for (const [i, chunk] of chunks.entries()) {
    const base = values.length;
    values.push(
      chunk.index,
      chunk.text,
      chunk.startOffset,
      chunk.endOffset,
      toVectorLiteral(vectors[i]!),
      Math.ceil(chunk.text.length / 4),
    );
    tuples.push(
      `($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::vector, $${base + 6})`,
    );
  }

  await db.query(
    `INSERT INTO blocks_rag.chunks
       (document_id, chunk_index, content, start_offset, end_offset, embedding, token_estimate)
     VALUES ${tuples.join(", ")}`,
    values,
  );
}

async function setStatus(
  db: Queryable,
  documentId: string,
  status: string,
  fields: {
    kind?: string;
    chunkCount?: number;
    contentHash?: string;
    embeddingModel?: string;
    tokenEstimate?: number | null;
    error?: string;
  } = {},
): Promise<void> {
  await db.query(
    `UPDATE blocks_rag.documents
     SET status = $2,
         kind = COALESCE($3, kind),
         chunk_count = COALESCE($4, chunk_count),
         content_hash = COALESCE($5, content_hash),
         embedding_model = COALESCE($6, embedding_model),
         token_estimate = COALESCE($7, token_estimate),
         error = $8,
         ingested_at = CASE WHEN $2 = 'ready' THEN now() ELSE ingested_at END
     WHERE id = $1`,
    [
      documentId,
      status,
      fields.kind ?? null,
      fields.chunkCount ?? null,
      fields.contentHash ?? null,
      fields.embeddingModel ?? null,
      fields.tokenEstimate ?? null,
      fields.error ?? null,
    ],
  );
}
