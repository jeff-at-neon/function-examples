/**
 * Block 19 — Audio and Video Transcription.
 *
 * Whisper-class transcription with timestamps, feeding the same search index as documents.
 *
 * Makes spoken content searchable, which is the point: a two-hour meeting recording is unusable until you can find the thirty seconds that matter. It writes into the same chunk table the RAG block owns, so hybrid search covers audio and documents with one query rather than two.
 *
 * Routes:
 *   POST   /transcribe            Storage trigger. Transcribe one file.
 *   POST   /reconcile             Cron. Retries and missed deliveries.
 *   GET    /search                Search spoken content, returning timestamps.
 *   GET    /transcripts/:id       A transcript with its segments.
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
  NotFoundError,
  parseTriggerEvent,
  problem,
  Router,
  ValidationError,
  type Logger,
} from "@neon-blocks/core";
import { StorageClient, detectKind, ObjectNotFoundError } from "@neon-blocks/storage";

const log: Logger = createLogger({ block: "transcription" });

const SPEC = {
  block: "transcription",
  required: ["TRANSCRIBE_BUCKET"],
  optional: {
    TRANSCRIBE_PREFIX: "media/",
    TRANSCRIBE_MODEL: "whisper-1",
    TRANSCRIBE_MAX_BYTES: "26214400",
    TRANSCRIBE_INDEX_CHUNKS: "true",
  },
} as const;

function config() {
  return loadConfig(SPEC);
}

const router = new Router();

router.post("/transcribe", async (request) => {
  assertTriggerAuthentic(request, { requireSecret: false });
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "storage_object_created") {
    return problem(400, "wrong_trigger", `/transcribe expects a storage trigger, got ${event.type}`);
  }

  const cfg = config();
  if (event.bucketName !== cfg.get("TRANSCRIBE_BUCKET")) {
    return problem(403, "wrong_bucket", "This function only transcribes its configured bucket");
  }

  const storage = StorageClient.fromEnv();
  const kind = detectKind({ key: event.objectKey });

  if (kind !== "audio" && kind !== "video") {
    return json({ ok: true, status: "skipped", reason: `${kind} is not media` });
  }

  let metadata;
  try {
    metadata = await storage.headVerified(event.bucketName, event.objectKey);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      return json({ ok: true, status: "skipped", reason: "object does not exist" });
    }
    throw err;
  }

  const maxBytes = cfg.int("TRANSCRIBE_MAX_BYTES", { min: 1024 });
  if (metadata.size > maxBytes) {
    // Recorded as too_long rather than failed: the remedy is to split the file, which is different
    // from retrying.
    await getPool().query(
      `INSERT INTO blocks_transcription.transcripts
         (bucket_name, object_key, etag, kind, status, error)
       VALUES ($1, $2, $3, $4, 'too_long', $5)
       ON CONFLICT (bucket_name, object_key, etag) DO UPDATE
         SET status = 'too_long', error = EXCLUDED.error`,
      [event.bucketName, event.objectKey, metadata.etag, kind,
       `file is ${metadata.size} bytes, over the ${maxBytes} limit; split it and re-upload`],
    );
    log.capped("media too large to transcribe", { size: metadata.size, maxBytes });
    return json({ ok: true, status: "too_long", reason: "over size limit" });
  }

  // TODO(transcription): the provider call.
  //   * decide URL-based versus multipart submission. This choice determines whether media bytes
  //     flow through the function at all, which dominates both cost and latency -- prefer a
  //     presigned URL the provider fetches itself.
  //   * request timestamped segments, not just text: a transcript you cannot navigate is barely
  //     better than nothing for long recordings
  //   * insert segments, set full_text, language, duration_seconds
  //   * when TRANSCRIBE_INDEX_CHUNKS is true, also write chunks into blocks_rag.chunks so hybrid
  //     search covers spoken content in the same query as documents (this is why the block declares
  //     dependsOn: rag)
  //
  //   Do NOT transcode. It is the most CPU-expensive thing possible here, functions run at a fixed
  //   size, and a format the provider rejects should be rejected here too.
  return problem(
    501,
    "not_implemented",
    "Transcription is not yet wired. See the TODO in src/index.ts -- note that media should be " +
      "fetched by the provider from a presigned URL rather than streamed through the function.",
  );
});

router.post("/reconcile", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", `/reconcile expects a schedule trigger, got ${event.type}`);
  }

  // Two hours rather than one: transcription is genuinely slow, so a shorter window would reset
  // work that is still legitimately in progress.
  const { rowCount } = await getPool().query(
    `UPDATE blocks_transcription.transcripts
     SET status = 'pending', error = 'reset by reconciler: stuck in ' || status
     WHERE status IN ('pending', 'transcribing') AND updated_at < now() - interval '2 hours'`,
  );

  return json({ ok: true, scheduledAt: event.scheduledAt, stuckReset: rowCount ?? 0 });
});

router.get("/search", async (_request, ctx) => {
  const query = ctx.url.searchParams.get("q");
  if (!query) throw new ValidationError("?q= is required");
  const limit = Math.min(Number(ctx.url.searchParams.get("limit") ?? "25"), 200);

  // Returns timestamps, which is the whole point: a hit lets the caller jump to the moment rather
  // than to the file.
  const { rows } = await getPool().query(
    `SELECT t.object_key, s.start_seconds, s.end_seconds, s.text,
            ts_rank_cd(s.text_tsv, websearch_to_tsquery('english', $1)) AS rank
     FROM blocks_transcription.segments s
     JOIN blocks_transcription.transcripts t ON t.id = s.transcript_id
     WHERE s.text_tsv @@ websearch_to_tsquery('english', $1)
       AND t.status = 'ready'
     ORDER BY rank DESC
     LIMIT $2`,
    [query, limit],
  );

  return json({ query, count: rows.length, hits: rows });
});

router.get("/transcripts/:id", async (_request, ctx) => {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM blocks_transcription.transcripts WHERE id = $1`,
    [ctx.params["id"]],
  );
  if (rows.length === 0) throw new NotFoundError("No such transcript");

  const { rows: segments } = await pool.query(
    `SELECT segment_index, start_seconds, end_seconds, text
     FROM blocks_transcription.segments WHERE transcript_id = $1
     ORDER BY segment_index`,
    [ctx.params["id"]],
  );

  return json({ transcript: rows[0], segments });
});

router.get("/health", async () => {
  const report = await checkHealth(getPool(), {
    block: "transcription",
    schema: "blocks_transcription",
    evaluate: (status) => {
      const problems: string[] = [];

      const stuck = Number(status["transcripts_stuck"] ?? 0);
      const failed = Number(status["transcripts_failed"] ?? 0);
      const noSegments = Number(status["ready_without_segments"] ?? 0);

      if (stuck > 0) problems.push(`${stuck} transcript(s) stuck for over two hours`);
      if (failed > 0) problems.push(`${failed} transcription(s) failed`);
      if (noSegments > 0) {
        problems.push(
          `${noSegments} ready transcript(s) have no segments, so they cannot be navigated by ` +
            `timestamp -- which is most of the value for long recordings`,
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
