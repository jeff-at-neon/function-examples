-- Block 22: feature flags and experiments.
--
-- Flags are easy; experiments are not. The difference is sticky assignment and exposure logging: without both, a user flips between variants across requests and the results mean nothing. Putting assignment in Postgres makes it consistent across every process, which an in-memory implementation cannot be.

CREATE SCHEMA IF NOT EXISTS blocks_feature_flags;

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
);

-- ---------------------------------------------------------------------------
-- Observability (§10)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW blocks_feature_flags.v_status AS
SELECT
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
                       WHERE r.flag_key = e.flag_key))                   AS flags_without_rollup
;
