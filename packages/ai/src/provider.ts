/**
 * Provider interfaces.
 *
 * Convention §9: AI Gateway by default (credentials auto-injected, zero config), adapters as
 * the escape hatch. A block that only works with one vendor's key is not reusable.
 *
 * Dimensions are part of the embedding contract because pgvector columns are fixed-width:
 * switching embedding models is a migration, not a config change, and a block that lets you
 * silently change model produces a table of mutually incomparable vectors.
 */

export interface EmbeddingResult {
  vectors: number[][];
  model: string;
  dimensions: number;
  /** Absent when the provider doesn't report usage. */
  totalTokens?: number;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  /** Max inputs per call. Callers must chunk to this. */
  readonly maxBatchSize: number;
  embed(texts: readonly string[]): Promise<EmbeddingResult>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | readonly ContentPart[];
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; imageUrl: { url: string; detail?: "low" | "high" | "auto" } };

export interface ChatResult {
  text: string;
  model: string;
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  /** Ask for a JSON object back. Providers that can't enforce it fall back to prompting. */
  jsonMode?: boolean;
  timeoutMs?: number;
}

export interface ChatProvider {
  readonly name: string;
  readonly model: string;
  chat(messages: readonly ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
}

export class AiError extends Error {
  override readonly name = "AiError";
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/**
 * Split a list into provider-sized batches.
 *
 * Exists because forgetting it produces a 400 only once a user embeds a large document — i.e.
 * in production, not in the demo.
 */
export function batched<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error(`Batch size must be >= 1, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size) as T[]);
  }
  return out;
}
