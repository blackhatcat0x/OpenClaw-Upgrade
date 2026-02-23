/**
 * LLMRouter: multi-key, multi-provider failover for LLM requests.
 *
 * Keys are loaded from environment variables and never exposed to clients.
 * Supports capability-based routing (reasoning, status_ping, embeddings).
 *
 * Priority order (configurable via OPENCLAW_LLM_PRIORITY env var):
 *   default: openai, anthropic, deepseek
 *
 * Rate-limit handling:
 *   - HTTP 429 → cooldown for RATE_LIMIT_COOLDOWN_MS (1 min default)
 *   - HTTP 402/403 with "insufficient" → permanently disable key
 */

import { AnthropicProviderClient } from "./providers/Anthropic.js";
import { DeepseekProviderClient } from "./providers/Deepseek.js";
import { OpenAIProviderClient } from "./providers/OpenAI.js";
import type {
  EmbeddingRequest,
  EmbeddingResponse,
  KeyHealth,
  LLMCapability,
  LLMProvider,
  LLMProviderClient,
  LLMRequest,
  LLMResponse,
} from "./types.js";

const RATE_LIMIT_COOLDOWN_MS = 60_000;
const MAX_RETRIES = 3;

function parseKeys(env: string | undefined): string[] {
  if (!env) return [];
  return env
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

function isRateLimit(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status === 429;
}

function isInsufficientCredits(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 402 || status === 403) return true;
  const msg = String((err as Error)?.message ?? "").toLowerCase();
  return msg.includes("insufficient") || msg.includes("credits") || msg.includes("quota");
}

export class LLMRouter {
  private readonly clients: Map<LLMProvider, LLMProviderClient>;
  private readonly keyHealth: KeyHealth[] = [];
  /** Priority list of providers to try */
  private readonly providerOrder: LLMProvider[];

  constructor() {
    this.clients = new Map<LLMProvider, LLMProviderClient>([
      ["openai", new OpenAIProviderClient()],
      ["anthropic", new AnthropicProviderClient()],
      ["deepseek", new DeepseekProviderClient()],
    ] as [LLMProvider, LLMProviderClient][]);

    // Load keys from environment
    const openaiKeys = parseKeys(process.env.OPENAI_API_KEYS);
    const anthropicKeys = parseKeys(process.env.ANTHROPIC_API_KEYS);
    const deepseekKeys = parseKeys(process.env.DEEPSEEK_API_KEYS);

    for (const key of openaiKeys) {
      this.keyHealth.push({ provider: "openai", key });
    }
    for (const key of anthropicKeys) {
      this.keyHealth.push({ provider: "anthropic", key });
    }
    for (const key of deepseekKeys) {
      this.keyHealth.push({ provider: "deepseek", key });
    }

    // Parse optional priority override: "anthropic,openai,deepseek"
    const priorityEnv = process.env.OPENCLAW_LLM_PRIORITY;
    this.providerOrder = priorityEnv
      ? (priorityEnv.split(",").map((s: string) => s.trim()) as LLMProvider[])
      : ["openai", "anthropic", "deepseek"];
  }

  /** Return healthy keys for a given provider, in order */
  private healthyKeysFor(provider: LLMProvider): string[] {
    const now = Date.now();
    return this.keyHealth
      .filter(
        (k) =>
          k.provider === provider &&
          !k.disabled &&
          (!k.cooldownUntil || k.cooldownUntil <= now),
      )
      .map((k) => k.key);
  }

  private markRateLimit(provider: LLMProvider, key: string): void {
    const entry = this.keyHealth.find((k) => k.provider === provider && k.key === key);
    if (entry) {
      entry.cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
      entry.lastError = "rate-limited";
    }
  }

  private markDisabled(provider: LLMProvider, key: string, reason: string): void {
    const entry = this.keyHealth.find((k) => k.provider === provider && k.key === key);
    if (entry) {
      entry.disabled = true;
      entry.lastError = reason;
    }
  }

  /**
   * Complete a chat request with automatic provider and key failover.
   */
  async complete(request: LLMRequest): Promise<LLMResponse> {
    let lastError: unknown;
    let attempts = 0;

    for (const provider of this.providerOrder) {
      if (attempts >= MAX_RETRIES) break;

      // Embeddings: skip providers that don't support it
      if (request.capability === "embeddings") continue;

      const client = this.clients.get(provider);
      if (!client) continue;

      const keys = this.healthyKeysFor(provider);
      for (const key of keys) {
        if (attempts >= MAX_RETRIES) break;
        attempts++;

        try {
          return await client.complete(request, key);
        } catch (err) {
          lastError = err;
          if (isInsufficientCredits(err)) {
            this.markDisabled(provider, key, String((err as Error).message));
          } else if (isRateLimit(err)) {
            this.markRateLimit(provider, key);
          }
          // Continue to next key/provider
        }
      }
    }

    throw new Error(
      `LLMRouter: all providers/keys exhausted after ${attempts} attempts. Last error: ${String((lastError as Error)?.message ?? lastError)}`,
    );
  }

  /**
   * Embed texts with automatic key failover.
   * Only providers that implement embed() are tried.
   */
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    let lastError: unknown;
    let attempts = 0;

    for (const provider of this.providerOrder) {
      if (attempts >= MAX_RETRIES) break;

      const client = this.clients.get(provider);
      if (!client?.embed) continue;

      const keys = this.healthyKeysFor(provider);
      for (const key of keys) {
        if (attempts >= MAX_RETRIES) break;
        attempts++;

        try {
          return await client.embed(request, key);
        } catch (err) {
          lastError = err;
          if (isInsufficientCredits(err)) {
            this.markDisabled(provider, key, String((err as Error).message));
          } else if (isRateLimit(err)) {
            this.markRateLimit(provider, key);
          }
        }
      }
    }

    throw new Error(
      `LLMRouter: embedding failed. Last error: ${String((lastError as Error)?.message ?? lastError)}`,
    );
  }

  /**
   * Returns a summary of key health for diagnostics (no keys exposed).
   */
  healthSummary(): Array<{ provider: LLMProvider; healthy: number; total: number }> {
    const now = Date.now();
    const byProvider = new Map<LLMProvider, { healthy: number; total: number }>();

    for (const k of this.keyHealth) {
      const entry = byProvider.get(k.provider) ?? { healthy: 0, total: 0 };
      entry.total++;
      if (!k.disabled && (!k.cooldownUntil || k.cooldownUntil <= now)) {
        entry.healthy++;
      }
      byProvider.set(k.provider, entry);
    }

    return Array.from(byProvider.entries()).map(([provider, counts]) => ({
      provider,
      ...counts,
    }));
  }

  /** Convenience: build request for cheap status ping model */
  async statusPing(prompt: string): Promise<string> {
    const resp = await this.complete({
      capability: "status_ping",
      messages: [
        {
          role: "system",
          content:
            "Write one short status line (max 120 chars) describing what the agent is doing. No extra detail.",
        },
        { role: "user", content: prompt },
      ],
      maxTokens: 80,
      temperature: 0.3,
    });
    return resp.text.trim().slice(0, 120);
  }
}

/** Singleton router; initialized lazily */
let _router: LLMRouter | undefined;

export function getLLMRouter(): LLMRouter {
  if (!_router) _router = new LLMRouter();
  return _router;
}

/** Reset router (for testing) */
export function resetLLMRouter(): void {
  _router = undefined;
}

export type { LLMCapability, LLMProvider, LLMRequest, LLMResponse, EmbeddingRequest, EmbeddingResponse };
