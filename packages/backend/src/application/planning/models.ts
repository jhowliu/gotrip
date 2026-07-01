/**
 * Model tier from the environment, with sensible defaults. The LLM *client* stays
 * behind the ModelClient port; only the model *name* (a config string) is read
 * here, so the model can be swapped via `.env` without touching code:
 *
 *   OPENAI_MODEL=gpt-5.4-mini            # base model (cold-start + warm edits)
 *   OPENAI_ESCALATION_MODEL=gpt-5.4      # one-shot escalation on no-progress (optional)
 */

export const baseModel = (): string => process.env.OPENAI_MODEL ?? "gpt-4o-mini";

/** Undefined = no escalation configured (callers may apply their own default). */
export const escalationModel = (): string | undefined => process.env.OPENAI_ESCALATION_MODEL || undefined;
