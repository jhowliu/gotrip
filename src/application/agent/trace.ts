/**
 * Trace events emitted by runAgent — the observability seam. The runtime stays
 * I/O-free: it calls a `Tracer` (a plain function); writing to a file/console is
 * an infrastructure concern (see infrastructure/observability).
 */

import type { ModelToolCall } from "../ports/ModelClient";

export type AgentStatus = "ok" | "budget_exhausted" | "stopped";

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export type TraceEvent =
  | { type: "iteration"; iteration: number }
  | { type: "model_request"; model: string; messages: unknown; tools?: unknown }
  | { type: "model_response"; model: string; output: unknown; usage?: TokenUsage }
  | { type: "model_error"; model: string; message: string }
  | { type: "tool_call"; iteration: number; callId: string; name: string; input: unknown }
  | {
      type: "tool_result";
      iteration: number;
      callId: string;
      name: string;
      isError: boolean;
      final: boolean;
      output: unknown;
    }
  | { type: "model_message"; iteration: number; text: string }
  | { type: "escalation"; iteration: number; from: string; to: string }
  | { type: "finish"; status: AgentStatus; iterations: number };

export type Tracer = (event: TraceEvent) => void;

export const noopTracer: Tracer = () => {};

export type { ModelToolCall };
