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
 *
 * STATUS: scaffold. The schema, safety checks, and control flow are real; the marked TODO seams are
 * the remaining work. Endpoints that are not implemented return 501 with a specific explanation
 * rather than failing in a way that looks like a bug.
 */

import {
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
import { quoteIdent } from "@neon-blocks/core";

const log: Logger = createLogger({ block: "embedding-freshness" });

const SPEC = {
  block: "embedding-freshness",
  optional: {
    FRESHNESS_BATCH_SIZE: "200",
    FRESHNESS_EMBEDDING_MODEL: "text-embedding-3-small",
    FRESHNESS_EMBEDDING_DIMENSIONS: "1536",
  },
} as const;

function config() {
  return loadConfig(SPEC);
}

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
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", `/scan expects a schedule trigger, got ${event.type}`);
  }

  const { rows: sources } = await getPool().query<{ code: string; updated_column: string | null }>(
    `SELECT code, updated_column FROM blocks_embedding_freshness.sources WHERE is_active`,
  );

  // TODO(embedding-freshness): the scan and re-embed pipeline.
  //   1. per source, SELECT rows where updated_column > watermark, limited to FRESHNESS_BATCH_SIZE
  //   2. concatenate text_columns and hash it; compare against embedded_state.content_hash. This
  //      step is what stops an unrelated column change from paying for a re-embed.
  //   3. INSERT differing rows into pending
  //   4. advance the watermark to the highest updated_column actually examined -- not to now(), or
  //      rows modified during the scan would be skipped forever
  //   5. embed pending rows in batches, UPDATE the vector column, upsert embedded_state
  // Outbox mode replaces steps 1-2: consume 'row.changed' events and diff old vs new, which is why
  // block 1's trigger carries both.
  void sources;

  return problem(
    501,
    "not_implemented",
    "The freshness scan is not yet wired. See the TODO in src/index.ts -- note step 4: the " +
      "watermark must advance to the highest row examined, not to now(), or rows modified during " +
      "the scan are skipped forever.",
  );
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

export default {
  fetch: (request: Request): Promise<Response> => router.handle(request),
};
