export {
  AiError,
  batched,
  type EmbeddingProvider,
  type EmbeddingResult,
  type ChatProvider,
  type ChatResult,
  type ChatMessage,
  type ChatOptions,
  type ContentPart,
} from "./provider.js";
export {
  createGatewayEmbeddings,
  createGatewayChat,
  gatewayConfigFromEnv,
  type GatewayConfig,
  type GatewayEmbeddingOptions,
} from "./gateway.js";
export {
  chunkText,
  approxTokens,
  DEFAULT_CHUNKING,
  type Chunk,
  type ChunkOptions,
} from "./chunk.js";
export { toVectorLiteral, parseVectorLiteral, cosineSimilarity } from "./vector.js";

import { createGatewayChat, createGatewayEmbeddings, gatewayConfigFromEnv } from "./gateway.js";
import type { ChatProvider, EmbeddingProvider } from "./provider.js";

/**
 * Default embedding provider: AI Gateway, configured from the environment.
 *
 * Blocks call this so the zero-config path is the path of least resistance, and adapters stay
 * an explicit opt-in rather than a fork in every block.
 */
export function defaultEmbeddings(opts?: {
  model?: string;
  dimensions?: number;
}): EmbeddingProvider {
  return createGatewayEmbeddings(gatewayConfigFromEnv(), opts ?? {});
}

export function defaultChat(opts?: { model?: string }): ChatProvider {
  return createGatewayChat(gatewayConfigFromEnv(), opts ?? {});
}
