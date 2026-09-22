/**
 * Entitlement evaluation and usage metering.
 *
 * Pure, because "is this customer allowed to do this?" is the question the rest of the application
 * asks constantly and gets wrong in expensive, user-visible ways. The failure modes are asymmetric:
 * wrongly denying a paying customer is a support ticket; wrongly allowing a churned one is
 * unbilled usage.
 */

export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "incomplete"
  | "paused";

export interface Subscription {
  status: SubscriptionStatus;
  planCode: string;
  /** End of the paid period. Access usually continues to here even after cancellation. */
  currentPeriodEnd: Date | null;
  /** Set when cancellation is scheduled but the period has not ended. */
  cancelAt: Date | null;
  trialEnd: Date | null;
}

export interface PlanFeatures {
  /** Boolean feature flags granted by the plan. */
  features: readonly string[];
  /** Metered limits. `null` means unlimited; absent means not granted at all. */
  limits: Readonly<Record<string, number | null>>;
}

export type AccessDecision =
  | { allowed: true; reason: "active" | "trialing" | "grace_period" }
  | { allowed: false; reason: string };

/**
 * Whether a subscription currently grants access.
 *
 * `past_due` is the interesting case and the one most implementations get wrong. A failed payment
 * is usually a expired card, not a churn decision — cutting access instantly turns a recoverable
 * billing problem into a cancelled customer. So `past_due` keeps access until the paid period ends
 * plus a grace window, which is also what the dunning process assumes.
 */
export function evaluateAccess(
  subscription: Subscription | null,
  now: Date,
  gracePeriodDays = 3,
): AccessDecision {
  if (!subscription) return { allowed: false, reason: "no subscription" };

  switch (subscription.status) {
    case "active":
      // A scheduled cancellation does not revoke access early: they paid for the period.
      return { allowed: true, reason: "active" };

    case "trialing": {
      if (subscription.trialEnd && subscription.trialEnd <= now) {
        // Trial lapsed without the webhook arriving to move the status on. Treated as expired
        // rather than trusting a stale status, because the alternative is an indefinite free trial.
        return { allowed: false, reason: "trial ended" };
      }
      return { allowed: true, reason: "trialing" };
    }

    case "past_due":
    case "unpaid": {
      const deadline = subscription.currentPeriodEnd;
      if (!deadline) {
        // No period end recorded, so there is no defensible grace window to compute.
        return { allowed: false, reason: `subscription is ${subscription.status}` };
      }
      const graceEnd = new Date(deadline.getTime() + gracePeriodDays * 86_400_000);
      if (now <= graceEnd) return { allowed: true, reason: "grace_period" };
      return { allowed: false, reason: `payment overdue since ${deadline.toISOString()}` };
    }

    case "canceled": {
      // Cancelled mid-period still means paid through period end.
      if (subscription.currentPeriodEnd && now <= subscription.currentPeriodEnd) {
        return { allowed: true, reason: "active" };
      }
      return { allowed: false, reason: "subscription canceled" };
    }

    case "paused":
      return { allowed: false, reason: "subscription paused" };

    case "incomplete":
      return { allowed: false, reason: "initial payment never completed" };

    default: {
      // Exhaustiveness guard. A new status from the provider must be an explicit decision, not a
      // silent fall-through — and defaulting to denied is the safe direction.
      const never: never = subscription.status;
      return { allowed: false, reason: `unknown status ${String(never)}` };
    }
  }
}

export type FeatureDecision =
  | { allowed: true }
  | { allowed: false; reason: string; upgradeRequired: boolean };

/** Whether a plan grants a named boolean feature. */
export function hasFeature(
  plan: PlanFeatures | null,
  feature: string,
  access: AccessDecision,
): FeatureDecision {
  if (!access.allowed) {
    return { allowed: false, reason: access.reason, upgradeRequired: false };
  }
  if (!plan) {
    return { allowed: false, reason: "no plan configured", upgradeRequired: true };
  }
  if (!plan.features.includes(feature)) {
    return {
      allowed: false,
      reason: `plan does not include "${feature}"`,
      // Distinguishes "pay us more" from "fix your card", which are entirely different messages to
      // put in front of a user.
      upgradeRequired: true,
    };
  }
  return { allowed: true };
}

export type QuotaDecision =
  | { allowed: true; remaining: number | null; limit: number | null }
  | { allowed: false; reason: string; used: number; limit: number; upgradeRequired: boolean };

/**
 * Whether a metered action fits within the plan's limit.
 *
 * `increment` is explicit so a caller can check for a batch before doing any of it — checking one at
 * a time and discovering the limit halfway through a 500-row import is worse than refusing upfront.
 */
export function checkQuota(
  plan: PlanFeatures | null,
  metric: string,
  used: number,
  access: AccessDecision,
  increment = 1,
): QuotaDecision {
  if (!access.allowed) {
    return { allowed: false, reason: access.reason, used, limit: 0, upgradeRequired: false };
  }
  if (!plan) {
    return { allowed: false, reason: "no plan configured", used, limit: 0, upgradeRequired: true };
  }

  // Absent and null are different: absent means the plan does not grant this metric at all, null
  // means it grants it without limit. Conflating them either blocks paying customers or gives away
  // unlimited usage.
  if (!(metric in plan.limits)) {
    return {
      allowed: false,
      reason: `plan does not include metric "${metric}"`,
      used,
      limit: 0,
      upgradeRequired: true,
    };
  }

  // `in` above proved the key exists, but TypeScript cannot narrow an indexed read from that, and
  // `?? null` would silently collapse the absent case into "unlimited" — the exact conflation this
  // function exists to prevent. So the impossible branch is made explicit instead.
  const limit = plan.limits[metric];
  if (limit === undefined) {
    throw new Error(
      `Plan limit for "${metric}" is explicitly undefined. Use null for unlimited, or omit the ` +
        `key entirely to withhold the metric — undefined is ambiguous between the two.`,
    );
  }
  if (limit === null) return { allowed: true, remaining: null, limit: null };

  if (used + increment > limit) {
    return {
      allowed: false,
      reason: `quota exceeded for "${metric}": ${used} used of ${limit}, requested ${increment}`,
      used,
      limit,
      upgradeRequired: true,
    };
  }

  return { allowed: true, remaining: limit - used - increment, limit };
}

/**
 * The billing period a timestamp falls in, for usage rollups.
 *
 * Anchored to the subscription's own period boundary rather than the calendar month, because that is
 * what the invoice covers. Using calendar months for a subscription that renews on the 17th produces
 * usage totals that do not match any invoice, which is impossible to reconcile with a customer.
 */
export function billingPeriodFor(
  timestamp: Date,
  periodStart: Date,
  periodEnd: Date,
): { start: Date; end: Date } | null {
  if (timestamp < periodStart || timestamp >= periodEnd) return null;
  return { start: periodStart, end: periodEnd };
}

/**
 * Whether a dunning notice is due, and which one.
 *
 * Returns the escalation step rather than a boolean so the caller can send a different message at
 * each stage, and so a customer who has already had three emails is not sent a fourth identical one.
 */
export function dunningStage(
  subscription: Subscription,
  now: Date,
  schedule: readonly number[] = [0, 3, 7, 14],
): { stage: number; daysOverdue: number } | null {
  if (subscription.status !== "past_due" && subscription.status !== "unpaid") return null;
  if (!subscription.currentPeriodEnd) return null;

  const daysOverdue = Math.floor(
    (now.getTime() - subscription.currentPeriodEnd.getTime()) / 86_400_000,
  );
  if (daysOverdue < 0) return null;

  // Highest threshold reached, so a gap in cron runs does not skip a notice entirely.
  let stage = -1;
  for (const [index, threshold] of schedule.entries()) {
    if (daysOverdue >= threshold) stage = index;
  }

  return stage >= 0 ? { stage, daysOverdue } : null;
}
