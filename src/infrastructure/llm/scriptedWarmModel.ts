/**
 * Scripted warm-edit ModelClient — a deterministic stand-in for the LLM editing
 * an itinerary. Given the edit operations a real model would emit, it: calls
 * applyEdits, then either finishEditing (on success) or reports a conflict and
 * stops (when the edit is rejected for breaking a hard constraint). Lets the
 * whole conversational-edit path be tested without an API.
 */

import type { HistoryItem, ModelClient, ModelRequest, ModelToolCall, ModelTurn } from "../../application/ports/ModelClient";
import type { EditOp } from "../../domain/applyEdits";

function lastToolResult(history: HistoryItem[]): { isError: boolean } | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry?.role === "tool_result") return { isError: entry.isError };
  }
  return null;
}

export function createScriptedWarmModel(ops: EditOp[]): ModelClient {
  let counter = 0;
  const call = (name: string, input: unknown): ModelToolCall => ({ id: `call_${(counter += 1)}`, name, input });
  let applied = false;

  return {
    async next(req: ModelRequest): Promise<ModelTurn> {
      if (!applied) {
        applied = true;
        return { kind: "tool_use", calls: [call("applyEdits", { operations: ops })] };
      }
      if (lastToolResult(req.history)?.isError) {
        // Edit rejected (hard-constraint conflict) — report + offer an alternative, don't force it.
        return {
          kind: "message",
          text: "That change conflicts with a hard constraint; try a different day or a shorter visit.",
        };
      }
      return { kind: "tool_use", calls: [call("finishEditing", {})] };
    },
  };
}
