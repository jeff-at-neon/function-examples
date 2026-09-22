/**
 * Text extraction.
 *
 * Deliberately honest about what is and isn't implemented. Plain text, markdown, HTML, CSV and
 * JSON are handled properly here with no dependencies. PDF and DOCX need real parsers, and this
 * module reports that as an explicit `needsParser` outcome rather than returning empty text and
 * letting the document land in `ready` with zero chunks — a silent success is far worse than a
 * clear "not yet".
 *
 * On cost: extraction is CPU-bound, and at 4× the waiting rate (not 40×, as the free tier's
 * 10:400 quota split misleadingly suggests) in-function parsing is economically fine. Roughly
 * $0.10 per active Capacity-Hour means a second of parsing costs about $0.00003.
 */

import { detectKind, type ObjectKind } from "@neon-blocks/storage";

export type ExtractOutcome =
  | { status: "extracted"; text: string; kind: ObjectKind }
  /** Recognised but unsupported without a parser dependency. */
  | { status: "needsParser"; kind: ObjectKind; parser: string; reason: string }
  /** Not a document; the router should not have sent it, or the prefix is too broad. */
  | { status: "skipped"; kind: ObjectKind; reason: string };

export interface ExtractOptions {
  key: string;
  contentType?: string;
  body: Uint8Array;
  /** Refuse to extract more than this many characters of text. */
  maxChars?: number;
}

/** Text kinds we can handle with zero dependencies. */
const NATIVE_TEXT: readonly ObjectKind[] = ["text", "data", "spreadsheet"];

export function extractText(opts: ExtractOptions): ExtractOutcome {
  const maxChars = opts.maxChars ?? 5_000_000;
  const kind = detectKind({
    key: opts.key,
    ...(opts.contentType ? { contentType: opts.contentType } : {}),
    head: opts.body.subarray(0, 16),
  });

  if (kind === "pdf") {
    return {
      status: "needsParser",
      kind,
      parser: "pdf",
      reason:
        "PDF text extraction requires a parser (e.g. unpdf, which is WASM and bundles cleanly " +
        "with the default esbuild path). Wire it into extractText() — CPU cost is not the " +
        "blocker, the dependency is.",
    };
  }

  if (kind === "document") {
    return {
      status: "needsParser",
      kind,
      parser: "docx",
      reason:
        "DOCX/ODT extraction requires a parser (e.g. mammoth). Not bundled by default to keep " +
        "the install one command.",
    };
  }

  if (!NATIVE_TEXT.includes(kind)) {
    return {
      status: "skipped",
      kind,
      reason:
        `${kind} is not a text-bearing document. Storage triggers have no suffix filter, so ` +
        `non-documents under the watched prefix reach this handler and are recorded as skipped.`,
    };
  }

  const decoded = decodeUtf8(opts.body);
  const text = normalizeText(
    kind === "text" && looksLikeHtml(decoded) ? stripHtml(decoded) : decoded,
  );

  if (text.trim() === "") {
    return { status: "skipped", kind, reason: "file decoded to empty text" };
  }

  return {
    status: "extracted",
    kind,
    // Truncation is bounded and reported by the caller via token_estimate; the alternative is
    // an OOM on a fixed-size function.
    text: text.length > maxChars ? text.slice(0, maxChars) : text,
  };
}

/**
 * Decode UTF-8, tolerating invalid bytes.
 *
 * Non-fatal on purpose: a single bad byte in a 50 MB log file should not fail the whole
 * ingestion. Replacement characters are preferable to a hard error here.
 */
function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 1_000).toLowerCase();
  return head.includes("<!doctype html") || head.includes("<html") || /<(p|div|body)[\s>]/.test(head);
}

/**
 * Strip HTML to readable text.
 *
 * Regex-based, which is famously not a general HTML parser — but the failure mode here is
 * slightly imperfect text rather than a security hole, and avoiding a parser dependency keeps
 * the block inside the default bundle (convention §12). Script and style content is removed
 * first, because embedding minified JavaScript actively poisons retrieval.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Block-level closers become paragraph breaks so the chunker has real boundaries to split
    // on rather than one undifferentiated wall of text.
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

/** Collapse whitespace while preserving paragraph structure, which the chunker splits on. */
export function normalizeText(text: string): string {
  return (
    text
      .replace(/\r\n/g, "\n")
      // Unicode spaces are folded to ordinary ones. Written as escapes deliberately: a literal
      // NBSP here would be invisible in the source, and replacing it with "" rather than " "
      // welds adjacent words together ("a b" -> "ab"), corrupting both chunk text and retrieval.
      .replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, " ")
      // Zero-width characters carry no meaning and survive as mojibake, so drop them outright.
      .replace(/[\u200b-\u200d\ufeff]/g, "")
      // Three or more newlines collapse to a paragraph break; two are meaningful, ten are not.
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .trim()
  );
}
