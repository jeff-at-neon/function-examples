/**
 * Reciprocal Rank Fusion.
 *
 * The core of hybrid search, and pure so it can be tested exhaustively. RRF combines rankings from
 * retrievers whose scores are not comparable — pgvector cosine distance (0..2, lower better) and
 * Postgres `ts_rank` (unbounded, higher better) cannot be added, averaged, or min-max normalized
 * without one silently dominating.
 *
 * RRF sidesteps this by discarding scores and using only *rank position*:
 *
 *     score(d) = Σ over retrievers r of  weight_r / (k + rank_r(d))
 *
 * Properties that matter in practice:
 *   * scale-free — a retriever cannot dominate by having larger numbers
 *   * a document found by several retrievers outranks one found by a single retriever strongly,
 *     which is precisely the behaviour hybrid search is for
 *   * `k` damps the influence of top positions; k=60 is the value from the original Cormack et al.
 *     paper and is a sane default rather than a tuned one
 */

export interface RankedItem {
  /** Stable identity used to match the same document across retrievers. */
  id: string;
  /** 1-based position in that retriever's result list. */
  rank: number;
}

export interface RetrieverResult {
  name: string;
  items: readonly RankedItem[];
  /** Relative influence. 1 is neutral; raise to trust a retriever more. */
  weight?: number;
}

export interface FusedItem {
  id: string;
  score: number;
  /** Which retrievers found it, and at what rank. Kept for explainability and debugging. */
  contributions: { retriever: string; rank: number; weight: number; contribution: number }[];
}

/** Value from the original RRF paper. Not tuned — a deliberate, documented default. */
export const DEFAULT_RRF_K = 60;

/**
 * Fuse ranked lists.
 *
 * Ties break by id so results are deterministic; without that, two documents with identical scores
 * could swap places between identical queries, which makes pagination incoherent and tests flaky.
 */
export function reciprocalRankFusion(
  results: readonly RetrieverResult[],
  opts: { k?: number; limit?: number } = {},
): FusedItem[] {
  const k = opts.k ?? DEFAULT_RRF_K;
  if (k < 1) throw new Error(`RRF k must be >= 1, got ${k}`);

  const accumulated = new Map<string, FusedItem>();

  for (const result of results) {
    const weight = result.weight ?? 1;
    if (weight < 0) {
      throw new Error(`Retriever "${result.name}" has negative weight ${weight}`);
    }
    if (weight === 0) continue; // Disabled retriever; skip rather than add zeros.

    for (const item of result.items) {
      if (item.rank < 1) {
        throw new Error(
          `Retriever "${result.name}" returned rank ${item.rank} for "${item.id}"; ranks are 1-based`,
        );
      }

      const contribution = weight / (k + item.rank);
      const existing = accumulated.get(item.id);

      if (existing) {
        existing.score += contribution;
        existing.contributions.push({
          retriever: result.name,
          rank: item.rank,
          weight,
          contribution,
        });
      } else {
        accumulated.set(item.id, {
          id: item.id,
          score: contribution,
          contributions: [{ retriever: result.name, rank: item.rank, weight, contribution }],
        });
      }
    }
  }

  const fused = [...accumulated.values()].sort(
    (a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  return opts.limit === undefined ? fused : fused.slice(0, opts.limit);
}

/** Attach 1-based ranks to an already-ordered list of ids. */
export function toRanked(ids: readonly string[]): RankedItem[] {
  return ids.map((id, index) => ({ id, rank: index + 1 }));
}

/**
 * Build a `websearch_to_tsquery`-safe query string.
 *
 * `websearch_to_tsquery` is used rather than `to_tsquery` because it never raises on user input —
 * `to_tsquery('a & & b')` throws a syntax error, and a search box that 500s on a stray ampersand is
 * a bad search box. This only trims and bounds length; Postgres handles the rest.
 */
export function normalizeSearchQuery(query: string, maxLength = 1_000): string {
  const trimmed = query.trim().replace(/\s+/g, " ");
  if (trimmed === "") throw new Error("Search query is empty");
  return trimmed.slice(0, maxLength);
}

/**
 * Whether a query is short enough that trigram matching should be added.
 *
 * Trigram similarity is what catches typos ("recieve" → "receive"), but it is expensive over large
 * tables and adds little for long queries, where full-text already has enough signal. Applying it
 * selectively keeps the cost where the benefit is.
 */
export function shouldUseTrigram(query: string, maxWords = 4): boolean {
  const words = query.trim().split(/\s+/).filter((w) => w.length > 0);
  return words.length > 0 && words.length <= maxWords;
}
