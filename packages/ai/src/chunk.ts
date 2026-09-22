/**
 * Text chunking for embedding.
 *
 * Pure and dependency-free so it can be unit tested exhaustively. Chunking quality is the
 * single biggest determinant of RAG answer quality — far more than embedding model choice —
 * and the failure mode is silent: bad chunks produce plausible retrievals that miss the point.
 *
 * Strategy: split on the largest semantic boundary that fits, falling back through paragraph →
 * sentence → word → hard character cut. Overlap carries context across boundaries so a fact
 * spanning two chunks is retrievable from either.
 */

export interface ChunkOptions {
  /** Target size in characters. Not tokens — see `approxTokens`. */
  maxChars: number;
  /** Characters of trailing context repeated at the start of the next chunk. */
  overlapChars: number;
  /** Chunks shorter than this are merged into the previous one. */
  minChars: number;
}

export const DEFAULT_CHUNKING: ChunkOptions = {
  // ~1000 chars ≈ 250 tokens: comfortably inside every embedding model's window, and small
  // enough that a retrieved chunk is mostly signal rather than surrounding noise.
  maxChars: 1_000,
  overlapChars: 150,
  minChars: 80,
};

export interface Chunk {
  text: string;
  /** Position in the source document, 0-based. Stored so chunks can be re-assembled in order. */
  index: number;
  /** Character offset in the original text, for citation and highlighting. */
  startOffset: number;
  endOffset: number;
}

/** Rough token estimate. English averages ~4 characters per token. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const PARAGRAPH_BREAK = /\n\s*\n/;
// Sentence end followed by whitespace. Not linguistically perfect, but wrong only on
// abbreviations, where the cost is a slightly odd split rather than lost content.
const SENTENCE_END = /(?<=[.!?])\s+/;

export function chunkText(text: string, options: Partial<ChunkOptions> = {}): Chunk[] {
  const opts = { ...DEFAULT_CHUNKING, ...options };
  if (opts.overlapChars >= opts.maxChars) {
    throw new Error(
      `overlapChars (${opts.overlapChars}) must be less than maxChars (${opts.maxChars}); ` +
        `otherwise chunking cannot make progress and would loop forever.`,
    );
  }

  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized === "") return [];
  if (normalized.length <= opts.maxChars) {
    return [{ text: normalized, index: 0, startOffset: 0, endOffset: normalized.length }];
  }

  const pieces = splitRecursive(normalized, opts.maxChars);
  const chunks: Chunk[] = [];
  let buffer = "";
  let bufferStart = 0;
  let cursor = 0;

  const flush = (): void => {
    const trimmed = buffer.trim();
    if (trimmed === "") return;

    // Merge a runt into its predecessor rather than emitting a chunk too small to carry
    // meaning — a 20-character chunk embeds to noise and pollutes retrieval.
    const previous = chunks[chunks.length - 1];
    if (trimmed.length < opts.minChars && previous) {
      previous.text = `${previous.text} ${trimmed}`.trim();
      previous.endOffset = bufferStart + buffer.length;
      return;
    }

    chunks.push({
      text: trimmed,
      index: chunks.length,
      startOffset: bufferStart,
      endOffset: bufferStart + buffer.length,
    });
  };

  for (const piece of pieces) {
    if (buffer !== "" && buffer.length + piece.length + 1 > opts.maxChars) {
      flush();
      const tail = opts.overlapChars > 0 ? buffer.slice(-opts.overlapChars) : "";
      buffer = tail === "" ? "" : `${tail} `;
      bufferStart = cursor - tail.length;
    }
    if (buffer === "") bufferStart = cursor;
    buffer += piece;
    cursor += piece.length;
  }
  flush();

  return chunks.map((chunk, index) => ({ ...chunk, index }));
}

/**
 * Break text into units no larger than `limit`, preferring semantic boundaries.
 *
 * Each level only applies where the coarser one left an oversized piece, so ordinary prose
 * splits on paragraphs and only a pathological wall of text reaches the character cut.
 */
function splitRecursive(text: string, limit: number): string[] {
  const out: string[] = [];

  for (const paragraph of splitKeeping(text, PARAGRAPH_BREAK, "\n\n")) {
    if (paragraph.length <= limit) {
      out.push(paragraph);
      continue;
    }
    for (const sentence of splitKeeping(paragraph, SENTENCE_END, " ")) {
      if (sentence.length <= limit) {
        out.push(sentence);
        continue;
      }
      for (const word of sentence.split(/(?<=\s)/)) {
        if (word.length <= limit) {
          out.push(word);
          continue;
        }
        // Last resort: a single token longer than the limit (minified JS, a base64 blob, a
        // URL). Hard-cut it — better a mechanical split than dropping content.
        for (let i = 0; i < word.length; i += limit) {
          out.push(word.slice(i, i + limit));
        }
      }
    }
  }

  return out.filter((piece) => piece !== "");
}

/** Split on a separator, re-appending a canonical form so offsets stay roughly aligned. */
function splitKeeping(text: string, separator: RegExp, rejoin: string): string[] {
  const parts = text.split(separator);
  return parts.map((part, i) => (i < parts.length - 1 ? part + rejoin : part));
}
