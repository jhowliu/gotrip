/**
 * The reusable agent abstraction (dependency-inversion seam). A spec is
 * declarative data; the runtime (runAgent) executes it. Swapping the domain
 * means swapping `TState`, `tools`, and `validate` — the runtime doesn't change.
 */

import type { ZodTypeAny } from "zod";
import type { ValidationResult } from "../../domain/itinerary";

export type ModelId =
  | "claude-sonnet-4-6"
  | "claude-haiku-4-5"
  | "claude-opus-4-8"
  // allow other ids without losing the suggestions above
  | (string & {});

export interface AgentConstraints {
  maxIterations: number; // counted in LLM turns, not tool calls
  maxTokens?: number;
  runtimeMs?: number;
}

export interface ToolOutcome {
  content: unknown; // serialised into the tool_result the model sees
  final?: boolean; // a successful finalize — ends the loop cleanly
  isError?: boolean; // tool-boundary rejection (readable error → agent retries)
}

export interface ToolDef<TState> {
  name: string;
  description: string;
  inputSchema: ZodTypeAny; // runtime param guard (the "tool-layer guard")
  execute(input: unknown, state: TState): Promise<ToolOutcome> | ToolOutcome;
}

export interface AgentSpec<TState> {
  instruction: string; // role + strategy (kept thin)
  kickoff: string; // the concrete task seed (e.g. the TripRequest)
  model: ModelId;
  constraints: AgentConstraints;
  tools: ToolDef<TState>[];
  initialState: TState;
  /** The injected finalize gate. The runtime doesn't know its contents. */
  validate: (state: TState) => ValidationResult;
}
