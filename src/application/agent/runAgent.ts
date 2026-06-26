/**
 * The hand-written ReAct loop. Generic over `TState`; owns only the loop
 * mechanics. It knows nothing about travel — just: call the model, run the tools
 * it asks for, feed results back, stop on a `final` tool outcome or when the
 * budget runs out.
 */

import { zodToJsonSchema } from "zod-to-json-schema";

import type { AgentSpec, ToolOutcome } from "./AgentSpec";
import type { HistoryItem, ModelClient, ModelToolSpec } from "../ports/ModelClient";
import type { ValidationResult } from "../../domain/itinerary";

export type AgentStatus = "ok" | "budget_exhausted" | "stopped";

export interface AgentResult<TState> {
  status: AgentStatus;
  state: TState;
  iterations: number;
  validation: ValidationResult;
}

function toModelToolSpecs<TState>(spec: AgentSpec<TState>): ModelToolSpec[] {
  return spec.tools.map((t) => ({
    name: t.name,
    description: t.description,
    // Real JSON schema from the tool's zod schema — what a real model needs to
    // produce valid arguments. The scripted model ignores it.
    inputSchema: zodToJsonSchema(t.inputSchema, { $refStrategy: "none" }) as Record<string, unknown>,
  }));
}

function toolResult(callId: string, content: unknown, isError = false): HistoryItem {
  return { role: "tool_result", callId, content: JSON.stringify(content), isError };
}

export async function runAgent<TState>(
  spec: AgentSpec<TState>,
  model: ModelClient,
): Promise<AgentResult<TState>> {
  const state = spec.initialState;
  const tools = toModelToolSpecs(spec);
  const history: HistoryItem[] = [{ role: "user", content: spec.kickoff }];
  let iterations = 0;

  while (iterations < spec.constraints.maxIterations) {
    iterations += 1;
    const turn = await model.next({
      model: spec.model,
      instruction: spec.instruction,
      tools,
      history,
    });
    history.push({ role: "assistant", turn });

    if (turn.kind !== "tool_use" || turn.calls.length === 0) {
      // Model ended without finalizing — stop and report.
      return { status: "stopped", state, iterations, validation: spec.validate(state) };
    }

    for (const call of turn.calls) {
      const tool = spec.tools.find((t) => t.name === call.name);
      if (!tool) {
        history.push(toolResult(call.id, { error: `unknown tool: ${call.name}` }, true));
        continue;
      }

      const parsed = tool.inputSchema.safeParse(call.input);
      if (!parsed.success) {
        history.push(toolResult(call.id, { error: "invalid tool input", issues: parsed.error.issues }, true));
        continue;
      }

      let outcome: ToolOutcome;
      try {
        outcome = await tool.execute(parsed.data, state);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        history.push(toolResult(call.id, { error: message }, true));
        continue;
      }

      history.push(toolResult(call.id, outcome.content, outcome.isError ?? false));

      if (outcome.final) {
        return { status: "ok", state, iterations, validation: spec.validate(state) };
      }
    }
  }

  // Budget exhausted: graceful exit with a best-effort validation of current state.
  return { status: "budget_exhausted", state, iterations, validation: spec.validate(state) };
}
