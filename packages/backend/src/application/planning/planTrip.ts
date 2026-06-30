/**
 * prepareColdStart — the planning entry that wires must-visit resolution (#5)
 * to the cold-start agent. Resolves anchors first (filling place ids + pulling
 * in companions), then seeds the agent's state with those details/candidates and
 * plans over the resolved request. Resolution errors are surfaced, not swallowed.
 */

import type { AgentSpec } from "../agent/AgentSpec";
import type { ToolProvider } from "../ports/ToolProvider";
import type { Location, Place, TripRequest } from "../../domain/itinerary";
import { createColdStartSpec, type PlanningState } from "./coldStart";
import { resolveMustVisits } from "./resolveMustVisits";

/** Ensure the accommodation has coordinates (geocode a name-only entry) so every
 *  search/cluster is anchored to the destination, not searched globally. */
async function withCoords(request: TripRequest, provider: ToolProvider): Promise<Location> {
  const acc = request.accommodation;
  if (typeof acc.lat === "number" && typeof acc.lng === "number") return acc;
  const geo = await provider.geocode({ query: `${acc.name} ${request.destination}` });
  return geo ? { name: acc.name, lat: geo.lat, lng: geo.lng } : acc;
}

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

  const accommodation = await withCoords(request, provider);
  const resolvedRequest: TripRequest = { ...request, accommodation, mustVisit: resolved.mustVisit };
  const spec = createColdStartSpec(resolvedRequest, provider, { details: resolved.details, places });
  return { spec, request: resolvedRequest, resolveErrors: resolved.errors };
}
