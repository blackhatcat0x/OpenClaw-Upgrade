import type { LLMCapability, LLMProviderClient, LLMRequest, LLMResponse } from "../types.js";

const REASONING_MODEL = "claude-opus-4-6";
const STATUS_MODEL = "claude-haiku-4-5";
const BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";

export class AnthropicProviderClient implements LLMProviderClient {
  readonly provider = "anthropic" as const;

  modelForCapability(cap: LLMCapability): string {
    switch (cap) {
      case "status_ping":
        return STATUS_MODEL;
      default:
        return REASONING_MODEL;
    }
  }

  async complete(request: LLMRequest, apiKey: string): Promise<LLMResponse> {
    const model = this.modelForCapability(request.capability);

    // Anthropic API requires system message separate from messages array
    const systemMessages = request.messages.filter((m) => m.role === "system");
    const conversationMessages = request.messages.filter((m) => m.role !== "system");

    const body: Record<string, unknown> = {
      model,
      max_tokens: request.maxTokens ?? 512,
      temperature: request.temperature ?? 0.3,
      messages: conversationMessages,
    };

    if (systemMessages.length > 0) {
      body.system = systemMessages.map((m) => m.content).join("\n");
    }

    const res = await fetch(`${BASE_URL}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => res.statusText);
      const err = new Error(`Anthropic error ${res.status}: ${errorText}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }

    const data = (await res.json()) as {
      content: Array<{ type: string; text?: string }>;
      usage?: { input_tokens: number; output_tokens: number };
    };

    const textContent = data.content.find((c) => c.type === "text");

    return {
      text: textContent?.text ?? "",
      provider: "anthropic",
      model,
      usage: data.usage
        ? {
            inputTokens: data.usage.input_tokens,
            outputTokens: data.usage.output_tokens,
          }
        : undefined,
    };
  }

  // Anthropic does not provide a standalone embeddings API; embeddings not supported
}
