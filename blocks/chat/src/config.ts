/**
 * Config for the chat block.
 *
 * Convention 3: fail fast at startup with one actionable message. DATABASE_URL is the only hard
 * requirement here; the AI Gateway credential is validated lazily by the AI package when a model
 * call is actually made, so /health still answers on a branch that has Postgres but no gateway.
 */

import { loadConfig } from "@neon-blocks/core";

export const SPEC = {
  block: "chat",
  required: ["DATABASE_URL"],
  optional: {
    CHAT_MODEL: "gpt-4o-mini",
    CHAT_MAX_INPUT_TOKENS: "24000",
    CHAT_MAX_OUTPUT_TOKENS: "2048",
    CHAT_MAX_TOOL_ITERATIONS: "6",
    CHAT_HISTORY_LIMIT: "20",
    CHAT_STREAM_TIMEOUT_MS: "120000",
    CHAT_API_KEY: "",
    NEON_AUTH_BASE_URL: "",
    CHAT_CORS_ALLOW_ORIGIN: "*",
    RAG_URL: "",
    SEMANTIC_CACHE_URL: "",
    AGENT_MEMORY_URL: "",
  },
} as const;

export interface ChatConfig {
  model: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxToolIterations: number;
  historyLimit: number;
  streamTimeoutMs: number;
  /** Shared-secret bearer token, or "" when that path is disabled. */
  apiKey: string;
  /** Neon Auth issuer for JWT verification, or "" when disabled. */
  authBaseUrl: string;
  corsAllowOrigin: string;
  /** Sibling block base URLs; "" means that composition stage is skipped. */
  ragUrl: string;
  semanticCacheUrl: string;
  agentMemoryUrl: string;
}

export function loadChatConfig(): ChatConfig {
  const c = loadConfig(SPEC);
  return {
    model: c.get("CHAT_MODEL"),
    maxInputTokens: c.int("CHAT_MAX_INPUT_TOKENS", { min: 1 }),
    maxOutputTokens: c.int("CHAT_MAX_OUTPUT_TOKENS", { min: 1 }),
    maxToolIterations: c.int("CHAT_MAX_TOOL_ITERATIONS", { min: 1, max: 50 }),
    historyLimit: c.int("CHAT_HISTORY_LIMIT", { min: 0, max: 200 }),
    streamTimeoutMs: c.int("CHAT_STREAM_TIMEOUT_MS", { min: 1000 }),
    apiKey: c.get("CHAT_API_KEY"),
    authBaseUrl: c.get("NEON_AUTH_BASE_URL"),
    corsAllowOrigin: c.get("CHAT_CORS_ALLOW_ORIGIN"),
    ragUrl: c.get("RAG_URL"),
    semanticCacheUrl: c.get("SEMANTIC_CACHE_URL"),
    agentMemoryUrl: c.get("AGENT_MEMORY_URL"),
  };
}
