/**
 * Trace events emitted by runAgent — the observability seam. The runtime stays
 * I/O-free: it calls a `Tracer` (a plain function); writing to a file/console is
 * an infrastructure concern (see infrastructure/observability).
 */

import type { ModelToolCall } from "../ports/ModelClient";

export type AgentStatus = "ok" | "budget_exhausted" | "stopped";

export type TraceEvent =
  | { type: "iteration"; iteration: number }
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
  | { type: "finish"; status: AgentStatus; iterations: number };

export type Tracer = (event: TraceEvent) => void;

export const noopTracer: Tracer = () => {};

export type { ModelToolCall };
