/**
 * Extraction orchestration: the impure edge that presigns the object, calls the vision model
 * through the Neon AI Gateway, and records results. Prompt building, tolerant parsing, and the
 * confidence split are the pure, tested logic in extract.ts.
 */

import type { Queryable } from "@neon-blocks/core";
import type { ChatProvider, ContentPart } from "@neon-blocks/ai";
import type { StorageClient } from "@neon-blocks/storage";
import {
  buildExtractionPrompt,
  extractJsonObject,
  schemaCodeFromKey,
  splitByConfidence,
  type SchemaFields,
} from "./extract.js";
import type { ExtractConfig } from "./config.js";

export interface ExtractEvent {
  bucketName: string;
  objectKey: string;
  etag: string;
}

export interface ExtractResult {
  status: "ready" | "needs_review" | "failed" | "skipped";
  reason?: string;
  reviewCount?: number;
}

export async function runExtraction(
  deps: { db: Queryable; storage: StorageClient; chat: ChatProvider },
  opts: { event: ExtractEvent; cfg: ExtractConfig },
): Promise<ExtractResult> {
  const { db, storage, chat } = deps;
  const { event, cfg } = opts;

  const schemaCode = schemaCodeFromKey(event.objectKey, cfg.prefix);
  if (!schemaCode) return { status: "skipped", reason: "no schema code in object key" };

  const { rows: schemas } = await db.query<{ fields: SchemaFields }>(
    `SELECT fields FROM blocks_doc_extraction.schemas WHERE code = $1`,
    [schemaCode],
  );
  const schema = schemas[0];
  if (!schema) return { status: "skipped", reason: `no schema "${schemaCode}"` };

  const { rows: created } = await db.query<{ id: string }>(
    `INSERT INTO blocks_doc_extraction.extractions (bucket_name, object_key, etag, schema_code, status)
     VALUES ($1, $2, $3, $4, 'extracting')
     ON CONFLICT (bucket_name, object_key, etag) DO NOTHING
     RETURNING id`,
    [event.bucketName, event.objectKey, event.etag, schemaCode],
  );
  const extractionId = created[0]?.id;
  if (!extractionId) return { status: "skipped", reason: "already extracted" };

  try {
    const prompt = buildExtractionPrompt(schema.fields);
    const url = storage.presignGet(event.bucketName, event.objectKey, { expiresInSeconds: 300 });
    const parts: ContentPart[] = [
      { type: "text", text: prompt.userText },
      { type: "image_url", imageUrl: { url, detail: "high" } },
    ];
    const result = await chat.chat([
      { role: "system", content: prompt.system },
      { role: "user", content: parts },
    ]);

    const parsed = extractJsonObject(result.text);
    if (!parsed) {
      await fail(db, extractionId, "model response was not parseable JSON");
      return { status: "failed", reason: "unparseable model response" };
    }

    const split = splitByConfidence(schema.fields, parsed, cfg.confidenceThreshold);
    await db.query(
      `UPDATE blocks_doc_extraction.extractions
       SET status = $2, extracted = $3::jsonb, confidence = $4::jsonb,
           model = $5, extracted_at = now(), updated_at = now()
       WHERE id = $1`,
      [extractionId, split.status, JSON.stringify(split.values), JSON.stringify(split.confidence), cfg.model],
    );
    for (const r of split.review) {
      await db.query(
        `INSERT INTO blocks_doc_extraction.review_queue (extraction_id, field_name, extracted_value, confidence)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (extraction_id, field_name) DO UPDATE
           SET extracted_value = EXCLUDED.extracted_value, confidence = EXCLUDED.confidence`,
        [extractionId, r.field, r.value === null ? null : String(r.value), r.confidence],
      );
    }
    return { status: split.status, reviewCount: split.review.length };
  } catch (err) {
    await fail(db, extractionId, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

async function fail(db: Queryable, id: string, error: string): Promise<void> {
  await db.query(
    `UPDATE blocks_doc_extraction.extractions SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`,
    [id, error],
  );
}
