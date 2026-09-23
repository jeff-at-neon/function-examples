# Block 22 — Feature Flags and Experiments

Deterministic bucketing, exposure logging, and a significance readout — flags that double as A/B tests.

**Block 22 of 25**, numbered in build order.

> **Status: implemented.** Schema, safety checks, control flow, and the core logic (deterministic
> bucketing and two-proportion significance testing) are all wired, with pure unit tests. Still
> unverified against a live Neon project.

## Why this block

Flags are easy; experiments are not. The difference is sticky assignment and exposure logging: without both, a user flips between variants across requests and the results mean nothing. Putting assignment in Postgres makes it consistent across every process, which an in-memory implementation cannot be.

## Install

```bash
neon-blocks migrate feature-flags
neon function deploy feature-flags --src blocks/feature-flags/src
neon triggers create --function-slug feature-flags --name feature-flags-rollup \
  --schedule '47 2 * * *' --function-path '/rollup'
```

> Child branches inherit triggers **disabled**. Enable them after promoting, or scheduled work
> silently never runs.

## Design notes

- **Bucketing is a hash of (flag, subject), not random.** The same subject always lands in the same variant, without storing an assignment row per user. That is what makes it sticky across processes and across restarts.
- **The flag key is part of the hash.** Hashing the subject alone would correlate every experiment — a user in the treatment group for one test would be in treatment for all of them, which silently confounds every result.
- **Exposure is logged when a flag is evaluated, not when it is assigned.** A user bucketed into treatment who never reaches the feature must not count as treated; counting them dilutes the effect toward zero.
- **Overrides are explicit rows that bypass bucketing.** Needed constantly in practice — for a support case, a demo account, or a customer who reported the bug — and they are recorded so they can be excluded from analysis.

## API

| Route | Purpose |
|---|---|
| `POST /flags` | Create or update a flag. |
| `GET /evaluate` | Evaluate a flag for a subject and log exposure. |
| `POST /convert` | Record a conversion. |
| `GET /results` | Readout per variant. |
| `POST /rollup` | Cron. Aggregate into daily results. |
| `GET /health` | `200` / `503`. |

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `FLAGS_EXPOSURE_SAMPLE_RATE` | `1` | Fraction of exposures recorded, 0..1. Below 1 reduces write volume but widens confidence intervals proportionally. |
| `FLAGS_DEFAULT_ON_ERROR` | `false` | Value returned when evaluation fails. Defaults to false: a flag failing open turns an outage into an unreviewed feature launch. |
| `NEON_BLOCKS_TRIGGER_SECRET` | `` | Shared secret authenticating trigger delivery. Neon does not sign trigger POSTs. |

Injected automatically by Neon: `DATABASE_URL`.

## Limits and honest caveats

- **The significance readout is a TODO seam.** Exposure and conversion collection is real; the statistics are not. A two-proportion z-test is the sensible first version, and it must report confidence intervals rather than a bare p-value.
- **No sequential-testing correction.** Repeatedly checking an experiment until it looks significant inflates false positives badly. Until a correction is implemented, treat interim readouts as directional only — this is the most important caveat here.
- **Bucketing is uniform only in expectation.** With a few hundred subjects, a 50/50 split can land meaningfully off-balance, and small experiments will look skewed.
- **Evaluation is a database round trip per flag.** Correct and consistent, but it adds latency; caching flag definitions for a few seconds is the obvious optimisation and is left to the caller.
- **Unverified against a live Neon project.** Nothing in this repo has been run against real Neon
  infrastructure yet.

## Observability

```sql
SELECT * FROM blocks_feature_flags.v_status;
```

## Uninstall

```bash
neon-blocks rollback feature-flags
```
