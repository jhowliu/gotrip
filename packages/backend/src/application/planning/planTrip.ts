/**
 * prepareColdStart — the planning entry that wires must-visit resolution (#5)
 * to the cold-start agent. Resolves anchors first (filling place ids + pulling
 * in companions), then seeds the agent's state with those details/candidates and
 * plans over the resolved request. Resolution errors are surfaced, not swallowed.
 */

import type { AgentSpec } from "../agent/AgentSpec";
import type { ToolProvider } from "../ports/ToolProvider";
import type { Place, TripRequest } from "../../domain/itinerary";
import { createColdStartSpec, type PlanningState } from "./coldStart";
import { resolveMustVisits } from "./resolveMustVisits";

export interface PreparedColdStart {
  spec: AgentSpec<PlanningState>;
  request: TripRequest; // the request with must-visits resolved (place ids filled)
  resolveErrors: string[];
}

export async function prepareColdStart(request: TripRequest, provider: ToolProvider): Promise<PreparedColdStart> {
  const resolved = await resolveMustVisits(request, provider);

  const places = new Map<string, Place>();
  for (const list of resolved.companions.values()) {
    for (const candidate of list) places.set(candidate.placeId, candidate);
  }

  const resolvedRequest: TripRequest = { ...request, mustVisit: resolved.mustVisit };
  const spec = createColdStartSpec(resolvedRequest, provider, { details: resolved.details, places });
  return { spec, request: resolvedRequest, resolveErrors: resolved.errors };
}
