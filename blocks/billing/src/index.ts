/**
 * Block 8 — Billing Spine.
 *
 * Normalizes provider webhooks into queryable tables, evaluates entitlements locally, meters usage,
 * and runs dunning. Pairs with block 6, which verifies the webhook signatures — this block consumes
 * the resulting events rather than receiving HTTP from Stripe directly.
 *
 * Routes:
 *   POST /sync      apply a normalized subscription state change
 *   GET  /entitlements?account=X  the authorization answer
 *   POST /usage     record a metered event
 *   POST /sweep     cron — dunning, trial expiry, usage rollups
 *   GET  /health    observability
 */

import {
  checkHealth,
  createLogger,
  getPool,
  json,
  loadConfig,
  NotFoundError,
  Router,
  ValidationError,
  assertTriggerAuthentic,
  parseTriggerEvent,
  problem,
  type Logger,
  type Queryable,
} from "@neon-blocks/core";
import { publish } from "@neon-blocks/events";
import {
  billingPeriodFor,
  checkQuota,
  dunningStage,
  evaluateAccess,
  hasFeature,
  type PlanFeatures,
  type Subscription,
  type SubscriptionStatus,
} from "./entitlements.js";

const log: Logger = createLogger({ block: "billing" });

const SPEC = {
  block: "billing",
  optional: {
    BILLING_GRACE_PERIOD_DAYS: "3",
    BILLING_DUNNING_SCHEDULE: "0,3,7,14",
    BILLING_TRIAL_WARNING_DAYS: "3",
  },
} as const;

function config() {
  const raw = loadConfig(SPEC);
  const schedule = raw
    .get("BILLING_DUNNING_SCHEDULE")
    .split(",")
    .map((part) => Number(part.trim()));

  if (schedule.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new ValidationError(
      `BILLING_DUNNING_SCHEDULE must be comma-separated non-negative integers, e.g. "0,3,7,14".`,
    );
  }

  return {
    gracePeriodDays: raw.int("BILLING_GRACE_PERIOD_DAYS", { min: 0, max: 90 }),
    dunningSchedule: schedule.sort((a, b) => a - b),
    trialWarningDays: raw.int("BILLING_TRIAL_WARNING_DAYS", { min: 0, max: 90 }),
  };
}

const router = new Router();

/**
 * Apply a subscription state change.
 *
 * Takes already-normalized fields rather than a raw provider payload, so this block is not coupled
 * to any one provider's JSON shape. Block 6 verifies and archives; a queue handler maps the payload
 * into this call.
 */
router.post("/sync", async (request) => {
  const body = await readJsonObject(request);
  const pool = getPool();

  const provider = typeof body["provider"] === "string" ? body["provider"] : "stripe";
  const accountRef = requireString(body, "accountRef");
  const providerCustomerId = requireString(body, "providerCustomerId");
  const providerSubscriptionId = requireString(body, "providerSubscriptionId");
  const status = requireString(body, "status") as SubscriptionStatus;

  const { rows: customerRows } = await pool.query<{ id: string }>(
    `INSERT INTO blocks_billing.customers (account_ref, provider, provider_customer_id, email)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider, provider_customer_id) DO UPDATE
       SET account_ref = EXCLUDED.account_ref,
           email = COALESCE(EXCLUDED.email, blocks_billing.customers.email)
     RETURNING id`,
    [accountRef, provider, providerCustomerId, body["email"] ?? null],
  );
  const customerId = customerRows[0]?.id;
  if (!customerId) throw new Error("Failed to upsert customer");

  // Provider events are not ordered, so a delayed webhook can otherwise overwrite newer state with
  // older. The WHERE clause makes the update a no-op unless this payload is genuinely newer.
  const { rowCount } = await pool.query(
    `INSERT INTO blocks_billing.subscriptions
       (customer_id, provider, provider_subscription_id, plan_code, status,
        current_period_start, current_period_end, trial_end, cancel_at, canceled_at,
        provider_updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (provider, provider_subscription_id) DO UPDATE
       SET plan_code = EXCLUDED.plan_code,
           status = EXCLUDED.status,
           current_period_start = EXCLUDED.current_period_start,
           current_period_end = EXCLUDED.current_period_end,
           trial_end = EXCLUDED.trial_end,
           cancel_at = EXCLUDED.cancel_at,
           canceled_at = EXCLUDED.canceled_at,
           provider_updated_at = EXCLUDED.provider_updated_at
       WHERE blocks_billing.subscriptions.provider_updated_at IS NULL
          OR EXCLUDED.provider_updated_at IS NULL
          OR EXCLUDED.provider_updated_at >= blocks_billing.subscriptions.provider_updated_at`,
    [
      customerId,
      provider,
      providerSubscriptionId,
      body["planCode"] ?? null,
      status,
      body["currentPeriodStart"] ?? null,
      body["currentPeriodEnd"] ?? null,
      body["trialEnd"] ?? null,
      body["cancelAt"] ?? null,
      body["canceledAt"] ?? null,
      body["providerUpdatedAt"] ?? null,
    ],
  );

  const applied = (rowCount ?? 0) > 0;
  if (!applied) {
    log.info("ignored out-of-order subscription update", { providerSubscriptionId });
  }

  // Let the rest of the app react — cache invalidation, welcome emails, seat provisioning.
  await publish(pool, {
    type: "billing.subscription_synced",
    subject: accountRef,
    payload: { accountRef, status, planCode: body["planCode"] ?? null, applied },
  });

  return json({ ok: true, customerId, applied });
});

router.get("/entitlements", async (_request, ctx) => {
  const accountRef = ctx.url.searchParams.get("account");
  if (!accountRef) throw new ValidationError("?account= is required");

  const cfg = config();
  const state = await loadEntitlements(getPool(), accountRef);
  if (!state) throw new NotFoundError(`No billing record for account "${accountRef}"`);

  const access = evaluateAccess(state.subscription, new Date(), cfg.gracePeriodDays);

  // Feature and quota questions are answered here rather than making the caller re-derive them,
  // so authorization logic lives in exactly one place.
  const feature = ctx.url.searchParams.get("feature");
  const metric = ctx.url.searchParams.get("metric");

  let featureDecision;
  if (feature) featureDecision = hasFeature(state.plan, feature, access);

  let quotaDecision;
  if (metric) {
    const used = await currentUsage(getPool(), state.customerId, metric, state.subscription);
    const increment = Number(ctx.url.searchParams.get("increment") ?? "1");
    quotaDecision = checkQuota(state.plan, metric, used, access, increment);
  }

  return json({
    accountRef,
    access,
    status: state.subscription?.status ?? null,
    planCode: state.subscription?.planCode ?? null,
    features: state.plan?.features ?? [],
    limits: state.plan?.limits ?? {},
    ...(featureDecision ? { feature: { name: feature, ...featureDecision } } : {}),
    ...(quotaDecision ? { quota: { metric, ...quotaDecision } } : {}),
  });
});

router.post("/usage", async (request) => {
  const body = await readJsonObject(request);
  const accountRef = requireString(body, "accountRef");
  const metric = requireString(body, "metric");
  const quantity = typeof body["quantity"] === "number" ? body["quantity"] : 1;

  if (quantity < 0) throw new ValidationError("quantity must be >= 0");

  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM blocks_billing.customers WHERE account_ref = $1 LIMIT 1`,
    [accountRef],
  );
  const customerId = rows[0]?.id;
  if (!customerId) throw new NotFoundError(`No customer for account "${accountRef}"`);

  // ON CONFLICT DO NOTHING on the idempotency key. Metering is usually driven by at-least-once
  // events, and a redelivery that double-bills is the most damaging bug this block could have.
  const inserted = await pool.query(
    `INSERT INTO blocks_billing.usage_events
       (customer_id, metric, quantity, idempotency_key, occurred_at, metadata)
     VALUES ($1, $2, $3, $4, COALESCE($5, now()), $6::jsonb)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
    [
      customerId,
      metric,
      quantity,
      typeof body["idempotencyKey"] === "string" ? body["idempotencyKey"] : null,
      body["occurredAt"] ?? null,
      JSON.stringify(body["metadata"] ?? {}),
    ],
  );

  const recorded = (inserted.rowCount ?? 0) > 0;
  return json({ recorded, deduplicated: !recorded }, { status: recorded ? 201 : 200 });
});

router.post("/sweep", async (request) => {
  assertTriggerAuthentic(request);
  const event = parseTriggerEvent(await request.json(), request.headers);
  if (event.type !== "schedule") {
    return problem(400, "wrong_trigger", `/sweep expects a schedule trigger, got ${event.type}`);
  }

  const cfg = config();
  const pool = getPool();
  const now = new Date();

  // Dunning. Notices are recorded with a unique (subscription, stage) constraint, so a customer
  // cannot receive the same escalation twice however often the cron runs.
  interface OverdueRow {
    [column: string]: unknown;
    id: string;
    account_ref: string;
    status: SubscriptionStatus;
    current_period_end: Date | null;
    plan_code: string | null;
    trial_end: Date | null;
    cancel_at: Date | null;
  }

  const { rows: overdue } = await pool.query<OverdueRow>(
    `SELECT s.id, c.account_ref, s.status, s.current_period_end, s.plan_code, s.trial_end, s.cancel_at
     FROM blocks_billing.subscriptions s
     JOIN blocks_billing.customers c ON c.id = s.customer_id
     WHERE s.status IN ('past_due', 'unpaid')
     LIMIT 500`,
  );

  let noticesSent = 0;
  for (const row of overdue) {
    const subscription: Subscription = {
      status: row.status,
      planCode: row.plan_code ?? "",
      currentPeriodEnd: row.current_period_end,
      cancelAt: row.cancel_at,
      trialEnd: row.trial_end,
    };

    const stage = dunningStage(subscription, now, cfg.dunningSchedule);
    if (!stage) continue;

    const { rowCount } = await pool.query(
      `INSERT INTO blocks_billing.dunning_notices (subscription_id, stage, days_overdue)
       VALUES ($1, $2, $3)
       ON CONFLICT (subscription_id, stage) DO NOTHING`,
      [row.id, stage.stage, stage.daysOverdue],
    );

    if ((rowCount ?? 0) > 0) {
      noticesSent++;
      // Published rather than sent here: the notification block owns delivery, templates, and
      // quiet hours. This block decides *that* a notice is due, not how it looks.
      await publish(pool, {
        type: "billing.dunning_due",
        subject: row.account_ref,
        payload: {
          accountRef: row.account_ref,
          stage: stage.stage,
          daysOverdue: stage.daysOverdue,
        },
        idempotencyKey: `dunning:${row.id}:${stage.stage}`,
      });
    }
  }

  // Trials ending soon.
  const { rows: expiring } = await pool.query<{ account_ref: string; trial_end: Date }>(
    `SELECT c.account_ref, s.trial_end
     FROM blocks_billing.subscriptions s
     JOIN blocks_billing.customers c ON c.id = s.customer_id
     WHERE s.status = 'trialing'
       AND s.trial_end IS NOT NULL
       AND s.trial_end BETWEEN now() AND now() + make_interval(days => $1::int)
     LIMIT 500`,
    [cfg.trialWarningDays],
  );

  for (const row of expiring) {
    await publish(pool, {
      type: "billing.trial_ending",
      subject: row.account_ref,
      payload: { accountRef: row.account_ref, trialEnd: row.trial_end.toISOString() },
      // Date-suffixed so one reminder per day at most, rather than one per cron run.
      idempotencyKey: `trial-ending:${row.account_ref}:${row.trial_end.toISOString().slice(0, 10)}`,
    });
  }

  const rollups = await recomputeRollups(pool);

  const result = {
    dunningNoticesSent: noticesSent,
    overdueReviewed: overdue.length,
    trialsEndingSoon: expiring.length,
    rollupsComputed: rollups,
  };
  log.info("billing sweep complete", result);
  return json({ ok: true, scheduledAt: event.scheduledAt, ...result });
});

router.get("/health", async () => {
  const report = await checkHealth(getPool(), {
    block: "billing",
    schema: "blocks_billing",
    evaluate: (status) => {
      const problems: string[] = [];
      const orphanPlan = Number(status["subscriptions_orphan_plan"] ?? 0);
      const plansActive = Number(status["plans_active"] ?? 0);
      const overdue = Number(status["subscriptions_overdue"] ?? 0);

      // The dangerous one: a subscription pointing at a nonexistent plan evaluates to "no plan",
      // which denies every feature. A paying customer locked out by a typo, invisible otherwise.
      if (orphanPlan > 0) {
        problems.push(
          `${orphanPlan} subscription(s) reference a plan_code with no matching row in ` +
            `blocks_billing.plans. These evaluate to "no plan" and deny every feature — paying ` +
            `customers are locked out.`,
        );
      }
      if (plansActive === 0) {
        problems.push("no active plans are defined; every entitlement check will deny");
      }
      if (overdue > 0) problems.push(`${overdue} subscription(s) are past due or unpaid`);
      return problems;
    },
  });

  return json(report, { status: report.status === "ok" ? 200 : 503 });
});

interface EntitlementState {
  customerId: string;
  subscription: Subscription | null;
  plan: PlanFeatures | null;
}

async function loadEntitlements(
  db: Queryable,
  accountRef: string,
): Promise<EntitlementState | null> {
  interface Row {
    [column: string]: unknown;
    customer_id: string;
    status: SubscriptionStatus | null;
    plan_code: string | null;
    current_period_end: Date | null;
    trial_end: Date | null;
    cancel_at: Date | null;
    features: string[] | null;
    limits: Record<string, number | null> | null;
  }

  const { rows } = await db.query<Row>(
    `SELECT customer_id, status, plan_code, current_period_end, trial_end, cancel_at,
            features, limits
     FROM blocks_billing.v_entitlements
     WHERE account_ref = $1
     -- Prefer a live subscription when an account has historical ones too.
     ORDER BY CASE WHEN status IN ('active', 'trialing') THEN 0 ELSE 1 END,
              current_period_end DESC NULLS LAST
     LIMIT 1`,
    [accountRef],
  );

  const row = rows[0];
  if (!row) return null;

  return {
    customerId: row.customer_id,
    subscription: row.status
      ? {
          status: row.status,
          planCode: row.plan_code ?? "",
          currentPeriodEnd: row.current_period_end,
          cancelAt: row.cancel_at,
          trialEnd: row.trial_end,
        }
      : null,
    plan: row.plan_code
      ? { features: row.features ?? [], limits: row.limits ?? {} }
      : null,
  };
}

/**
 * Usage for the current billing period.
 *
 * Aggregates raw events rather than reading a rollup, because a quota check must reflect usage from
 * one second ago. Rollups exist for reporting, where staleness is acceptable.
 */
async function currentUsage(
  db: Queryable,
  customerId: string,
  metric: string,
  subscription: Subscription | null,
): Promise<number> {
  // Fall back to a 30-day window when no period is known, rather than counting all usage ever —
  // which would make a long-lived account permanently over quota.
  const since = subscription?.currentPeriodEnd
    ? new Date(subscription.currentPeriodEnd.getTime() - 31 * 86_400_000)
    : new Date(Date.now() - 30 * 86_400_000);

  const { rows } = await db.query<{ total: string }>(
    `SELECT COALESCE(sum(quantity), 0)::text AS total
     FROM blocks_billing.usage_events
     WHERE customer_id = $1 AND metric = $2 AND occurred_at >= $3`,
    [customerId, metric, since],
  );
  return Number(rows[0]?.total ?? 0);
}

/** Recompute rollups for subscriptions' current periods. */
async function recomputeRollups(db: Queryable): Promise<number> {
  const { rowCount } = await db.query(
    `INSERT INTO blocks_billing.usage_rollups
       (customer_id, metric, period_start, period_end, total, event_count, computed_at)
     SELECT u.customer_id,
            u.metric,
            s.current_period_start,
            s.current_period_end,
            sum(u.quantity),
            count(*),
            now()
     FROM blocks_billing.usage_events u
     JOIN blocks_billing.subscriptions s ON s.customer_id = u.customer_id
     WHERE s.current_period_start IS NOT NULL
       AND s.current_period_end IS NOT NULL
       AND u.occurred_at >= s.current_period_start
       AND u.occurred_at < s.current_period_end
     GROUP BY u.customer_id, u.metric, s.current_period_start, s.current_period_end
     ON CONFLICT (customer_id, metric, period_start) DO UPDATE
       SET total = EXCLUDED.total,
           event_count = EXCLUDED.event_count,
           computed_at = now()`,
  );
  return rowCount ?? 0;
}

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

export {
  evaluateAccess,
  hasFeature,
  checkQuota,
  dunningStage,
  billingPeriodFor,
  type Subscription,
  type SubscriptionStatus,
  type PlanFeatures,
  type AccessDecision,
} from "./entitlements.js";
