/**
 * pgvector interop.
 *
 * pgvector's text input format is `[1,2,3]`. Passing a JS array through `pg` yields
 * `{1,2,3}` (Postgres array syntax), which pgvector rejects — so vectors are always sent as
 * an explicit string literal.
 */

export function toVectorLiteral(vector: readonly number[]): string {
  if (vector.length === 0) throw new Error("Cannot store an empty vector");

  // NaN or Infinity reaches Postgres as an unparseable literal; the resulting error mentions
  // syntax rather than the real cause, so check here where the message can be useful.
  for (const [i, value] of vector.entries()) {
    if (!Number.isFinite(value)) {
      throw new Error(
        `Vector element ${i} is ${value}, which pgvector cannot store. ` +
          `This usually means the embedding provider returned a malformed response.`,
      );
    }
  }

  return `[${vector.join(",")}]`;
}

export function parseVectorLiteral(literal: string): number[] {
  const trimmed = literal.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new Error(`Not a pgvector literal: ${literal.slice(0, 40)}`);
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((part) => {
    const value = Number(part);
    if (Number.isNaN(value)) throw new Error(`Bad vector element: ${part}`);
    return value;
  });
}

/**
 * Cosine similarity, for tests and in-memory reranking.
 *
 * Retrieval itself uses pgvector's `<=>` operator so the index is actually used; doing it in
 * JS would mean fetching every row, which defeats the point of having an index.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
