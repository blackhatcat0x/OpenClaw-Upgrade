/**
 * LLM Router types for multi-key, multi-provider failover.
 * Keys come from .env and are never exposed to the UI or clients.
 */

export type LLMCapability = "reasoning" | "status_ping" | "embeddings";

export type LLMProvider = "openai" | "anthropic" | "deepseek";

export type LLMMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LLMRequest = {
  capability: LLMCapability;
  messages: LLMMessage[];
  /** Max tokens for the response */
  maxTokens?: number;
  /** Temperature (0-1); default 0.3 */
  temperature?: number;
};

export type LLMResponse = {
  text: string;
  provider: LLMProvider;
  model: string;
  /** Approximate token counts */
  usage?: { inputTokens: number; outputTokens: number };
};

export type EmbeddingRequest = {
  texts: string[];
};

export type EmbeddingResponse = {
  embeddings: number[][];
  provider: LLMProvider;
  model: string;
};

/** Per-key health state tracked in memory */
export type KeyHealth = {
  provider: LLMProvider;
  key: string;
  /** If set, do not use this key until this timestamp */
  cooldownUntil?: number;
  /** Permanently disabled (e.g. insufficient credits) */
  disabled?: boolean;
  /** Last error string for diagnostics */
  lastError?: string;
};

export interface LLMProviderClient {
  readonly provider: LLMProvider;
  complete(request: LLMRequest, apiKey: string): Promise<LLMResponse>;
  embed?(request: EmbeddingRequest, apiKey: string): Promise<EmbeddingResponse>;
  /** Model to use for the given capability */
  modelForCapability(cap: LLMCapability): string;
}
