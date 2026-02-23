import type {
  EmbeddingRequest,
  EmbeddingResponse,
  LLMCapability,
  LLMProviderClient,
  LLMRequest,
  LLMResponse,
} from "../types.js";

const REASONING_MODEL = "gpt-4o";
const STATUS_MODEL = "gpt-4o-mini";
const EMBEDDING_MODEL = "text-embedding-3-small";
const BASE_URL = "https://api.openai.com/v1";

export class OpenAIProviderClient implements LLMProviderClient {
  readonly provider = "openai" as const;

  modelForCapability(cap: LLMCapability): string {
    switch (cap) {
      case "embeddings":
        return EMBEDDING_MODEL;
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
      const err = new Error(`OpenAI error ${res.status}: ${errorText}`);
      // Attach status for router error classification
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }

    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    return {
      text: data.choices[0]?.message?.content ?? "",
      provider: "openai",
      model,
      usage: data.usage
        ? {
            inputTokens: data.usage.prompt_tokens,
            outputTokens: data.usage.completion_tokens,
          }
        : undefined,
    };
  }

  async embed(request: EmbeddingRequest, apiKey: string): Promise<EmbeddingResponse> {
    const model = EMBEDDING_MODEL;
    const body = { model, input: request.texts };

    const res = await fetch(`${BASE_URL}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => res.statusText);
      const err = new Error(`OpenAI embeddings error ${res.status}: ${errorText}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }

    const data = (await res.json()) as {
      data: Array<{ embedding: number[] }>;
    };

    return {
      embeddings: data.data.map((d) => d.embedding),
      provider: "openai",
      model,
    };
  }
}
