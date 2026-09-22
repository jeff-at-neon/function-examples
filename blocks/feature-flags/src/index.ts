/**
 * Block 22 — Feature Flags and Experiments.
 *
 * Deterministic bucketing, exposure logging, and a significance readout — flags that double as A/B tests.
 *
 * Flags are easy; experiments are not. The difference is sticky assignment and exposure logging: without both, a user flips between variants across requests and the results mean nothing. Putting assignment in Postgres makes it consistent across every process, which an in-memory implementation cannot be.
 *
 * Routes:
 *   POST   /flags                 Create or update a flag.
 *   GET    /evaluate              Evaluate a flag for a subject and log exposure.
 *   POST   /convert               Record a conversion.
 *   GET    /results               Readout per variant.
 *   POST   /rollup                Cron. Aggregate into daily results.
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

const log: Logger = createLogger({ block: "feature-flags" });

const SPEC = {
  block: "feature-flags",
  optional: {
    FLAGS_EXPOSURE_SAMPLE_RATE: "1",
    FLAGS_DEFAULT_ON_ERROR: "false",
  },
} as const;

function config() {
  return loadConfig(SPEC);
}

const router = new Router();

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
  const digest = createHash("sha256").update(`${flagKey}:${subjectRef}`).digest();
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
    `INSERT INTO blocks_feature_flags.flags
       (key, description, kind, is_enabled, variants, rollout_pct)
     VALUES ($1, $2, $3, $4, COALESCE($5::jsonb, '{"control":50,"treatment":50}'::jsonb), $6)
     ON CONFLICT (key) DO UPDATE
       SET description = EXCLUDED.description,
           kind = EXCLUDED.kind,
           is_enabled = EXCLUDED.is_enabled,
           variants = EXCLUDED.variants,
           rollout_pct = EXCLUDED.rollout_pct,
           updated_at = now()`,
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
    `SELECT is_enabled, variants, rollout_pct, kind
     FROM blocks_feature_flags.flags WHERE key = $1`,
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
    `SELECT variant FROM blocks_feature_flags.overrides
     WHERE flag_key = $1 AND subject_ref = $2`,
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
      `INSERT INTO blocks_feature_flags.exposures (flag_key, subject_ref, variant, was_override)
       VALUES ($1, $2, $3, $4)`,
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
    `INSERT INTO blocks_feature_flags.conversions (flag_key, subject_ref, metric, value)
     VALUES ($1, $2, $3, $4)`,
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
    `SELECT variant, metric,
            sum(subjects)    AS subjects,
            sum(conversions) AS conversions,
            sum(value_sum)   AS value_sum,
            CASE WHEN sum(subjects) > 0
                 THEN round(100.0 * sum(conversions) / sum(subjects), 2)
                 ELSE 0 END  AS conversion_rate_pct
     FROM blocks_feature_flags.results
     WHERE flag_key = $1
     GROUP BY variant, metric
     ORDER BY metric, variant`,
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
    return problem(400, "wrong_trigger", `/rollup expects a schedule trigger, got ${event.type}`);
  }

  // Complete and load-bearing: without it /results has nothing to read, however many exposures were
  // collected. Counts DISTINCT subjects per variant, then joins conversions for those subjects.
  const { rowCount } = await getPool().query(
    `INSERT INTO blocks_feature_flags.results
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
           value_sum = EXCLUDED.value_sum`,
  );

  return json({ ok: true, scheduledAt: event.scheduledAt, resultRowsWritten: rowCount ?? 0 });
});

router.get("/health", async () => {
  const report = await checkHealth(getPool(), {
    block: "feature-flags",
    schema: "blocks_feature_flags",
    evaluate: (status) => {
      const problems: string[] = [];

      const withoutRollup = Number(status["flags_without_rollup"] ?? 0);
      const stale = Number(status["experiments_stale"] ?? 0);

      if (withoutRollup > 0) {
        problems.push(
          `${withoutRollup} flag(s) have exposures but no rollup rows; the /rollup trigger may be ` +
            `disabled, so no readout is possible however much data was collected`,
        );
      }
      if (stale > 0) {
        problems.push(
          `${stale} experiment(s) have been running over 90 days without conclusion. These ` +
            `accumulate sequential-testing error and are the ones nobody remembers to clean up.`,
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
