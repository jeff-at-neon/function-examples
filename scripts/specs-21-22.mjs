import { INJECTED_DB, INJECTED_AI, TRIGGER_SECRET } from "./lib/generate.mjs";

/** @type {import("./lib/generate.mjs").BlockSpec[]} */
export const SPECS = [
  {
    slug: "agent-memory",
    rank: 21,
    name: "Agent Memory Store",
    summary:
      "Session transcripts, summarization compaction, and retrieval for LLM agents — so a long conversation stays inside the context window.",
    billing: "free",
    capabilities: ["postgres", "pgvector", "ai_gateway"],
    dependsOn: [],
    why:
      "Rides the agent wave, and Neon already pitches Functions for agent tool-loops. The real problem " +
      "is not storing messages — it is that a conversation outgrows the context window, and naive " +
      "truncation drops the beginning, which is usually where the task was defined. Compaction plus " +
      "retrieval is what keeps an agent coherent past a few dozen turns.",
    notes: [
      "**Compaction summarizes the oldest turns rather than dropping them.** Truncating the head of a conversation discards the original instruction, which is the one message you cannot afford to lose. Summaries are stored as first-class rows, so the record of what was compacted survives.",
      "**Retrieval is over embedded turns, not the whole transcript.** Pulling the semantically relevant three messages from turn 200 beats replaying the last fifty, and costs far fewer tokens.",
      "**Token counts are stored per message.** Deciding when to compact needs a running total, and recomputing it from text on every turn is both slow and approximate.",
      "**Sessions are namespaced by agent and owner.** Two agents sharing a memory store would cross-contaminate, and one tenant retrieving another's turns is a data leak, not a quirk.",
    ],
    limits: [
      "**Compaction and retrieval are TODO seams.** The schema, token accounting, and the compaction trigger condition are real; the summarize-and-embed calls are not written.",
      "**Token counts are caller-supplied or estimated at four characters per token.** That estimate is wrong for code and for non-Latin scripts, and a real tokenizer is the fix.",
      "**No automatic memory expiry.** A busy agent accumulates sessions indefinitely; TTL is declared per session but nothing enforces it yet.",
      "**Summaries are lossy by definition.** Compaction trades fidelity for context room, and a detail summarized away is gone — which is why the original turns are retained rather than deleted.",
    ],
    env: [
      INJECTED_DB,
      INJECTED_AI,
      {
        name: "MEMORY_COMPACT_AT_TOKENS",
        description:
          "Running token total at which the oldest turns are summarized. Should sit well below your model's window, leaving room for retrieval and the response.",
        required: false,
        default: "24000",
      },
      {
        name: "MEMORY_KEEP_RECENT_TURNS",
        description:
          "Turns always kept verbatim, never compacted. Recent exchanges carry the most relevant detail.",
        required: false,
        default: "10",
      },
      {
        name: "MEMORY_SUMMARY_MODEL",
        description: "Model used to summarize compacted turns.",
        required: false,
        default: "gpt-4o-mini",
      },
      {
        name: "MEMORY_EMBEDDING_MODEL",
        description: "Must stay consistent, or retrieval across a session is comparing incomparable vectors.",
        required: false,
        default: "text-embedding-3-small",
      },
      {
        name: "MEMORY_EMBEDDING_DIMENSIONS",
        description: "Must match the model and the vector column width.",
        required: false,
        default: "1536",
      },
      TRIGGER_SECRET,
    ],
    triggers: [
      {
        type: "schedule",
        cron: "*/10 * * * *",
        functionPath: "/compact",
        description:
          "Compact sessions that have crossed the token threshold. Scheduled rather than inline so a user-facing turn never waits on a summarization call.",
      },
    ],
    tables: `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS blocks_agent_memory.sessions (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Namespaced by agent and owner. Two agents sharing a store would cross-contaminate, and one
  -- tenant retrieving another's turns is a data leak rather than a quirk.
  agent_code    text        NOT NULL,
  owner_ref     text        NOT NULL,

  title         text,
  -- Running total, maintained on insert. Deciding when to compact needs this, and recomputing it
  -- from text every turn is both slow and approximate.
  total_tokens  integer     NOT NULL DEFAULT 0,
  turn_count    integer     NOT NULL DEFAULT 0,

  -- Set when compaction has run at least once, so the retrieval path knows summaries exist.
  compacted_through_turn integer NOT NULL DEFAULT 0,
  last_compacted_at timestamptz,

  status        text        NOT NULL DEFAULT 'active',
  expires_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sessions_status_valid CHECK (status IN ('active', 'archived'))
);

CREATE INDEX IF NOT EXISTS sessions_owner_idx
  ON blocks_agent_memory.sessions (agent_code, owner_ref, updated_at DESC);
-- Serves the compaction sweeper without scanning sessions that are comfortably small.
CREATE INDEX IF NOT EXISTS sessions_compact_idx
  ON blocks_agent_memory.sessions (total_tokens DESC) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS blocks_agent_memory.turns (
  id            bigserial   PRIMARY KEY,
  session_id    uuid        NOT NULL REFERENCES blocks_agent_memory.sessions(id) ON DELETE CASCADE,
  turn_index    integer     NOT NULL,

  role          text        NOT NULL,
  content       text        NOT NULL,
  token_count   integer     NOT NULL DEFAULT 0,

  -- Embedded for retrieval. Pulling the three relevant messages from turn 200 beats replaying the
  -- last fifty, and costs far fewer tokens.
  embedding     vector(1536),

  -- Retained after compaction rather than deleted: a summary is lossy, so the original is the only
  -- place a compacted-away detail still exists.
  is_compacted  boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT turns_order_uniq UNIQUE (session_id, turn_index),
  CONSTRAINT turns_role_valid CHECK (role IN ('system', 'user', 'assistant', 'tool'))
);

CREATE INDEX IF NOT EXISTS turns_session_idx ON blocks_agent_memory.turns (session_id, turn_index);
CREATE INDEX IF NOT EXISTS turns_embedding_idx
  ON blocks_agent_memory.turns USING hnsw (embedding vector_cosine_ops);

-- Summaries of compacted ranges. First-class rows rather than a mutated field, so the record of
-- what was compacted, and when, survives.
CREATE TABLE IF NOT EXISTS blocks_agent_memory.summaries (
  id            bigserial   PRIMARY KEY,
  session_id    uuid        NOT NULL REFERENCES blocks_agent_memory.sessions(id) ON DELETE CASCADE,
  from_turn     integer     NOT NULL,
  to_turn       integer     NOT NULL,
  summary       text        NOT NULL,
  token_count   integer     NOT NULL DEFAULT 0,
  model         text,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT summaries_range_sane CHECK (to_turn >= from_turn),
  CONSTRAINT summaries_range_uniq UNIQUE (session_id, from_turn, to_turn)
);

CREATE INDEX IF NOT EXISTS summaries_session_idx
  ON blocks_agent_memory.summaries (session_id, from_turn);`,
    statusView: `
  (SELECT count(*) FROM blocks_agent_memory.sessions WHERE status = 'active') AS sessions_active,
  (SELECT count(*) FROM blocks_agent_memory.sessions WHERE status = 'archived') AS sessions_archived,
  (SELECT count(*) FROM blocks_agent_memory.turns)                       AS turns_total,
  (SELECT count(*) FROM blocks_agent_memory.turns WHERE is_compacted)    AS turns_compacted,
  -- Turns with no vector cannot be retrieved semantically, only replayed in order.
  (SELECT count(*) FROM blocks_agent_memory.turns WHERE embedding IS NULL) AS turns_unembedded,
  (SELECT count(*) FROM blocks_agent_memory.summaries)                   AS summaries_total,

  -- Sessions over the threshold that have not been compacted. These are the ones about to overflow a
  -- context window, which is the failure this block exists to prevent.
  (SELECT count(*) FROM blocks_agent_memory.sessions
     WHERE status = 'active' AND total_tokens > 24000
       AND turn_count > compacted_through_turn)                          AS sessions_needing_compaction,
  (SELECT COALESCE(max(total_tokens), 0) FROM blocks_agent_memory.sessions
     WHERE status = 'active')                                            AS largest_session_tokens,
  (SELECT count(*) FROM blocks_agent_memory.sessions
     WHERE expires_at IS NOT NULL AND expires_at < now())                AS sessions_expired`,
    dropOrder: [
      "TABLE blocks_agent_memory.summaries",
      "TABLE blocks_agent_memory.turns",
      "TABLE blocks_agent_memory.sessions",
    ],
    routes: [
      { method: "POST", path: "/sessions", purpose: "Open a session." },
      { method: "POST", path: "/turns", purpose: "Append a turn and update the running token total." },
      { method: "GET", path: "/context", purpose: "Assemble context: summaries, retrieved turns, recent turns." },
      { method: "POST", path: "/compact", purpose: "Cron. Summarize the oldest turns of oversized sessions." },
    ],
    imports: [],
    handlerBody: `
router.post("/sessions", async (request) => {
  const body = await readJsonObject(request);

  const { rows } = await getPool().query<{ id: string }>(
    \`INSERT INTO blocks_agent_memory.sessions (agent_code, owner_ref, title, expires_at)
     VALUES ($1, $2, $3, $4) RETURNING id\`,
    [
      requireString(body, "agentCode"),
      requireString(body, "ownerRef"),
      typeof body["title"] === "string" ? body["title"] : null,
      typeof body["expiresAt"] === "string" ? body["expiresAt"] : null,
    ],
  );

  return json({ sessionId: rows[0]?.id }, { status: 201 });
});

router.post("/turns", async (request) => {
  const body = await readJsonObject(request);
  const sessionId = requireString(body, "sessionId");
  const role = requireString(body, "role");
  const content = requireString(body, "content");

  // Caller-supplied when available, else estimated. Four characters per token is wrong for code and
  // for non-Latin scripts; a real tokenizer is the fix and is noted as a limitation.
  const tokenCount =
    typeof body["tokenCount"] === "number" ? body["tokenCount"] : Math.ceil(content.length / 4);

  const pool = getPool();

  // Turn index and running total advance in one statement, so two concurrent appends cannot both
  // claim the same index or lose a token count.
  const { rows } = await pool.query<{ turn_index: number; total_tokens: number }>(
    \`WITH updated AS (
       UPDATE blocks_agent_memory.sessions
       SET turn_count = turn_count + 1,
           total_tokens = total_tokens + $2,
           updated_at = now()
       WHERE id = $1 AND status = 'active'
       RETURNING turn_count, total_tokens
     )
     INSERT INTO blocks_agent_memory.turns (session_id, turn_index, role, content, token_count)
     SELECT $1, updated.turn_count, $3, $4, $2 FROM updated
     RETURNING turn_index, (SELECT total_tokens FROM updated) AS total_tokens\`,
    [sessionId, tokenCount, role, content],
  );

  const row = rows[0];
  if (!row) throw new NotFoundError("No such active session");

  const cfg = config();
  const threshold = cfg.int("MEMORY_COMPACT_AT_TOKENS", { min: 1_000, max: 1_000_000 });

  // TODO(agent-memory): embed this turn for retrieval. Deliberately not inline -- a user-facing turn
  // should not wait on an embedding call. Queue it, or batch on the /compact schedule.
  return json(
    {
      turnIndex: row.turn_index,
      totalTokens: row.total_tokens,
      // Surfaced so the caller knows compaction is due without querying for it.
      compactionDue: row.total_tokens > threshold,
    },
    { status: 201 },
  );
});

router.get("/context", async (_request, ctx) => {
  const sessionId = ctx.url.searchParams.get("session");
  if (!sessionId) throw new ValidationError("?session= is required");

  const cfg = config();
  const keepRecent = cfg.int("MEMORY_KEEP_RECENT_TURNS", { min: 1, max: 200 });
  const pool = getPool();

  // Summaries first, then recent verbatim turns. That ordering reconstructs the conversation
  // chronologically: what happened earlier (compressed), then what happened lately (in full).
  const { rows: summaries } = await pool.query(
    \`SELECT from_turn, to_turn, summary, token_count
     FROM blocks_agent_memory.summaries WHERE session_id = $1 ORDER BY from_turn\`,
    [sessionId],
  );

  const { rows: recent } = await pool.query(
    \`SELECT turn_index, role, content, token_count
     FROM blocks_agent_memory.turns
     WHERE session_id = $1 AND NOT is_compacted
     ORDER BY turn_index DESC
     LIMIT $2\`,
    [sessionId, keepRecent],
  );

  // TODO(agent-memory): semantic retrieval.
  //   embed the current query and pull the most relevant COMPACTED turns via <=>, so a detail from
  //   turn 12 is available at turn 200 without replaying everything. This is the part that keeps an
  //   agent coherent past a few dozen turns, and it is why compacted turns are retained rather than
  //   deleted.
  return json({
    sessionId,
    summaries,
    recentTurns: recent.reverse(),
    retrievedTurns: [],
    note: "Semantic retrieval is not yet wired; see the TODO in src/index.ts.",
  });
});

router.post("/compact", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", \`/compact expects a schedule trigger, got \${event.type}\`);
  }

  const cfg = config();
  const threshold = cfg.int("MEMORY_COMPACT_AT_TOKENS", { min: 1_000, max: 1_000_000 });

  // Identifying what needs compaction works; performing it does not. Reported honestly so an
  // operator can see the backlog rather than assuming it is handled.
  const { rows } = await getPool().query<{ id: string; total_tokens: number; turn_count: number }>(
    \`SELECT id, total_tokens, turn_count
     FROM blocks_agent_memory.sessions
     WHERE status = 'active' AND total_tokens > $1 AND turn_count > compacted_through_turn
     ORDER BY total_tokens DESC
     LIMIT 20\`,
    [threshold],
  );

  // TODO(agent-memory): the compaction pass.
  //   1. take turns from compacted_through_turn up to (turn_count - MEMORY_KEEP_RECENT_TURNS)
  //   2. summarize them with MEMORY_SUMMARY_MODEL and insert a summaries row
  //   3. mark those turns is_compacted -- NOT deleted: a summary is lossy, so the originals are the
  //      only place a compacted-away detail still exists, and retrieval reads them
  //   4. advance compacted_through_turn and reduce total_tokens by the difference
  //
  //   Never truncate the head instead of summarizing: the first message is usually where the task
  //   was defined, and dropping it is how an agent forgets what it was asked to do.
  return json({
    ok: true,
    scheduledAt: event.scheduledAt,
    sessionsNeedingCompaction: rows.length,
    compacted: 0,
    note:
      rows.length > 0
        ? "Compaction is not yet wired; these sessions will overflow their context window. See the " +
          "TODO in src/index.ts."
        : undefined,
  });
});`,
    healthEval: `
      const needing = Number(status["sessions_needing_compaction"] ?? 0);
      const unembedded = Number(status["turns_unembedded"] ?? 0);
      const largest = Number(status["largest_session_tokens"] ?? 0);

      if (needing > 0) {
        // This is the failure the block exists to prevent, so it is reported rather than inferred.
        problems.push(
          \`\${needing} session(s) are over the compaction threshold and will overflow their context \` +
            \`window on the next turn\`,
        );
      }
      if (largest > 100_000) {
        problems.push(\`largest session is \${largest} tokens, beyond most model windows\`);
      }
      if (unembedded > 0) {
        problems.push(
          \`\${unembedded} turn(s) have no embedding and cannot be retrieved semantically, only \` +
            \`replayed in order\`,
        );
      }`,
  },

  {
    slug: "feature-flags",
    rank: 22,
    name: "Feature Flags and Experiments",
    summary:
      "Deterministic bucketing, exposure logging, and a significance readout — flags that double as A/B tests.",
    billing: "free",
    capabilities: ["postgres"],
    dependsOn: [],
    why:
      "Flags are easy; experiments are not. The difference is sticky assignment and exposure logging: " +
      "without both, a user flips between variants across requests and the results mean nothing. " +
      "Putting assignment in Postgres makes it consistent across every process, which an in-memory " +
      "implementation cannot be.",
    notes: [
      "**Bucketing is a hash of (flag, subject), not random.** The same subject always lands in the same variant, without storing an assignment row per user. That is what makes it sticky across processes and across restarts.",
      "**The flag key is part of the hash.** Hashing the subject alone would correlate every experiment — a user in the treatment group for one test would be in treatment for all of them, which silently confounds every result.",
      "**Exposure is logged when a flag is evaluated, not when it is assigned.** A user bucketed into treatment who never reaches the feature must not count as treated; counting them dilutes the effect toward zero.",
      "**Overrides are explicit rows that bypass bucketing.** Needed constantly in practice — for a support case, a demo account, or a customer who reported the bug — and they are recorded so they can be excluded from analysis.",
    ],
    limits: [
      "**The significance readout is a TODO seam.** Exposure and conversion collection is real; the statistics are not. A two-proportion z-test is the sensible first version, and it must report confidence intervals rather than a bare p-value.",
      "**No sequential-testing correction.** Repeatedly checking an experiment until it looks significant inflates false positives badly. Until a correction is implemented, treat interim readouts as directional only — this is the most important caveat here.",
      "**Bucketing is uniform only in expectation.** With a few hundred subjects, a 50/50 split can land meaningfully off-balance, and small experiments will look skewed.",
      "**Evaluation is a database round trip per flag.** Correct and consistent, but it adds latency; caching flag definitions for a few seconds is the obvious optimisation and is left to the caller.",
    ],
    env: [
      INJECTED_DB,
      {
        name: "FLAGS_EXPOSURE_SAMPLE_RATE",
        description:
          "Fraction of exposures recorded, 0..1. Below 1 reduces write volume but widens confidence intervals proportionally.",
        required: false,
        default: "1",
      },
      {
        name: "FLAGS_DEFAULT_ON_ERROR",
        description:
          "Value returned when evaluation fails. Defaults to false: a flag failing open turns an outage into an unreviewed feature launch.",
        required: false,
        default: "false",
      },
      TRIGGER_SECRET,
    ],
    triggers: [
      {
        type: "schedule",
        cron: "47 2 * * *",
        functionPath: "/rollup",
        description:
          "Aggregate exposures and conversions into daily results, so the readout does not scan raw events.",
      },
    ],
    tables: `
CREATE TABLE IF NOT EXISTS blocks_feature_flags.flags (
  key           text        PRIMARY KEY,
  description   text,

  -- 'boolean' for a plain flag, 'experiment' when variants are compared.
  kind          text        NOT NULL DEFAULT 'boolean',
  is_enabled    boolean     NOT NULL DEFAULT false,

  -- variant name -> weight. Weights need not sum to 100; they are normalized at evaluation.
  variants      jsonb       NOT NULL DEFAULT '{"control":50,"treatment":50}'::jsonb,
  -- Percentage of subjects included at all, 0..100. Lets an experiment run on 5% of traffic.
  rollout_pct   integer     NOT NULL DEFAULT 100,

  -- Set when an experiment is concluded, so a stale flag is distinguishable from a live one.
  concluded_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT flags_kind_valid CHECK (kind IN ('boolean', 'experiment')),
  CONSTRAINT flags_rollout_sane CHECK (rollout_pct BETWEEN 0 AND 100)
);

-- Explicit overrides bypassing bucketing. Needed constantly in practice -- a support case, a demo
-- account, a customer who reported the bug -- and recorded so they can be excluded from analysis.
CREATE TABLE IF NOT EXISTS blocks_feature_flags.overrides (
  flag_key      text        NOT NULL REFERENCES blocks_feature_flags.flags(key) ON DELETE CASCADE,
  subject_ref   text        NOT NULL,
  variant       text        NOT NULL,
  reason        text,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (flag_key, subject_ref)
);

-- One row per evaluation, sampled. Logged at EVALUATION, not assignment: a subject bucketed into
-- treatment who never reaches the feature must not count as treated, because counting them dilutes
-- the measured effect toward zero.
CREATE TABLE IF NOT EXISTS blocks_feature_flags.exposures (
  id            bigserial   PRIMARY KEY,
  flag_key      text        NOT NULL,
  subject_ref   text        NOT NULL,
  variant       text        NOT NULL,
  -- True when an override decided this, so overridden subjects can be excluded from results.
  was_override  boolean     NOT NULL DEFAULT false,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS exposures_flag_idx
  ON blocks_feature_flags.exposures (flag_key, occurred_at);
CREATE INDEX IF NOT EXISTS exposures_subject_idx
  ON blocks_feature_flags.exposures (flag_key, subject_ref);

CREATE TABLE IF NOT EXISTS blocks_feature_flags.conversions (
  id            bigserial   PRIMARY KEY,
  flag_key      text        NOT NULL,
  subject_ref   text        NOT NULL,
  metric        text        NOT NULL,
  value         numeric     NOT NULL DEFAULT 1,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversions_flag_metric_idx
  ON blocks_feature_flags.conversions (flag_key, metric, occurred_at);
-- One conversion per subject per metric is the usual analysis unit; the index supports deduping.
CREATE INDEX IF NOT EXISTS conversions_subject_idx
  ON blocks_feature_flags.conversions (flag_key, metric, subject_ref);

-- Daily aggregates, so a readout does not scan raw events.
CREATE TABLE IF NOT EXISTS blocks_feature_flags.results (
  flag_key      text        NOT NULL,
  variant       text        NOT NULL,
  metric        text        NOT NULL,
  day           date        NOT NULL,
  -- Distinct subjects exposed, not exposure count: a user seeing a feature twice is one subject.
  subjects      bigint      NOT NULL DEFAULT 0,
  conversions   bigint      NOT NULL DEFAULT 0,
  value_sum     numeric     NOT NULL DEFAULT 0,

  PRIMARY KEY (flag_key, variant, metric, day)
);`,
    statusView: `
  (SELECT count(*) FROM blocks_feature_flags.flags)                     AS flags_total,
  (SELECT count(*) FROM blocks_feature_flags.flags WHERE is_enabled)    AS flags_enabled,
  (SELECT count(*) FROM blocks_feature_flags.flags WHERE kind = 'experiment'
     AND concluded_at IS NULL)                                          AS experiments_running,

  -- Experiments running for a long time without conclusion. These are the ones accumulating
  -- sequential-testing error, and the ones nobody remembers to clean up.
  (SELECT count(*) FROM blocks_feature_flags.flags
     WHERE kind = 'experiment' AND concluded_at IS NULL
       AND created_at < now() - interval '90 days')                      AS experiments_stale,

  (SELECT count(*) FROM blocks_feature_flags.overrides)                 AS overrides_total,
  (SELECT count(*) FROM blocks_feature_flags.exposures
     WHERE occurred_at > now() - interval '1 day')                       AS exposures_last_day,
  (SELECT count(*) FROM blocks_feature_flags.conversions
     WHERE occurred_at > now() - interval '1 day')                       AS conversions_last_day,
  (SELECT count(*) FROM blocks_feature_flags.results)                   AS result_rows,

  -- Flags with exposures but no rollup rows: the rollup cron is not running, so no readout is
  -- possible however much data has been collected.
  (SELECT count(DISTINCT e.flag_key) FROM blocks_feature_flags.exposures e
     WHERE NOT EXISTS (SELECT 1 FROM blocks_feature_flags.results r
                       WHERE r.flag_key = e.flag_key))                   AS flags_without_rollup`,
    dropOrder: [
      "TABLE blocks_feature_flags.results",
      "TABLE blocks_feature_flags.conversions",
      "TABLE blocks_feature_flags.exposures",
      "TABLE blocks_feature_flags.overrides",
      "TABLE blocks_feature_flags.flags",
    ],
    routes: [
      { method: "POST", path: "/flags", purpose: "Create or update a flag." },
      { method: "GET", path: "/evaluate", purpose: "Evaluate a flag for a subject and log exposure." },
      { method: "POST", path: "/convert", purpose: "Record a conversion." },
      { method: "GET", path: "/results", purpose: "Readout per variant." },
      { method: "POST", path: "/rollup", purpose: "Cron. Aggregate into daily results." },
    ],
    imports: ['import { createHash } from "node:crypto";'],
    handlerBody: `
/**
 * Deterministic bucketing.
 *
 * Hash of (flagKey, subjectRef) mapped to 0..9999, so the same subject always lands in the same
 * variant without storing an assignment row per user — which is what makes it sticky across
 * processes and restarts.
 *
 * The flag key must be part of the hash. Hashing the subject alone correlates every experiment: a
 * user in treatment for one test would be in treatment for all of them, silently confounding every
 * result you ever read.
 */
export function bucketOf(flagKey: string, subjectRef: string): number {
  const digest = createHash("sha256").update(\`\${flagKey}:\${subjectRef}\`).digest();
  // First 4 bytes as an unsigned int, modulo 10000 for basis-point resolution.
  return digest.readUInt32BE(0) % 10_000;
}

/** Pick a variant from normalized weights using a precomputed bucket. */
export function variantFor(
  bucket: number,
  variants: Record<string, number>,
  rolloutPct: number,
): string | null {
  // Rollout gate first, using the same bucket: a subject outside the rollout is consistently
  // outside it, rather than flickering in and out between requests.
  if (bucket >= rolloutPct * 100) return null;

  const entries = Object.entries(variants).filter(([, w]) => w > 0);
  if (entries.length === 0) return null;

  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  // Rescale the bucket into the rollout range, so weights apply across included subjects rather
  // than across all traffic.
  const scaled = (bucket / (rolloutPct * 100)) * total;

  let cumulative = 0;
  for (const [name, weight] of entries) {
    cumulative += weight;
    if (scaled < cumulative) return name;
  }
  return entries[entries.length - 1]?.[0] ?? null;
}

router.post("/flags", async (request) => {
  const body = await readJsonObject(request);
  const variants = body["variants"];
  if (variants !== undefined && (typeof variants !== "object" || variants === null)) {
    throw new ValidationError('"variants" must be an object mapping variant name to weight');
  }

  await getPool().query(
    \`INSERT INTO blocks_feature_flags.flags
       (key, description, kind, is_enabled, variants, rollout_pct)
     VALUES ($1, $2, $3, $4, COALESCE($5::jsonb, '{"control":50,"treatment":50}'::jsonb), $6)
     ON CONFLICT (key) DO UPDATE
       SET description = EXCLUDED.description,
           kind = EXCLUDED.kind,
           is_enabled = EXCLUDED.is_enabled,
           variants = EXCLUDED.variants,
           rollout_pct = EXCLUDED.rollout_pct,
           updated_at = now()\`,
    [
      requireString(body, "key"),
      body["description"] ?? null,
      typeof body["kind"] === "string" ? body["kind"] : "boolean",
      body["isEnabled"] === true,
      variants ? JSON.stringify(variants) : null,
      typeof body["rolloutPct"] === "number" ? body["rolloutPct"] : 100,
    ],
  );

  return json({ key: body["key"] }, { status: 201 });
});

router.get("/evaluate", async (_request, ctx) => {
  const flagKey = ctx.url.searchParams.get("flag");
  const subjectRef = ctx.url.searchParams.get("subject");
  if (!flagKey) throw new ValidationError("?flag= is required");
  if (!subjectRef) throw new ValidationError("?subject= is required");

  const cfg = config();
  const pool = getPool();

  const { rows } = await pool.query<{
    is_enabled: boolean;
    variants: Record<string, number>;
    rollout_pct: number;
    kind: string;
  }>(
    \`SELECT is_enabled, variants, rollout_pct, kind
     FROM blocks_feature_flags.flags WHERE key = $1\`,
    [flagKey],
  );

  const flag = rows[0];
  if (!flag) {
    // An unknown flag returns the configured default rather than erroring, because a missing flag
    // must not break a request path. Defaults to off: failing open turns an outage into an
    // unreviewed feature launch.
    return json({
      flag: flagKey,
      enabled: cfg.bool("FLAGS_DEFAULT_ON_ERROR"),
      variant: null,
      reason: "flag not found; returned FLAGS_DEFAULT_ON_ERROR",
    });
  }

  if (!flag.is_enabled) {
    return json({ flag: flagKey, enabled: false, variant: null, reason: "flag disabled" });
  }

  // Overrides win, and are marked so analysis can exclude them.
  const { rows: overrides } = await pool.query<{ variant: string }>(
    \`SELECT variant FROM blocks_feature_flags.overrides
     WHERE flag_key = $1 AND subject_ref = $2\`,
    [flagKey, subjectRef],
  );

  const override = overrides[0];
  const bucket = bucketOf(flagKey, subjectRef);
  const variant = override
    ? override.variant
    : variantFor(bucket, flag.variants, flag.rollout_pct);

  // Exposure is logged here -- at evaluation -- not when the subject was bucketed. Sampled to bound
  // write volume, at the cost of proportionally wider confidence intervals.
  const sampleRate = Number(cfg.get("FLAGS_EXPOSURE_SAMPLE_RATE"));
  if (variant !== null && (sampleRate >= 1 || bucket % 10_000 < sampleRate * 10_000)) {
    await pool.query(
      \`INSERT INTO blocks_feature_flags.exposures (flag_key, subject_ref, variant, was_override)
       VALUES ($1, $2, $3, $4)\`,
      [flagKey, subjectRef, variant, override !== undefined],
    );
  }

  return json({
    flag: flagKey,
    enabled: variant !== null,
    variant,
    bucket,
    reason: override ? "override" : variant === null ? "outside rollout" : "bucketed",
  });
});

router.post("/convert", async (request) => {
  const body = await readJsonObject(request);

  await getPool().query(
    \`INSERT INTO blocks_feature_flags.conversions (flag_key, subject_ref, metric, value)
     VALUES ($1, $2, $3, $4)\`,
    [
      requireString(body, "flag"),
      requireString(body, "subject"),
      requireString(body, "metric"),
      typeof body["value"] === "number" ? body["value"] : 1,
    ],
  );

  return json({ recorded: true }, { status: 201 });
});

router.get("/results", async (_request, ctx) => {
  const flagKey = ctx.url.searchParams.get("flag");
  if (!flagKey) throw new ValidationError("?flag= is required");

  // Counts distinct subjects, not exposures: a user seeing a feature twice is one subject, and
  // counting exposures would inflate the denominator and understate the conversion rate.
  const { rows } = await getPool().query(
    \`SELECT variant, metric,
            sum(subjects)    AS subjects,
            sum(conversions) AS conversions,
            sum(value_sum)   AS value_sum,
            CASE WHEN sum(subjects) > 0
                 THEN round(100.0 * sum(conversions) / sum(subjects), 2)
                 ELSE 0 END  AS conversion_rate_pct
     FROM blocks_feature_flags.results
     WHERE flag_key = $1
     GROUP BY variant, metric
     ORDER BY metric, variant\`,
    [flagKey],
  );

  // TODO(feature-flags): significance testing.
  //   A two-proportion z-test over subjects and conversions per variant, reporting a confidence
  //   interval rather than a bare p-value.
  //
  //   It must also account for sequential testing. Repeatedly checking an experiment until it looks
  //   significant inflates false positives badly -- which is why the caveat below is returned in the
  //   response rather than buried in a doc.
  return json({
    flag: flagKey,
    results: rows,
    significance: null,
    caveat:
      "Significance testing is not yet wired. Treat these numbers as directional only: repeatedly " +
      "checking an experiment until it looks significant substantially inflates false positives.",
  });
});

router.post("/rollup", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", \`/rollup expects a schedule trigger, got \${event.type}\`);
  }

  // Complete and load-bearing: without it /results has nothing to read, however many exposures were
  // collected. Counts DISTINCT subjects per variant, then joins conversions for those subjects.
  const { rowCount } = await getPool().query(
    \`INSERT INTO blocks_feature_flags.results
       (flag_key, variant, metric, day, subjects, conversions, value_sum)
     SELECT e.flag_key,
            e.variant,
            COALESCE(c.metric, '_exposure'),
            date_trunc('day', e.occurred_at)::date,
            count(DISTINCT e.subject_ref),
            count(DISTINCT c.subject_ref),
            COALESCE(sum(c.value), 0)
     FROM blocks_feature_flags.exposures e
     LEFT JOIN blocks_feature_flags.conversions c
       ON c.flag_key = e.flag_key AND c.subject_ref = e.subject_ref
     -- Overridden subjects are excluded: their variant was chosen by a human, so including them
     -- biases the comparison.
     WHERE NOT e.was_override
       AND e.occurred_at >= date_trunc('day', now() - interval '2 days')
     GROUP BY e.flag_key, e.variant, COALESCE(c.metric, '_exposure'),
              date_trunc('day', e.occurred_at)
     ON CONFLICT (flag_key, variant, metric, day) DO UPDATE
       SET subjects = EXCLUDED.subjects,
           conversions = EXCLUDED.conversions,
           value_sum = EXCLUDED.value_sum\`,
  );

  return json({ ok: true, scheduledAt: event.scheduledAt, resultRowsWritten: rowCount ?? 0 });
});`,
    healthEval: `
      const withoutRollup = Number(status["flags_without_rollup"] ?? 0);
      const stale = Number(status["experiments_stale"] ?? 0);

      if (withoutRollup > 0) {
        problems.push(
          \`\${withoutRollup} flag(s) have exposures but no rollup rows; the /rollup trigger may be \` +
            \`disabled, so no readout is possible however much data was collected\`,
        );
      }
      if (stale > 0) {
        problems.push(
          \`\${stale} experiment(s) have been running over 90 days without conclusion. These \` +
            \`accumulate sequential-testing error and are the ones nobody remembers to clean up.\`,
        );
      }`,
  },
];
