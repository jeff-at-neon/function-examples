/**
 * Classification logic. Pure and unit tested: threshold parsing, prompt building, tolerant score
 * parsing, and the per-category decision. The model call is the thin edge in run.ts. Fail-closed is
 * enforced by the caller (items start quarantined); this module only decides approve/block/review.
 */

/** How close to the threshold still warrants human review rather than an automatic approve. */
const REVIEW_MARGIN = 0.1;

/** Parse the MODERATION_THRESHOLDS JSON object; every value must be a number in [0, 1]. */
export function parseThresholds(raw: string): Record<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`MODERATION_THRESHOLDS is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error('MODERATION_THRESHOLDS must be a JSON object, e.g. {"adult":0.5}');
  }
  const out: Record<string, number> = {};
  for (const [category, value] of Object.entries(parsed)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`MODERATION_THRESHOLDS["${category}"] must be a number in [0, 1]`);
    }
    out[category] = value;
  }
  return out;
}

function categoryList(thresholds: Record<string, number>): string {
  return Object.keys(thresholds).join(", ");
}

export function buildImagePrompt(thresholds: Record<string, number>): { system: string; userText: string } {
  return {
    system:
      "You are a content-moderation classifier. Return ONLY a JSON object mapping each category to " +
      "a probability between 0 and 1 that the content violates it. No prose.",
    userText: `Score this image for these categories: ${categoryList(thresholds)}.`,
  };
}

export function buildTextPrompt(thresholds: Record<string, number>): { system: string; userText: string } {
  return {
    system:
      "You are a content-moderation classifier. Return ONLY a JSON object mapping each category to " +
      "a probability between 0 and 1 that the text violates it. No prose.",
    userText: `Score this text for these categories: ${categoryList(thresholds)}.`,
  };
}

/** Tolerant parse of a model response into category -> score, clamped to [0, 1]. */
export function extractScores(text: string): Record<string, number> {
  const withoutFences = text.replace(/```(?:json)?/gi, "");
  const start = withoutFences.indexOf("{");
  const end = withoutFences.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutFences.slice(start, end + 1));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const scores: Record<string, number> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) scores[k] = Math.min(1, Math.max(0, n));
  }
  return scores;
}

export interface Decision {
  status: "approved" | "blocked" | "needs_review";
  decision: "approve" | "block" | "escalate";
  flagged: string[];
}

/**
 * Decide per category. Any score at or above its threshold blocks (fail-closed). A score within
 * REVIEW_MARGIN below its threshold is borderline and escalated to human review. Otherwise approve.
 * A category with no configured threshold is ignored.
 */
export function decide(scores: Record<string, number>, thresholds: Record<string, number>): Decision {
  const flagged: string[] = [];
  let borderline = false;
  for (const [category, threshold] of Object.entries(thresholds)) {
    const score = scores[category] ?? 0;
    if (score >= threshold) flagged.push(category);
    else if (score >= threshold - REVIEW_MARGIN) borderline = true;
  }
  if (flagged.length > 0) return { status: "blocked", decision: "block", flagged };
  if (borderline) return { status: "needs_review", decision: "escalate", flagged };
  return { status: "approved", decision: "approve", flagged };
}
