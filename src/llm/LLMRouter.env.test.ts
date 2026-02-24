import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMRouter } from "./LLMRouter.js";

const originalEnv = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_API_KEYS: process.env.OPENAI_API_KEYS,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_API_KEYS: process.env.ANTHROPIC_API_KEYS,
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  DEEPSEEK_API_KEYS: process.env.DEEPSEEK_API_KEYS,
};

function restoreEnv(): void {
  for (const [k, v] of Object.entries(originalEnv)) {
    if (typeof v === "undefined") {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

describe("LLMRouter env key loading", () => {
  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });

  it("loads keys from singular and plural env vars", () => {
    process.env.OPENAI_API_KEY = "oa-single";
    process.env.OPENAI_API_KEYS = "oa-a,oa-b";
    process.env.ANTHROPIC_API_KEY = "an-single";
    process.env.DEEPSEEK_API_KEY = "ds-single";

    const router = new LLMRouter();
    const byProvider = new Map(router.healthSummary().map((row) => [row.provider, row]));

    expect(byProvider.get("openai")?.total).toBe(3);
    expect(byProvider.get("anthropic")?.total).toBe(1);
    expect(byProvider.get("deepseek")?.total).toBe(1);
  });
});
