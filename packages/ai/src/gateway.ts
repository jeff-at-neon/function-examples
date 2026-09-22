/**
 * Neon AI Gateway adapter — the zero-config default.
 *
 * Neon injects gateway credentials into the function environment and bills through prepaid
 * credits, so a block using this needs no user-supplied API key at all. That is the single
 * biggest reason to default here rather than to OpenAI: it removes a signup step from every
 * install.
 *
 * The wire format is OpenAI-compatible, so this same adapter serves any compatible endpoint by
 * overriding the base URL.
 */

import { AiError, batched, type ChatMessage, type ChatOptions, type ChatProvider, type ChatResult, type EmbeddingProvider, type EmbeddingResult } from "./provider.js";
import { isRetryableStatus } from "@neon-blocks/core";

export interface GatewayConfig {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

/**
 * Resolve gateway config from the environment.
 *
 * Accepts several env var spellings because the exact names Neon injects are not yet pinned
 * down in public docs; falling back to OPENAI_* means a user can point a block at any
 * compatible endpoint without code changes.
 */
export function gatewayConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const baseUrl =
    env["NEON_AI_GATEWAY_URL"] ??
    env["AI_GATEWAY_BASE_URL"] ??
    env["OPENAI_BASE_URL"] ??
    undefined;
  const apiKey =
    env["NEON_AI_GATEWAY_API_KEY"] ?? env["AI_GATEWAY_API_KEY"] ?? env["OPENAI_API_KEY"];

  if (!baseUrl || !apiKey) {
    throw new AiError(
      "AI provider is not configured. Neon injects AI Gateway credentials automatically when " +
        "the branch has it enabled; otherwise set NEON_AI_GATEWAY_URL and " +
        "NEON_AI_GATEWAY_API_KEY (or OPENAI_BASE_URL / OPENAI_API_KEY for a compatible endpoint).",
      undefined,
      false,
    );
  }

  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
}

async function postJson<T>(
  config: GatewayConfig,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<T> {
  const doFetch = config.fetchImpl ?? fetch;
  // Explicit timeout: a hung provider call bills waiting Capacity-Hours until the platform
  // eventually kills the invocation, which is a slow and invisible way to lose money.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await doFetch(`${config.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new AiError(
        `AI request to ${path} failed with ${response.status}: ${detail}`,
        response.status,
        isRetryableStatus(response.status),
      );
    }

    return (await response.json()) as T;
  } catch (err) {
    if (err instanceof AiError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new AiError(`AI request to ${path} timed out after ${timeoutMs}ms`, undefined, true);
    }
    throw new AiError(
      `AI request to ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
      undefined,
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}

interface EmbeddingsResponse {
  data: { embedding: number[]; index: number }[];
  model: string;
  usage?: { total_tokens: number };
}

export interface GatewayEmbeddingOptions {
  model?: string;
  dimensions?: number;
  maxBatchSize?: number;
  timeoutMs?: number;
}

export function createGatewayEmbeddings(
  config: GatewayConfig,
  opts: GatewayEmbeddingOptions = {},
): EmbeddingProvider {
  const model = opts.model ?? "text-embedding-3-small";
  const dimensions = opts.dimensions ?? 1536;
  const maxBatchSize = opts.maxBatchSize ?? 96;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  return {
    name: "neon-ai-gateway",
    model,
    dimensions,
    maxBatchSize,

    async embed(texts: readonly string[]): Promise<EmbeddingResult> {
      if (texts.length === 0) return { vectors: [], model, dimensions };

      const vectors: number[][] = [];
      let totalTokens = 0;

      for (const batch of batched(texts, maxBatchSize)) {
        const response = await postJson<EmbeddingsResponse>(
          config,
          "/v1/embeddings",
          { model, input: batch },
          timeoutMs,
        );

        // Providers are permitted to return out of order; index is authoritative.
        const ordered = [...response.data].sort((a, b) => a.index - b.index);
        if (ordered.length !== batch.length) {
          throw new AiError(
            `Embedding provider returned ${ordered.length} vectors for ${batch.length} inputs`,
            undefined,
            false,
          );
        }

        for (const item of ordered) {
          if (item.embedding.length !== dimensions) {
            // Caught here rather than at INSERT, where the error is an opaque pgvector
            // dimension mismatch that doesn't mention the model.
            throw new AiError(
              `Model ${model} returned ${item.embedding.length} dimensions but this block is ` +
                `configured for ${dimensions}. Changing embedding model requires a migration, ` +
                `not a config change — the vector column is fixed-width.`,
              undefined,
              false,
            );
          }
          vectors.push(item.embedding);
        }
        totalTokens += response.usage?.total_tokens ?? 0;
      }

      return { vectors, model, dimensions, ...(totalTokens > 0 ? { totalTokens } : {}) };
    },
  };
}

interface ChatResponse {
  choices: { message: { content: string | null }; finish_reason: string }[];
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export function createGatewayChat(
  config: GatewayConfig,
  opts: { model?: string } = {},
): ChatProvider {
  const model = opts.model ?? "gpt-4o-mini";

  return {
    name: "neon-ai-gateway",
    model,

    async chat(messages: readonly ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
      const response = await postJson<ChatResponse>(
        config,
        "/v1/chat/completions",
        {
          model,
          messages: messages.map((m) => ({
            role: m.role,
            content:
              typeof m.content === "string"
                ? m.content
                : m.content.map((part) =>
                    part.type === "text"
                      ? { type: "text", text: part.text }
                      : { type: "image_url", image_url: part.imageUrl },
                  ),
          })),
          ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.jsonMode ? { response_format: { type: "json_object" } } : {}),
        },
        options.timeoutMs ?? 120_000,
      );

      const choice = response.choices[0];
      if (!choice) throw new AiError("Chat provider returned no choices", undefined, true);

      return {
        text: choice.message.content ?? "",
        model: response.model,
        finishReason: choice.finish_reason,
        ...(response.usage
          ? {
              usage: {
                promptTokens: response.usage.prompt_tokens,
                completionTokens: response.usage.completion_tokens,
              },
            }
          : {}),
      };
    },
  };
}
