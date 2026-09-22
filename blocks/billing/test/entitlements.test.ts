import { describe, expect, it } from "vitest";
import {
  billingPeriodFor,
  checkQuota,
  dunningStage,
  evaluateAccess,
  hasFeature,
  type PlanFeatures,
  type Subscription,
} from "../src/entitlements.js";

const NOW = new Date("2026-09-22T12:00:00Z");
const days = (n: number): Date => new Date(NOW.getTime() + n * 86_400_000);

const sub = (over: Partial<Subscription> = {}): Subscription => ({
  status: "active",
  planCode: "pro",
  currentPeriodEnd: days(10),
  cancelAt: null,
  trialEnd: null,
  ...over,
});

const plan: PlanFeatures = {
  features: ["api_access", "export"],
  limits: { seats: 5, api_calls: 10_000, storage_gb: null },
};

describe("evaluateAccess", () => {
  it("allows an active subscription", () => {
    expect(evaluateAccess(sub(), NOW)).toEqual({ allowed: true, reason: "active" });
  });

  it("denies when there is no subscription", () => {
    expect(evaluateAccess(null, NOW)).toEqual({ allowed: false, reason: "no subscription" });
  });

  it("allows a live trial", () => {
    expect(evaluateAccess(sub({ status: "trialing", trialEnd: days(5) }), NOW)).toEqual({
      allowed: true,
      reason: "trialing",
    });
  });

  // Trusting a stale 'trialing' status would mean an indefinite free trial whenever the
  // status-change webhook is missed.
  it("denies a lapsed trial even if the status was never updated", () => {
    const result = evaluateAccess(sub({ status: "trialing", trialEnd: days(-1) }), NOW);
    expect(result).toEqual({ allowed: false, reason: "trial ended" });
  });

  // The case most implementations get wrong. A failed payment is usually an expired card, not a
  // churn decision; cutting access instantly turns a recoverable problem into a lost customer.
  it("keeps access during the grace period after a failed payment", () => {
    const result = evaluateAccess(sub({ status: "past_due", currentPeriodEnd: days(-1) }), NOW);
    expect(result).toEqual({ allowed: true, reason: "grace_period" });
  });

  it("denies once the grace period expires", () => {
    const result = evaluateAccess(sub({ status: "past_due", currentPeriodEnd: days(-10) }), NOW);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toMatch(/payment overdue since/);
  });

  it("respects a custom grace window", () => {
    const overdue = sub({ status: "past_due", currentPeriodEnd: days(-5) });
    expect(evaluateAccess(overdue, NOW, 3).allowed).toBe(false);
    expect(evaluateAccess(overdue, NOW, 10).allowed).toBe(true);
  });

  it("denies past_due with no recorded period end, since no grace window is computable", () => {
    const result = evaluateAccess(sub({ status: "past_due", currentPeriodEnd: null }), NOW);
    expect(result).toEqual({ allowed: false, reason: "subscription is past_due" });
  });

  // They paid for the period; a scheduled cancellation must not revoke access early.
  it("allows a cancelled subscription until the paid period ends", () => {
    expect(evaluateAccess(sub({ status: "canceled", currentPeriodEnd: days(5) }), NOW).allowed).toBe(
      true,
    );
    expect(
      evaluateAccess(sub({ status: "canceled", currentPeriodEnd: days(-5) }), NOW).allowed,
    ).toBe(false);
  });

  it("allows an active subscription with a pending cancellation", () => {
    expect(evaluateAccess(sub({ cancelAt: days(5) }), NOW).allowed).toBe(true);
  });

  it("denies paused and incomplete", () => {
    expect(evaluateAccess(sub({ status: "paused" }), NOW).allowed).toBe(false);
    expect(evaluateAccess(sub({ status: "incomplete" }), NOW).allowed).toBe(false);
  });
});

describe("hasFeature", () => {
  const allowed = evaluateAccess(sub(), NOW);

  it("allows a granted feature", () => {
    expect(hasFeature(plan, "api_access", allowed)).toEqual({ allowed: true });
  });

  // Two different messages for the user: "upgrade your plan" vs "fix your card".
  it("marks a missing feature as needing an upgrade", () => {
    const result = hasFeature(plan, "sso", allowed);
    expect(result).toMatchObject({ allowed: false, upgradeRequired: true });
  });

  it("does not suggest an upgrade when the problem is billing, not the plan", () => {
    const denied = evaluateAccess(sub({ status: "past_due", currentPeriodEnd: days(-30) }), NOW);
    const result = hasFeature(plan, "api_access", denied);
    expect(result).toMatchObject({ allowed: false, upgradeRequired: false });
  });

  it("denies when no plan is configured", () => {
    expect(hasFeature(null, "api_access", allowed)).toMatchObject({
      allowed: false,
      upgradeRequired: true,
    });
  });
});

describe("checkQuota", () => {
  const allowed = evaluateAccess(sub(), NOW);

  it("allows usage under the limit and reports what remains", () => {
    expect(checkQuota(plan, "seats", 3, allowed)).toEqual({
      allowed: true,
      remaining: 1,
      limit: 5,
    });
  });

  it("denies at the limit", () => {
    const result = checkQuota(plan, "seats", 5, allowed);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toMatch(/quota exceeded.*5 used of 5/);
  });

  // null means unlimited; absent means not granted. Conflating them either blocks paying customers
  // or gives usage away.
  it("treats a null limit as unlimited", () => {
    expect(checkQuota(plan, "storage_gb", 999_999, allowed)).toEqual({
      allowed: true,
      remaining: null,
      limit: null,
    });
  });

  it("treats an absent metric as not granted, not unlimited", () => {
    const result = checkQuota(plan, "video_minutes", 0, allowed);
    expect(result).toMatchObject({ allowed: false, upgradeRequired: true });
    if (!result.allowed) expect(result.reason).toMatch(/does not include metric/);
  });

  // Checking one at a time and hitting the limit halfway through a 500-row import is worse than
  // refusing the batch upfront.
  it("checks a whole batch at once", () => {
    expect(checkQuota(plan, "seats", 3, allowed, 2).allowed).toBe(true);
    expect(checkQuota(plan, "seats", 3, allowed, 3).allowed).toBe(false);
  });

  it("denies everything when access itself is denied", () => {
    const denied = evaluateAccess(null, NOW);
    expect(checkQuota(plan, "seats", 0, denied)).toMatchObject({
      allowed: false,
      upgradeRequired: false,
    });
  });

  // An explicit `undefined` is ambiguous between "unlimited" and "not granted", and silently
  // picking either is a billing bug. Refusing is the only safe answer.
  it("refuses an explicitly-undefined limit rather than guessing", () => {
    const ambiguous = {
      features: [],
      limits: { seats: undefined } as unknown as Record<string, number | null>,
    };
    expect(() => checkQuota(ambiguous, "seats", 0, allowed)).toThrow(
      /undefined is ambiguous between the two/,
    );
  });
});

describe("billingPeriodFor", () => {
  const start = new Date("2026-09-17T00:00:00Z");
  const end = new Date("2026-10-17T00:00:00Z");

  // Calendar months for a subscription renewing on the 17th produce totals matching no invoice,
  // which cannot be reconciled with a customer.
  it("anchors to the subscription period, not the calendar month", () => {
    expect(billingPeriodFor(NOW, start, end)).toEqual({ start, end });
  });

  it("returns null outside the period", () => {
    expect(billingPeriodFor(new Date("2026-09-16T23:59:59Z"), start, end)).toBeNull();
    expect(billingPeriodFor(new Date("2026-10-17T00:00:00Z"), start, end)).toBeNull();
  });

  it("treats the period as half-open, so adjacent periods never double-count", () => {
    expect(billingPeriodFor(start, start, end)).not.toBeNull();
    expect(billingPeriodFor(end, start, end)).toBeNull();
  });
});

describe("dunningStage", () => {
  it("returns null for a healthy subscription", () => {
    expect(dunningStage(sub(), NOW)).toBeNull();
  });

  it("returns stage 0 on the day payment becomes overdue", () => {
    expect(dunningStage(sub({ status: "past_due", currentPeriodEnd: NOW }), NOW)).toEqual({
      stage: 0,
      daysOverdue: 0,
    });
  });

  it("escalates through the schedule", () => {
    const at = (d: number) =>
      dunningStage(sub({ status: "past_due", currentPeriodEnd: days(-d) }), NOW)?.stage;
    expect(at(1)).toBe(0);
    expect(at(3)).toBe(1);
    expect(at(8)).toBe(2);
    expect(at(30)).toBe(3);
  });

  // A gap in cron runs must not skip a notice: the highest threshold reached wins.
  it("uses the highest threshold reached, so a missed run does not skip a stage", () => {
    expect(dunningStage(sub({ status: "past_due", currentPeriodEnd: days(-20) }), NOW)).toEqual({
      stage: 3,
      daysOverdue: 20,
    });
  });

  it("returns null before the period has ended", () => {
    expect(dunningStage(sub({ status: "past_due", currentPeriodEnd: days(5) }), NOW)).toBeNull();
  });

  it("respects a custom schedule", () => {
    const result = dunningStage(
      sub({ status: "unpaid", currentPeriodEnd: days(-2) }),
      NOW,
      [0, 1, 2],
    );
    expect(result?.stage).toBe(2);
  });
});
