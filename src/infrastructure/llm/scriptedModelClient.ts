/**
 * Scripted ModelClient — a deterministic stand-in for the LLM (M0). It drives the
 * cold-start happy path (search → details → cluster → assemble → finalize) so the
 * whole loop runs end-to-end with zero API cost and is fully testable. The real
 * Claude tool-use client (AnthropicModelClient) arrives in M1.
 */

import type { HistoryItem, ModelClient, ModelRequest, ModelTurn } from "../../application/ports/ModelClient";
import type { Place, TripRequest } from "../../domain/itinerary";

function parseLastSearchPlaceIds(history: HistoryItem[]): string[] {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry?.role !== "tool_result") continue;
    try {
      const data: unknown = JSON.parse(entry.content);
      if (Array.isArray(data)) {
        return (data as Place[]).map((p) => p.placeId).filter((id): id is string => typeof id === "string");
      }
    } catch {
      // not the search result — fall through
    }
    return [];
  }
  return [];
}

export function createScriptedColdStartModel(request: TripRequest): ModelClient {
  let callCounter = 0;
  const nextId = (): string => `call_${(callCounter += 1)}`;

  return {
    async next(req: ModelRequest): Promise<ModelTurn> {
      const step = req.history.filter((h) => h.role === "assistant").length;

      switch (step) {
        case 0:
          return {
            kind: "tool_use",
            calls: [{ id: nextId(), name: "searchPlaces", input: { query: "top attractions", type: "attraction" } }],
          };
        case 1: {
          const searched = parseLastSearchPlaceIds(req.history);
          const mustVisit = (request.mustVisit ?? [])
            .map((m) => m.placeId)
            .filter((id): id is string => typeof id === "string");
          const ids = [...new Set([...searched, ...mustVisit])];
          return {
            kind: "tool_use",
            calls: ids.map((placeId) => ({ id: nextId(), name: "getPlaceDetails", input: { placeId } })),
          };
        }
        case 2:
          return { kind: "tool_use", calls: [{ id: nextId(), name: "clusterByDay", input: {} }] };
        case 3:
          return { kind: "tool_use", calls: [{ id: nextId(), name: "assembleItinerary", input: {} }] };
        default:
          return { kind: "tool_use", calls: [{ id: nextId(), name: "finalizeItinerary", input: {} }] };
      }
    },
  };
}
