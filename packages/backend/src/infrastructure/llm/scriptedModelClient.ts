/**
 * Scripted ModelClient — a deterministic stand-in for the LLM. Drives the
 * cold-start path through the same tools the real agent uses (searchPlaces →
 * getPlaceDetails → planDays → finalizeItinerary) and, crucially, *self-corrects*:
 * when planDays reports a blocking violation it drops the priciest non-must-visit
 * and re-plans, until the plan is feasible or nothing more can be dropped (then it
 * exits gracefully). Lets the whole loop be tested without an API. The real model
 * (OpenAIModelClient) does this dynamically and with far richer regrouping.
 */

import type { HistoryItem, ModelClient, ModelRequest, ModelToolCall, ModelTurn } from "../../application/ports/ModelClient";
import type { TripRequest } from "../../domain/itinerary";

type Phase = "search" | "details" | "plan" | "await" | "done";

/** DAY_TOO_LIGHT never blocks finalize, so it doesn't warrant dropping a place. */
const NON_BLOCKING = new Set(["DAY_TOO_LIGHT"]);
/** Safety net on recovery attempts (termination also comes from running out of drops). */
const MAX_DROPS = 8;

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

/** Every result of a given tool, newest first, parsed. */
function toolResults(history: HistoryItem[], toolName: string): unknown[] {
  const names = callNames(history);
  const out: unknown[] = [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry?.role !== "tool_result" || names.get(entry.callId) !== toolName) continue;
    try {
      out.push(JSON.parse(entry.content));
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** Candidate refs the first searchPlaces surfaced, with their names. */
function searchedRefs(history: HistoryItem[]): { ref: string; name: string }[] {
  const results = toolResults(history, "searchPlaces");
  const first = results[results.length - 1]; // oldest search = the initial wide net
  if (!Array.isArray(first)) return [];
  return (first as { ref?: string; name?: string }[])
    .filter((p): p is { ref: string; name: string } => typeof p.ref === "string" && typeof p.name === "string")
    .map((p) => ({ ref: p.ref, name: p.name }));
}

/** ref → ticketPrice, from getPlaceDetails results (drop the priciest first). */
function refCosts(history: HistoryItem[]): Map<string, number> {
  const costs = new Map<string, number>();
  for (const r of toolResults(history, "getPlaceDetails")) {
    if (r && typeof r === "object" && "ref" in r) {
      const ref = String((r as { ref: unknown }).ref);
      const price = Number((r as { ticketPrice?: unknown }).ticketPrice ?? 0);
      costs.set(ref, Number.isFinite(price) ? price : 0);
    }
  }
  return costs;
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

/** Split refs round-robin across the requested days; drop empty days. */
function buildDays(refs: string[], days: number): { day: number; refs: string[] }[] {
  const n = Math.max(1, Math.floor(days));
  const out = Array.from({ length: n }, (_, i) => ({ day: i + 1, refs: [] as string[] }));
  refs.forEach((ref, i) => out[i % n]!.refs.push(ref));
  return out.filter((d) => d.refs.length > 0);
}

export function createScriptedColdStartModel(request: TripRequest): ModelClient {
  let callCounter = 0;
  const nextId = (): string => `call_${(callCounter += 1)}`;
  const call = (name: string, input: unknown): ModelToolCall => ({ id: nextId(), name, input });

  const mustVisitNames = new Set((request.mustVisit ?? []).map((m) => m.name));
  const dropped = new Set<string>();
  let phase: Phase = "search";

  return {
    async next(req: ModelRequest): Promise<ModelTurn> {
      // Emit planDays for the current (un-dropped) candidate set.
      const planTurn = (): ModelTurn => {
        phase = "await";
        const refs = searchedRefs(req.history)
          .filter((p) => !dropped.has(p.ref))
          .map((p) => p.ref);
        return { kind: "tool_use", calls: [call("planDays", { days: buildDays(refs, request.days) })] };
      };

      switch (phase) {
        case "search":
          phase = "details";
          return { kind: "tool_use", calls: [call("searchPlaces", { query: "top attractions", type: "attraction" })] };

        case "details": {
          phase = "plan";
          const searched = searchedRefs(req.history).map((p) => p.ref);
          // must-visits aren't from search (no ref) — pass their id; the tool tolerates it.
          const mustVisit = (request.mustVisit ?? [])
            .map((m) => m.placeId)
            .filter((id): id is string => typeof id === "string");
          const refs = [...new Set([...searched, ...mustVisit])];
          return { kind: "tool_use", calls: refs.map((ref) => call("getPlaceDetails", { ref })) };
        }

        case "plan":
          return planTurn();

        case "await": {
          const codes = violationCodes(lastToolResultContent(req.history));
          const blocking = codes.filter((c) => !NON_BLOCKING.has(c));
          if (blocking.length === 0) {
            phase = "done";
            return { kind: "tool_use", calls: [call("finalizeItinerary", {})] };
          }
          // Recover: drop the priciest droppable (non-must-visit) place and re-plan.
          const costs = refCosts(req.history);
          const candidate = searchedRefs(req.history)
            .filter((p) => !dropped.has(p.ref) && !mustVisitNames.has(p.name))
            .sort((a, b) => (costs.get(b.ref) ?? 0) - (costs.get(a.ref) ?? 0))[0];
          if (!candidate || dropped.size >= MAX_DROPS) {
            phase = "done";
            return { kind: "message", text: "Could not satisfy all hard constraints (e.g. flight buffer) for this trip." };
          }
          dropped.add(candidate.ref);
          return planTurn();
        }

        default:
          return { kind: "message", text: "done" };
      }
    },
  };
}
