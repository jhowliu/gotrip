/**
 * Model-client factory — picks the LLM provider from the environment and returns a
 * configured ModelClient. OpenAI and OpenRouter are both OpenAI-compatible, so they
 * share `createOpenAIModelClient`; only the base URL / key / headers differ. Everything
 * upstream (runAgent, tools, domain) stays provider-neutral behind the ModelClient port.
 *
 *   LLM_PROVIDER=openrouter          # explicit; else inferred from which key is set
 *   OPENROUTER_API_KEY=sk-or-...     # OpenRouter key
 *   OPENAI_API_KEY=sk-...            # OpenAI key
 *   OPENROUTER_SITE_URL / OPENROUTER_APP_NAME  # optional OpenRouter ranking headers
 */

import type { ModelClient } from "../../application/ports/ModelClient";
import type { Tracer } from "../../application/agent/trace";
import { createOpenAIModelClient } from "./openaiModelClient";

export type LlmProvider = "openai" | "openrouter";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Explicit LLM_PROVIDER wins; otherwise prefer OpenRouter when only its key is set. */
export function llmProvider(): LlmProvider {
  const explicit = process.env.LLM_PROVIDER?.toLowerCase();
  if (explicit === "openrouter" || explicit === "openai") return explicit;
  return process.env.OPENROUTER_API_KEY ? "openrouter" : "openai";
}

/** True when the selected provider has an API key configured (gates chat/planning). */
export function hasLlmKey(): boolean {
  return llmProvider() === "openrouter"
    ? Boolean(process.env.OPENROUTER_API_KEY)
    : Boolean(process.env.OPENAI_API_KEY);
}

/** Build the ModelClient for the configured provider. */
export function createModelClient(tracer?: Tracer): ModelClient {
  if (llmProvider() === "openrouter") {
    const headers: Record<string, string> = {};
    if (process.env.OPENROUTER_SITE_URL) headers["HTTP-Referer"] = process.env.OPENROUTER_SITE_URL;
    if (process.env.OPENROUTER_APP_NAME) headers["X-Title"] = process.env.OPENROUTER_APP_NAME;
    return createOpenAIModelClient({
      ...(process.env.OPENROUTER_API_KEY ? { apiKey: process.env.OPENROUTER_API_KEY } : {}),
      baseURL: process.env.OPENROUTER_BASE_URL || OPENROUTER_BASE_URL,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(tracer ? { tracer } : {}),
    });
  }
  return createOpenAIModelClient({ ...(tracer ? { tracer } : {}) });
}
