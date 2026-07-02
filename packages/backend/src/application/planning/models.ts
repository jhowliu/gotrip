/**
 * Model tier from the environment, with sensible defaults. The LLM *client* stays
 * behind the ModelClient port; only the model *name* (a config string) is read here,
 * so the model can be swapped via `.env` without touching code. Provider-neutral
 * `LLM_MODEL` is preferred; `OPENAI_MODEL` remains as a fallback. For OpenRouter, use a
 * namespaced name (e.g. `anthropic/claude-sonnet-4-6`, `openai/gpt-4o-mini`):
 *
 *   LLM_MODEL=anthropic/claude-sonnet-4-6   # base model (cold-start + warm edits)
 *   LLM_ESCALATION_MODEL=openai/gpt-5.4     # one-shot escalation on no-progress (optional)
 */

export const baseModel = (): string =>
  process.env.LLM_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";

/** Undefined = no escalation configured (callers may apply their own default). */
export const escalationModel = (): string | undefined =>
  process.env.LLM_ESCALATION_MODEL || process.env.OPENAI_ESCALATION_MODEL || undefined;
