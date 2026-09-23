/**
 * Block 14 — Embedding Freshness Worker.
 *
 * Re-embeds rows whose source text changed, driven by a watermark or the outbox. Fixes pgvector's most common failure mode.
 *
 * Stale vectors are pgvector's number one failure mode: text is edited, the embedding is not regenerated, and search silently returns the old meaning. Nothing errors, so nobody notices until a user reports that search is 'wrong'. This is also the block that row-event triggers would most improve — see docs/ROW_EVENTS.md, where it moves from rank 14 to about 6.
 *
 * Routes:
 *   POST   /sources               Register a table whose text should stay embedded.
 *   POST   /scan                  Cron. Detect changed rows and queue re-embeds.
 *   GET    /pending               Rows currently known to be stale.
 */

import {
  assertTriggerAuthentic,
  checkHealth,
  createLogger,
  getPool,
  json,
  parseTriggerRequest,
  problem,
  Router,
  ValidationError,
  type Logger,
} from "@neon-blocks/core";
import { autoMigrate } from "@neon-blocks/migrate";
import { quoteIdent } from "@neon-blocks/core";
import { defaultEmbeddings } from "@neon-blocks/ai";
import { loadFreshnessConfig } from "./config.js";
import { detectChanges, processPending } from "./scan.js";
import type { FreshnessSource } from "./freshness.js";

const log: Logger = createLogger({ block: "embedding-freshness" });

const router = new Router();

router.post("/sources", async (request) => {
  const body = await readJsonObject(request);

  const textColumns = Array.isArray(body["textColumns"])
    ? (body["textColumns"] as unknown[]).filter((c): c is string => typeof c === "string")
    : [];
  if (textColumns.length === 0) {
    throw new ValidationError('"textColumns" must be a non-empty array of column names');
  }

  // Identifiers come from the caller and end up in generated SQL, so validate every one now rather
  // than interpolating them later.
  for (const identifier of [
    requireString(body, "sourceSchema"),
    requireString(body, "sourceTable"),
    ...textColumns,
  ]) {
    quoteIdent(identifier);
  }

  await getPool().query(
    `INSERT INTO blocks_embedding_freshness.sources
       (code, source_schema, source_table, key_column, text_columns, updated_column,
        vector_schema, vector_table, vector_column)
     VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9)
     ON CONFLICT (code) DO UPDATE
       SET text_columns = EXCLUDED.text_columns, updated_column = EXCLUDED.updated_column`,
    [
      requireString(body, "code"),
      requireString(body, "sourceSchema"),
      requireString(body, "sourceTable"),
      typeof body["keyColumn"] === "string" ? body["keyColumn"] : "id",
      textColumns,
      typeof body["updatedColumn"] === "string" ? body["updatedColumn"] : null,
      typeof body["vectorSchema"] === "string" ? body["vectorSchema"] : requireString(body, "sourceSchema"),
      typeof body["vectorTable"] === "string" ? body["vectorTable"] : requireString(body, "sourceTable"),
      typeof body["vectorColumn"] === "string" ? body["vectorColumn"] : "embedding",
    ],
  );

  return json({ registered: body["code"] }, { status: 201 });
});

router.post("/scan", async (request) => {
  assertTriggerAuthentic(request);
  const event = await parseTriggerRequest(request);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", `/scan expects a schedule trigger, got ${event.type}`);
  }

  const pool = getPool();
  const cfg = loadFreshnessConfig();
  const { rows: sources } = await pool.query<FreshnessSource>(
    `SELECT code, source_schema, source_table, key_column, text_columns, updated_column,
            vector_schema, vector_table, vector_column, watermark
     FROM blocks_embedding_freshness.sources
     WHERE is_active AND updated_column IS NOT NULL`,
  );

  // Watermark-driven scan. Outbox-driven sources (updated_column IS NULL) are handled by the event
  // consumer, not here. Detection + watermark advance is pure (freshness.ts); the embed is the only
  // part that touches the model.
  const embeddings = defaultEmbeddings({ model: cfg.model, dimensions: cfg.dimensions });
  const results = [];
  for (const source of sources) {
    const detected = await detectChanges(pool, source, { batchSize: cfg.batchSize });
    const processed = await processPending(pool, source, {
      batchSize: cfg.batchSize,
      embeddings,
      model: cfg.model,
    });
    results.push({ source: source.code, ...detected, ...processed });
  }

  return json({ ok: true, scheduledAt: event.scheduledAt, sources: results });
});

router.get("/pending", async (_request, ctx) => {
  const limit = Math.min(Number(ctx.url.searchParams.get("limit") ?? "100"), 1000);
  const { rows } = await getPool().query(
    `SELECT source_code, row_key, reason, detected_at, attempts, last_error
     FROM blocks_embedding_freshness.pending
     ORDER BY detected_at
     LIMIT $1`,
    [limit],
  );
  return json({ count: rows.length, pending: rows });
});

router.get("/health", async () => {
  const report = await checkHealth(getPool(), {
    block: "embedding-freshness",
    schema: "blocks_embedding_freshness",
    evaluate: (status) => {
      const problems: string[] = [];

      const stale = Number(status["rows_stale_over_hour"] ?? 0);
      const failing = Number(status["rows_failing"] ?? 0);
      const models = Number(status["models_in_use"] ?? 0);
      const sources = Number(status["sources_active"] ?? 0);

      if (sources === 0) problems.push("no active sources registered; nothing is being kept fresh");
      if (stale > 0) {
        // These vectors are wrong right now, and search is silently returning old meanings.
        problems.push(
          `${stale} row(s) have been pending re-embedding for over an hour; their vectors are ` +
            `stale and search is returning outdated meanings with no error`,
        );
      }
      if (failing > 0) problems.push(`${failing} row(s) have failed re-embedding three or more times`);
      if (models > 1) {
        problems.push(
          `${models} embedding models are in use; vectors are not mutually comparable and ` +
            `retrieval quality is silently degraded`,
        );
      }
      return problems;
    },
  });

  return json(report, { status: report.status === "ok" ? 200 : 503 });
});

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new ValidationError("Request body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value === "") {
    throw new ValidationError(`"${key}" is required and must be a non-empty string`);
  }
  return value;
}

export default autoMigrate({
  block: "embedding-freshness",
  migrationsUrl: new URL("./migrations/", import.meta.url),
  fetch: (request: Request): Promise<Response> => router.handle(request),
});

// Re-exported so unit tests can import the pure logic directly.
export { loadFreshnessConfig, SPEC } from "./config.js";
export {
  buildRowText,
  contentHash,
  nextWatermark,
  diffRows,
  buildCandidateSql,
} from "./freshness.js";
