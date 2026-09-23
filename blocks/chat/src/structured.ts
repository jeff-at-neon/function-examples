/**
 * Structured output helpers for /generate.
 *
 * The model is asked for JSON (via the AI Gateway's json_object mode), but "asked for JSON" is not
 * "returned valid JSON matching your shape". These pure helpers extract the JSON and run a
 * caller-supplied validator; the repair retry (feed the error back and ask once more) is wired in
 * index.ts, which is where the model call lives.
 */

export class StructuredParseError extends Error {
  override readonly name = "StructuredParseError";
}

/**
 * Extract a JSON value from model text.
 *
 * Handles the two things models do even in JSON mode: wrap the object in a ```json fence, or add
 * prose around it. Falls back to the first balanced `{...}` span before giving up.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    // Prose around the object: try the first balanced brace span.
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        // fall through
      }
    }
    throw new StructuredParseError(
      `Model output was not valid JSON: ${candidate.slice(0, 200)}`,
    );
  }
}

/** A validator turns an unknown parsed value into a typed one, throwing on a shape mismatch. */
export type Validator<T> = (value: unknown) => T;

/**
 * Parse then validate model text against the caller's shape.
 *
 * Kept generic rather than pulling in a schema library: a block should bundle small, and the
 * caller already owns the type it wants. A validator can be a hand-written check or a
 * `schema.parse` from any validation library the app already uses.
 */
export function validateStructured<T>(text: string, validate: Validator<T>): T {
  return validate(extractJson(text));
}

/**
 * A minimal validator: require the parsed value to be a plain object.
 *
 * The default when /generate is called without a caller-supplied shape. Real shape enforcement is
 * a TODO seam: pass a stricter Validator to validateStructured.
 */
export function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StructuredParseError("Expected a JSON object");
  }
  return value as Record<string, unknown>;
}
