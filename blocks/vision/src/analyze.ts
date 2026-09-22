/**
 * Vision analysis: tags, caption, alt text, OCR.
 *
 * Economically the most attractive AI block in the catalog. It is network-bound — the function is
 * *waiting* on the model, billed at $0.025/Capacity-Hour rather than the $0.10 active rate — so the
 * per-image compute cost is close to nothing and the model call dominates. Compare block 23
 * (thumbnails), which is CPU-bound and pays the active rate for real work.
 *
 * The prompt construction and response parsing are pure and separately testable, because a model
 * that returns almost-JSON is the normal case rather than the exception.
 */

import { AiError, type ChatProvider, type ContentPart } from "@neon-blocks/ai";

export interface AnalysisRequest {
  /** Presigned GET URL. Models fetch the image themselves; we never proxy the bytes. */
  imageUrl: string;
  /** Which outputs to request. Fewer means cheaper and faster. */
  want: readonly AnalysisKind[];
  /** Hint for alt text and captions. */
  context?: string;
  maxTags?: number;
}

export type AnalysisKind = "tags" | "caption" | "altText" | "ocr" | "colors";

export interface Analysis {
  tags: string[];
  caption: string | null;
  /** Accessibility alt text. Distinct from caption: describes function, not scene. */
  altText: string | null;
  ocrText: string | null
  dominantColors: string[];
  /** Model self-reported confidence, 0..1. Advisory only. */
  confidence: number | null;
  model: string;
}

/**
 * Build the vision prompt.
 *
 * One call requesting every wanted field rather than one call per field: the image tokens dominate
 * the cost, so five separate calls means paying for the image five times.
 */
export function buildPrompt(request: AnalysisRequest): { system: string; parts: ContentPart[] } {
  const maxTags = request.maxTags ?? 12;
  const fields: string[] = [];

  if (request.want.includes("tags")) {
    fields.push(
      `"tags": up to ${maxTags} lowercase single-or-two-word labels for objects, setting, and ` +
        `style. Concrete and searchable, not interpretive.`,
    );
  }
  if (request.want.includes("caption")) {
    fields.push(`"caption": one descriptive sentence, under 200 characters.`);
  }
  if (request.want.includes("altText")) {
    // Alt text and captions are genuinely different artifacts and models conflate them unless told
    // not to. A caption adds information; alt text substitutes for the image.
    fields.push(
      `"altText": accessibility alt text under 125 characters. Describe what a screen-reader user ` +
        `needs to understand the image's purpose in context. Do not begin with "image of" or ` +
        `"picture of". If the image is purely decorative, use an empty string.`,
    );
  }
  if (request.want.includes("ocr")) {
    fields.push(
      `"ocrText": all text visible in the image, verbatim, preserving reading order. Null if none.`,
    );
  }
  if (request.want.includes("colors")) {
    fields.push(`"dominantColors": up to 5 hex colour codes, most prominent first.`);
  }

  fields.push(`"confidence": your confidence in this analysis, 0 to 1.`);

  const system =
    `You analyse images and return only JSON. No markdown fence, no commentary.\n\n` +
    `Return an object with exactly these keys:\n${fields.map((f) => `- ${f}`).join("\n")}\n\n` +
    `Omit no key. Use null for fields you cannot determine.`;

  const parts: ContentPart[] = [
    {
      type: "text",
      text: request.context
        ? `Analyse this image. Context: ${request.context}`
        : "Analyse this image.",
    },
    // "low" detail would halve the token cost but loses small text, so OCR requests get high
    // detail and everything else takes the default.
    {
      type: "image_url",
      imageUrl: { url: request.imageUrl, detail: request.want.includes("ocr") ? "high" : "auto" },
    },
  ];

  return { system, parts };
}

/**
 * Parse a model response into a typed analysis.
 *
 * Tolerant by design. Models wrap JSON in markdown fences, prepend "Here is the analysis:", and
 * occasionally return a string where an array was asked for. Every one of those is recoverable, and
 * failing the whole ingestion over a stray fence would be absurd.
 */
export function parseAnalysis(text: string, model: string): Analysis {
  const json = extractJsonObject(text);
  if (!json) {
    throw new AiError(
      `Vision model did not return a JSON object. First 200 characters: ${text.slice(0, 200)}`,
      undefined,
      // Retryable: usually a transient formatting lapse rather than a permanent failure.
      true,
    );
  }

  return {
    tags: normalizeTags(json["tags"]),
    caption: asNonEmptyString(json["caption"]),
    altText: asAltText(json["altText"]),
    ocrText: asNonEmptyString(json["ocrText"]),
    dominantColors: normalizeColors(json["dominantColors"]),
    confidence: asConfidence(json["confidence"]),
    model,
  };
}

/** Pull the first balanced JSON object out of arbitrary text. */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();

  // Fast path: already clean JSON.
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Fall through to brace scanning — likely trailing prose after valid JSON.
    }
  }

  // Scan for a balanced object, respecting strings and escapes so a `}` inside a caption does not
  // truncate the match. A regex cannot do this correctly.
  const start = trimmed.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < trimmed.length; i++) {
    const char = trimmed[i]!;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(trimmed.slice(start, i + 1));
          return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

/**
 * Normalize tags.
 *
 * Models return arrays, comma-separated strings, or arrays containing nulls. All three are handled
 * because rejecting them would discard a perfectly good analysis over formatting.
 */
export function normalizeTags(value: unknown, maxTags = 24): string[] {
  const raw: unknown[] = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];

  const seen = new Set<string>();
  const tags: string[] = [];

  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const tag = entry.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 64);
    // Deduplicated case-insensitively: "Dog" and "dog" are one tag, and storing both makes facet
    // counts wrong.
    if (tag === "" || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= maxTags) break;
  }

  return tags;
}

/** Keep only valid hex colours, normalized to lowercase 6-digit form. */
export function normalizeColors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const colors: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const match = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(entry.trim());
    if (!match) continue;

    const hex = match[1]!.toLowerCase();
    // Expand shorthand so stored values are comparable: #f00 and #ff0000 are the same colour and
    // should not be two distinct rows.
    colors.push(
      `#${hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex}`,
    );
    if (colors.length >= 8) break;
  }
  return colors;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.slice(0, 4_000);
}

/**
 * Alt text, preserving the empty string.
 *
 * An empty string is meaningful here and must not become null: `alt=""` is the correct markup for a
 * decorative image, and is different from having no alt attribute at all. Conflating them is an
 * accessibility regression.
 */
function asAltText(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const cleaned = value
    .trim()
    // Models add these despite instructions, and screen readers already announce "image".
    .replace(/^(an?\s+)?(image|picture|photo|photograph|screenshot)\s+(of|showing|depicting)\s+/i, "")
    .slice(0, 500);

  return cleaned;
}

function asConfidence(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  // Some models report 0-100 despite being asked for 0-1.
  const normalized = parsed > 1 ? parsed / 100 : parsed;
  return Math.max(0, Math.min(1, normalized));
}

/** Run one analysis. */
export async function analyzeImage(
  chat: ChatProvider,
  request: AnalysisRequest,
): Promise<Analysis> {
  const { system, parts } = buildPrompt(request);

  const result = await chat.chat(
    [
      { role: "system", content: system },
      { role: "user", content: parts },
    ],
    // jsonMode where the provider supports it; the tolerant parser covers providers that ignore it.
    { jsonMode: true, maxTokens: 1_500, temperature: 0 },
  );

  return parseAnalysis(result.text, result.model);
}
