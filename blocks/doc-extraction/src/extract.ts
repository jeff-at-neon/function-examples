/**
 * Extraction logic. All pure and unit tested: the prompt generation, the tolerant JSON parse
 * (mirroring the vision block — models wrap JSON in fences and prose), and the confidence split
 * that routes low-confidence fields to human review. The model call itself is the thin edge in
 * run.ts.
 */

export interface FieldSpec {
  type?: string;
  description?: string;
  required?: boolean;
}
export type SchemaFields = Record<string, FieldSpec>;

/** The document type is the first path segment after the prefix: `documents/invoice/x.png` -> `invoice`. */
export function schemaCodeFromKey(objectKey: string, prefix: string): string | null {
  const rest = objectKey.startsWith(prefix) ? objectKey.slice(prefix.length) : objectKey;
  const segment = rest.split("/").filter((s) => s !== "")[0];
  return segment ?? null;
}

export interface ExtractionPrompt {
  system: string;
  userText: string;
}

/** Build the extraction instructions from a schema's fields. Each field's description is prompt text. */
export function buildExtractionPrompt(fields: SchemaFields): ExtractionPrompt {
  const lines = Object.entries(fields).map(([name, spec]) => {
    const type = spec.type ? ` (${spec.type}${spec.required ? ", required" : ""})` : "";
    return `- ${name}${type}: ${spec.description ?? ""}`.trimEnd();
  });
  return {
    system:
      "You extract structured data from a document image. Return ONLY a JSON object mapping each " +
      'requested field to {"value": <extracted value or null>, "confidence": <number 0..1>}. Use ' +
      "null and confidence 0 for any field you cannot find. Do not wrap the JSON in prose.",
    userText: `Extract these fields:\n${lines.join("\n")}`,
  };
}

/** Tolerant JSON extraction: strips code fences and surrounding prose, then parses the object. */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const withoutFences = text.replace(/```(?:json)?/gi, "");
  const start = withoutFences.indexOf("{");
  const end = withoutFences.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  const candidate = withoutFences.slice(start, end + 1);
  try {
    const parsed = JSON.parse(candidate);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export interface FieldReview {
  field: string;
  value: unknown;
  confidence: number;
}
export interface SplitResult {
  values: Record<string, unknown>;
  confidence: Record<string, number>;
  review: FieldReview[];
  status: "ready" | "needs_review";
}

/**
 * Split extracted fields into applied vs. needs-review by per-field confidence. A field below the
 * threshold, or missing entirely, goes to review — which is what makes the block save labour rather
 * than relocate it. Confidence is read per field, never one document-level score.
 */
export function splitByConfidence(
  fields: SchemaFields,
  parsed: Record<string, unknown>,
  threshold: number,
): SplitResult {
  const values: Record<string, unknown> = {};
  const confidence: Record<string, number> = {};
  const review: FieldReview[] = [];

  for (const field of Object.keys(fields)) {
    const entry = parsed[field];
    let value: unknown = null;
    let conf = 0;
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const e = entry as Record<string, unknown>;
      value = e["value"] ?? null;
      conf = typeof e["confidence"] === "number" ? e["confidence"] : 0;
    } else if (entry !== undefined) {
      // Model returned a bare value without confidence — treat as unconfirmed.
      value = entry;
      conf = 0;
    }
    values[field] = value;
    confidence[field] = conf;
    if (value === null || conf < threshold) {
      review.push({ field, value, confidence: conf });
    }
  }

  return { values, confidence, review, status: review.length > 0 ? "needs_review" : "ready" };
}
