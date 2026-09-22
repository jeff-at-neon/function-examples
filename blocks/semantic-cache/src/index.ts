/**
 * Block 20 — Semantic Cache for LLM Calls.
 *
 * Caches model responses by embedding similarity, so a rephrased question reuses an existing answer.
 *
 * Cuts AI spend on repeated questions. An exact-match cache misses almost everything, because nobody asks the same question the same way twice -- similarity matching is what makes a cache hit at all.
 *
 * Routes:
 *   POST   /lookup                Find a cached response for a prompt.
 *   POST   /store                 Cache a response.
 *   POST   /sweep                 Cron. Expire entries and report hit rate.
 *   GET    /stats                 Hit rate and tokens saved by namespace.
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
import { createHash } from "node:crypto";

const log: Logger = createLogger({ block: "semantic-cache" });

const SPEC = {
  block: "semantic-cache",
  optional: {
    CACHE_SIMILARITY_THRESHOLD: "0.95",
    CACHE_TTL_HOURS: "168",
    CACHE_EMBEDDING_MODEL: "text-embedding-3-small",
    CACHE_EMBEDDING_DIMENSIONS: "1536",
  },
} as const;

function config() {
  return loadConfig(SPEC);
}

const router = new Router();

router.post("/lookup", async (request) => {
  const body = await readJsonObject(request);
  const prompt = requireString(body, "prompt");
  const model = requireString(body, "model");
  const namespace = typeof body["namespace"] === "string" ? body["namespace"] : "default";

  const promptHash = createHash("sha256").update(`${namespace}:${model}:${prompt}`).digest("hex");
  const pool = getPool();

  // Exact-match fast path first: it skips the embedding call entirely, so a repeated identical
  // prompt costs one indexed lookup and nothing else.
  const { rows: exact } = await pool.query<{ id: string; response: string; model: string }>(
    `UPDATE blocks_semantic_cache.entries
     SET hit_count = hit_count + 1, last_hit_at = now()
     WHERE namespace = $1 AND prompt_hash = $2 AND model = $3 AND expires_at > now()
     RETURNING id, response, model`,
    [namespace, promptHash, model],
  );

  if (exact[0]) {
    await recordStat(pool, namespace, "hit", 0);
    return json({ hit: true, kind: "exact", response: exact[0].response, model: exact[0].model });
  }

  // TODO(semantic-cache): the similarity path.
  //   1. embed the prompt with CACHE_EMBEDDING_MODEL
  //   2. SELECT ... ORDER BY prompt_embedding <=> $1 LIMIT 1, scoped to namespace AND model --
  //      scoping is not optional: crossing namespaces is a cross-tenant leak, and crossing models
  //      serves a weaker model's answer as a stronger one's
  //   3. accept only when 1 - distance >= CACHE_SIMILARITY_THRESHOLD. Strict by default: a loose
  //      threshold returns an answer to a DIFFERENT question, which is worse than a miss because it
  //      is silently wrong.
  //   4. on a hit, increment hit_count and record tokens_saved from the stored counts
  //
  //   Known limitation no threshold fixes: negation. "delete my account" and "do not delete my
  //   account" embed very closely and require opposite answers.
  await recordStat(pool, namespace, "miss", 0);
  return json({
    hit: false,
    note:
      "Exact-match lookup ran and missed. Similarity matching is not yet wired -- see the TODO in " +
      "src/index.ts.",
  });
});

router.post("/store", async (request) => {
  const body = await readJsonObject(request);
  const prompt = requireString(body, "prompt");
  const response = requireString(body, "response");
  const model = requireString(body, "model");
  const namespace = typeof body["namespace"] === "string" ? body["namespace"] : "default";

  const cfg = config();
  const ttlHours = cfg.int("CACHE_TTL_HOURS", { min: 1, max: 8_760 });
  const promptHash = createHash("sha256").update(`${namespace}:${model}:${prompt}`).digest("hex");

  // Stored without an embedding for now, so the exact-match path works immediately. The similarity
  // path needs the embedding, which is part of the TODO above -- v_status surfaces unembedded
  // entries so this gap is visible rather than silent.
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO blocks_semantic_cache.entries
       (namespace, prompt, prompt_hash, response, model, prompt_tokens, completion_tokens, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(hours => $8::int))
     ON CONFLICT (namespace, prompt_hash, model) DO UPDATE
       SET response = EXCLUDED.response,
           expires_at = EXCLUDED.expires_at
     RETURNING id`,
    [
      namespace, prompt, promptHash, response, model,
      typeof body["promptTokens"] === "number" ? body["promptTokens"] : null,
      typeof body["completionTokens"] === "number" ? body["completionTokens"] : null,
      ttlHours,
    ],
  );

  return json({ id: rows[0]?.id, embedded: false }, { status: 201 });
});

router.post("/sweep", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", `/sweep expects a schedule trigger, got ${event.type}`);
  }

  // Complete and worth running on its own: without it the table grows without bound and every
  // similarity search gets slower.
  const { rowCount } = await getPool().query(
    `DELETE FROM blocks_semantic_cache.entries WHERE expires_at <= now()`,
  );

  return json({ ok: true, scheduledAt: event.scheduledAt, expired: rowCount ?? 0 });
});

router.get("/stats", async (_request, ctx) => {
  const namespace = ctx.url.searchParams.get("namespace");
  const { rows } = await getPool().query(
    `SELECT namespace, day, hits, misses, tokens_saved,
            round(100.0 * hits / GREATEST(hits + misses, 1), 1) AS hit_rate_pct
     FROM blocks_semantic_cache.stats
     WHERE ($1::text IS NULL OR namespace = $1)
     ORDER BY day DESC, namespace
     LIMIT 90`,
    [namespace],
  );
  return json({ stats: rows });
});

/**
 * Record a hit or miss.
 *
 * Aggregated per day rather than one row per lookup: this block exists to save money, and adding
 * write volume to the path meant to be cheap would undercut it.
 */
async function recordStat(
  db: { query: (sql: string, params?: readonly unknown[]) => Promise<unknown> },
  namespace: string,
  kind: "hit" | "miss",
  tokensSaved: number,
): Promise<void> {
  await db.query(
    `INSERT INTO blocks_semantic_cache.stats (namespace, day, hits, misses, tokens_saved)
     VALUES ($1, CURRENT_DATE, $2, $3, $4)
     ON CONFLICT (namespace, day) DO UPDATE
       SET hits = blocks_semantic_cache.stats.hits + EXCLUDED.hits,
           misses = blocks_semantic_cache.stats.misses + EXCLUDED.misses,
           tokens_saved = blocks_semantic_cache.stats.tokens_saved + EXCLUDED.tokens_saved`,
    [namespace, kind === "hit" ? 1 : 0, kind === "miss" ? 1 : 0, tokensSaved],
  );
}

router.get("/health", async () => {
  const report = await checkHealth(getPool(), {
    block: "semantic-cache",
    schema: "blocks_semantic_cache",
    evaluate: (status) => {
      const problems: string[] = [];

      const expired = Number(status["entries_expired"] ?? 0);
      const unembedded = Number(status["entries_unembedded"] ?? 0);
      const live = Number(status["entries_live"] ?? 0);

      if (expired > 1_000) {
        problems.push(
          `${expired} expired entry/entries not yet swept; the /sweep trigger may be disabled`,
        );
      }
      if (unembedded > 0 && live > 0) {
        problems.push(
          `${unembedded} entry/entries have no embedding and can only be matched exactly, not by ` +
            `similarity -- which is most of the value`,
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
