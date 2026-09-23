/**
 * Moderation orchestration: the impure edge that calls the classifier through the Neon AI Gateway,
 * records the decision, and — when blocked — moves the object under the quarantine prefix. Scoring
 * and the decision are the pure, tested logic in classify.ts.
 */

import type { Queryable } from "@neon-blocks/core";
import type { ChatProvider, ContentPart } from "@neon-blocks/ai";
import type { StorageClient } from "@neon-blocks/storage";
import {
  buildImagePrompt,
  buildTextPrompt,
  decide,
  extractScores,
  type Decision,
} from "./classify.js";
import type { ModerationConfig } from "./config.js";

async function persist(
  db: Queryable,
  itemId: string,
  scores: Record<string, number>,
  d: Decision,
  model: string,
): Promise<void> {
  await db.query(
    `UPDATE blocks_moderation.items
     SET status = $2, scores = $3::jsonb, flagged = $4::text[], model = $5,
         decided_at = now(), updated_at = now()
     WHERE id = $1`,
    [itemId, d.status, JSON.stringify(scores), d.flagged, model],
  );
  await db.query(
    `INSERT INTO blocks_moderation.decisions (item_id, decision, source, reason)
     VALUES ($1, $2, 'model', $3)`,
    [itemId, d.decision, d.flagged.length > 0 ? `flagged: ${d.flagged.join(", ")}` : null],
  );
}

/** Move a blocked object under the quarantine prefix (get → put → delete). Best-effort. */
export async function moveToQuarantine(
  storage: StorageClient,
  bucket: string,
  key: string,
  quarantinePrefix: string,
): Promise<string> {
  const base = key.split("/").pop() ?? key;
  const destKey = `${quarantinePrefix}${base}`;
  const { body, metadata } = await storage.getObject(bucket, key, { maxBytes: 50 * 1024 * 1024 });
  await storage.putObject(bucket, destKey, body, { contentType: metadata.contentType });
  await storage.deleteObject(bucket, key);
  return destKey;
}

export async function classifyImageItem(
  deps: { db: Queryable; storage: StorageClient; chat: ChatProvider },
  opts: { itemId: string; bucket: string; key: string; cfg: ModerationConfig },
): Promise<Decision> {
  const { db, storage, chat } = deps;
  const { cfg } = opts;
  const prompt = buildImagePrompt(cfg.thresholds);
  const url = storage.presignGet(opts.bucket, opts.key, { expiresInSeconds: 300 });
  const parts: ContentPart[] = [
    { type: "text", text: prompt.userText },
    { type: "image_url", imageUrl: { url, detail: "auto" } },
  ];
  const result = await chat.chat([
    { role: "system", content: prompt.system },
    { role: "user", content: parts },
  ]);
  const scores = extractScores(result.text);
  const decision = decide(scores, cfg.thresholds);
  await persist(db, opts.itemId, scores, decision, cfg.model);
  if (decision.status === "blocked") {
    await moveToQuarantine(storage, opts.bucket, opts.key, cfg.quarantinePrefix).catch(() => {});
  }
  return decision;
}

export async function classifyTextItem(
  deps: { db: Queryable; chat: ChatProvider },
  opts: { itemId: string; text: string; cfg: ModerationConfig },
): Promise<Decision> {
  const { db, chat } = deps;
  const { cfg } = opts;
  const prompt = buildTextPrompt(cfg.thresholds);
  const result = await chat.chat([
    { role: "system", content: prompt.system },
    { role: "user", content: `${prompt.userText}\n\n${opts.text}` },
  ]);
  const scores = extractScores(result.text);
  const decision = decide(scores, cfg.thresholds);
  await persist(db, opts.itemId, scores, decision, cfg.model);
  return decision;
}
