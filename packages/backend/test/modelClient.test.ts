import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasLlmKey, llmProvider } from "../src/infrastructure/llm/modelClient";

const KEYS = ["LLM_PROVIDER", "OPENAI_API_KEY", "OPENROUTER_API_KEY"] as const;

describe("llm provider selection", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("infers openrouter when only its key is set", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-x";
    expect(llmProvider()).toBe("openrouter");
    expect(hasLlmKey()).toBe(true);
  });

  it("defaults to openai and reports the key's presence", () => {
    expect(llmProvider()).toBe("openai");
    expect(hasLlmKey()).toBe(false);
    process.env.OPENAI_API_KEY = "sk-x";
    expect(hasLlmKey()).toBe(true);
  });

  it("honours an explicit LLM_PROVIDER even without that provider's key", () => {
    process.env.LLM_PROVIDER = "openrouter";
    expect(llmProvider()).toBe("openrouter");
    expect(hasLlmKey()).toBe(false); // provider chosen, key still missing
  });
});
