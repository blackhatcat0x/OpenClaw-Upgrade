import type { LLMCapability, LLMProviderClient, LLMRequest, LLMResponse } from "../types.js";

const REASONING_MODEL = "deepseek-chat";
const STATUS_MODEL = "deepseek-chat";
const BASE_URL = "https://api.deepseek.com/v1";

export class DeepseekProviderClient implements LLMProviderClient {
  readonly provider = "deepseek" as const;

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
    const body = {
      model,
      messages: request.messages,
      max_tokens: request.maxTokens ?? 512,
      temperature: request.temperature ?? 0.3,
    };

    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => res.statusText);
      const err = new Error(`Deepseek error ${res.status}: ${errorText}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }

    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    return {
      text: data.choices[0]?.message?.content ?? "",
      provider: "deepseek",
      model,
      usage: data.usage
        ? {
            inputTokens: data.usage.prompt_tokens,
            outputTokens: data.usage.completion_tokens,
          }
        : undefined,
    };
  }
}
