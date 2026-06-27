/**
 * The hand-written ReAct loop. Generic over `TState`; owns only the loop
 * mechanics. It knows nothing about travel — just: call the model, run the tools
 * it asks for, feed results back, stop on a `final` tool outcome or when the
 * budget runs out. Emits trace events to an injected `Tracer` (default no-op).
 */

import { zodToJsonSchema } from "zod-to-json-schema";

import type { AgentSpec, ToolOutcome } from "./AgentSpec";
import type { HistoryItem, ModelClient, ModelToolSpec, ModelTurn } from "../ports/ModelClient";
import type { ValidationResult } from "../../domain/itinerary";
import { noopTracer, type AgentStatus, type Tracer } from "./trace";

export type { AgentStatus };

export interface AgentResult<TState> {
  status: AgentStatus;
  state: TState;
  iterations: number;
  validation: ValidationResult;
}

/** Halt if the model repeats the identical turn this many extra times in a row. */
const NO_PROGRESS_REPEATS = 2;

/** Signature of a turn ignoring call ids — so repeated identical actions match. */
function turnSignature(turn: ModelTurn): string {
  if (turn.kind === "tool_use") {
    return `tool:${JSON.stringify(turn.calls.map((c) => [c.name, c.input]))}`;
  }
  return `msg:${turn.text}`;
}

function toModelToolSpecs<TState>(spec: AgentSpec<TState>): ModelToolSpec[] {
  return spec.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.inputSchema, { $refStrategy: "none" }) as Record<string, unknown>,
  }));
}

function toolResultItem(callId: string, content: unknown, isError: boolean): HistoryItem {
  return { role: "tool_result", callId, content: JSON.stringify(content), isError };
}

export async function runAgent<TState>(
  spec: AgentSpec<TState>,
  model: ModelClient,
  tracer: Tracer = noopTracer,
): Promise<AgentResult<TState>> {
  const state = spec.initialState;
  const tools = toModelToolSpecs(spec);
  const history: HistoryItem[] = [{ role: "user", content: spec.kickoff }];
  let iterations = 0;
  const startedAt = Date.now();
  let lastSignature = "";
  let repeats = 0;

  while (iterations < spec.constraints.maxIterations) {
    if (spec.constraints.runtimeMs !== undefined && Date.now() - startedAt >= spec.constraints.runtimeMs) {
      tracer({ type: "finish", status: "budget_exhausted", iterations });
      return { status: "budget_exhausted", state, iterations, validation: spec.validate(state) };
    }

    iterations += 1;
    tracer({ type: "iteration", iteration: iterations });

    const turn = await model.next({
      model: spec.model,
      instruction: spec.instruction,
      tools,
      history,
    });
    history.push({ role: "assistant", turn });

    // No-progress detection: identical turn repeated too many times in a row.
    const signature = turnSignature(turn);
    repeats = signature === lastSignature ? repeats + 1 : 0;
    lastSignature = signature;
    if (repeats >= NO_PROGRESS_REPEATS) {
      tracer({ type: "finish", status: "stopped", iterations });
      return { status: "stopped", state, iterations, validation: spec.validate(state) };
    }

    if (turn.kind !== "tool_use" || turn.calls.length === 0) {
      if (turn.kind === "message") tracer({ type: "model_message", iteration: iterations, text: turn.text });
      tracer({ type: "finish", status: "stopped", iterations });
      return { status: "stopped", state, iterations, validation: spec.validate(state) };
    }

    for (const call of turn.calls) {
      tracer({ type: "tool_call", iteration: iterations, callId: call.id, name: call.name, input: call.input });

      const tool = spec.tools.find((t) => t.name === call.name);
      let output: unknown;
      let isError = false;
      let final = false;

      if (!tool) {
        output = { error: `unknown tool: ${call.name}` };
        isError = true;
      } else {
        const parsed = tool.inputSchema.safeParse(call.input);
        if (!parsed.success) {
          output = { error: "invalid tool input", issues: parsed.error.issues };
          isError = true;
        } else {
          try {
            const outcome: ToolOutcome = await tool.execute(parsed.data, state);
            output = outcome.content;
            isError = outcome.isError ?? false;
            final = outcome.final ?? false;
          } catch (err) {
            output = { error: err instanceof Error ? err.message : String(err) };
            isError = true;
          }
        }
      }

      history.push(toolResultItem(call.id, output, isError));
      tracer({ type: "tool_result", iteration: iterations, callId: call.id, name: call.name, isError, final, output });

      if (final) {
        tracer({ type: "finish", status: "ok", iterations });
        return { status: "ok", state, iterations, validation: spec.validate(state) };
      }
    }
  }

  tracer({ type: "finish", status: "budget_exhausted", iterations });
  return { status: "budget_exhausted", state, iterations, validation: spec.validate(state) };
}
