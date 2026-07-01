/**
 * Scripted ModelClient — a deterministic stand-in for the LLM. Drives the
 * cold-start path and, crucially, *self-corrects*: when finalize reports hard
 * violations it re-plans (rebalance days for DAY_TOO_TIGHT, respect windows for
 * CLOSED_HOURS) and retries once. Lets the whole self-correction loop be tested
 * without an API. The real model (OpenAIModelClient) does this dynamically.
 */

import type { HistoryItem, ModelClient, ModelRequest, ModelToolCall, ModelTurn } from "../../application/ports/ModelClient";
import type { Place, TripRequest } from "../../domain/itinerary";

type Phase =
  | "search"
  | "details"
  | "cluster"
  | "assemble"
  | "finalize"
  | "check"
  | "replan-assemble"
  | "replan-finalize"
  | "done";

function callNames(history: HistoryItem[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const entry of history) {
    if (entry.role === "assistant" && entry.turn.kind === "tool_use") {
      for (const call of entry.turn.calls) names.set(call.id, call.name);
    }
  }
  return names;
}

function lastToolResultContent(history: HistoryItem[]): unknown {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry?.role === "tool_result") {
      try {
        return JSON.parse(entry.content);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function lastSearchRefs(history: HistoryItem[]): string[] {
  const names = callNames(history);
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry?.role !== "tool_result") continue;
    if (names.get(entry.callId) !== "searchPlaces") continue;
    try {
      const data: unknown = JSON.parse(entry.content);
      if (Array.isArray(data)) {
        return (data as { ref?: string }[]).map((p) => p.ref).filter((r): r is string => typeof r === "string");
      }
    } catch {
      /* ignore */
    }
    return [];
  }
  return [];
}

function violationCodes(content: unknown): string[] {
  if (content && typeof content === "object" && "hardViolations" in content) {
    const list = (content as { hardViolations?: unknown }).hardViolations;
    if (Array.isArray(list)) {
      return list
        .map((v) => (v && typeof v === "object" && "code" in v ? String((v as { code: unknown }).code) : ""))
        .filter(Boolean);
    }
  }
  return [];
}

export function createScriptedColdStartModel(request: TripRequest): ModelClient {
  let callCounter = 0;
  const nextId = (): string => `call_${(callCounter += 1)}`;
  const call = (name: string, input: unknown): ModelToolCall => ({ id: nextId(), name, input });

  let phase: Phase = "search";
  let retried = false;

  return {
    async next(req: ModelRequest): Promise<ModelTurn> {
      switch (phase) {
        case "search":
          phase = "details";
          return { kind: "tool_use", calls: [call("searchPlaces", { query: "top attractions", type: "attraction" })] };

        case "details": {
          phase = "cluster";
          const searched = lastSearchRefs(req.history);
          // must-visits aren't from search (no ref) — pass their id; the tool tolerates it.
          const mustVisit = (request.mustVisit ?? [])
            .map((m) => m.placeId)
            .filter((id): id is string => typeof id === "string");
          const refs = [...new Set([...searched, ...mustVisit])];
          return { kind: "tool_use", calls: refs.map((ref) => call("getPlaceDetails", { ref })) };
        }

        case "cluster":
          phase = "assemble";
          return { kind: "tool_use", calls: [call("clusterByDay", {})] };

        case "assemble":
          phase = "finalize";
          // Deliberately naive first pass (scheduler defaults to window-aware) so
          // the adversarial fixture trips CLOSED_HOURS and the loop is exercised.
          return { kind: "tool_use", calls: [call("assembleItinerary", { respectWindows: false })] };

        case "finalize":
          phase = "check";
          return { kind: "tool_use", calls: [call("finalizeItinerary", {})] };

        case "check": {
          // Reached only if the previous finalize failed (success ends the loop).
          if (retried) {
            return { kind: "message", text: "Could not satisfy all hard constraints within budget." };
          }
          retried = true;
          const codes = violationCodes(lastToolResultContent(req.history));
          if (codes.includes("BUDGET_EXCEEDED")) {
            phase = "replan-assemble";
            return { kind: "tool_use", calls: [call("trimToBudget", {})] };
          }
          if (codes.includes("DAY_TOO_TIGHT") || codes.includes("FLIGHT_BUFFER")) {
            phase = "replan-assemble";
            return { kind: "tool_use", calls: [call("rebalanceDays", {})] };
          }
          // CLOSED_HOURS / ARRIVAL etc.: re-assemble honouring windows, then finalize.
          phase = "replan-finalize";
          return { kind: "tool_use", calls: [call("assembleItinerary", { respectWindows: true })] };
        }

        case "replan-assemble":
          phase = "replan-finalize";
          return { kind: "tool_use", calls: [call("assembleItinerary", { respectWindows: true })] };

        case "replan-finalize":
          phase = "check";
          return { kind: "tool_use", calls: [call("finalizeItinerary", {})] };

        default:
          return { kind: "message", text: "done" };
      }
    },
  };
}
