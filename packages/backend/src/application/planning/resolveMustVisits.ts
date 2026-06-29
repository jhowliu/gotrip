/**
 * resolveMustVisits (M4 / #5) — turn a loose "I must visit X" into a concrete,
 * guaranteed anchor, provider-agnostic (Google or mock behind the ToolProvider
 * port). Resolution ladder: placeId → location → city-wide text search
 * ("name + destination", accommodation only as a ranking bias). Ambiguity →
 * pick the most relevant. Not-found → an actionable error, never a silently
 * dropped hard constraint. A must-visit far from the accommodation also gets a
 * companion search (nearby places) so its day isn't one isolated stop.
 */

import type { ToolProvider } from "../ports/ToolProvider";
import type { GeoLocation, MustVisit, Place, PlaceDetail, TripRequest } from "../../domain/itinerary";
import { haversineMeters } from "../../domain/clusterByDay";

/** > this far from the accommodation → its own cluster; pull in same-day companions. */
export const FAR_FROM_ACCOMMODATION_M = 6000;
/** Companion search radius around a far must-visit. */
export const COMPANION_RADIUS_M = 2500;

export interface ResolveMustVisitsResult {
  /** request.mustVisit with each entry's placeId/location filled from resolution. */
  mustVisit: MustVisit[];
  /** Resolved details to seed planning state (keyed by placeId). */
  details: Map<string, PlaceDetail>;
  /** Nearby candidates around each far must-visit (keyed by its placeId). */
  companions: Map<string, Place[]>;
  /** Actionable errors — an unresolved must-visit is reported, never dropped. */
  errors: string[];
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function accommodationCenter(request: TripRequest, provider: ToolProvider): Promise<GeoLocation | null> {
  const { name, lat, lng } = request.accommodation;
  if (typeof lat === "number" && typeof lng === "number") return { name, lat, lng };
  return provider.geocode({ query: `${name} ${request.destination}` });
}

async function resolveOne(
  mv: MustVisit,
  request: TripRequest,
  provider: ToolProvider,
  errors: string[],
): Promise<PlaceDetail | null> {
  // 1. placeId → details directly, no search.
  if (mv.placeId) {
    try {
      return await provider.getPlaceDetails({ placeId: mv.placeId });
    } catch {
      errors.push(`must-visit "${mv.name}": place id "${mv.placeId}" could not be loaded`);
      return null;
    }
  }
  // 2. explicit coordinates → use them directly (synthesize a detail).
  const loc = mv.location;
  if (loc && typeof loc.lat === "number" && typeof loc.lng === "number") {
    return { placeId: `mv-${slug(mv.name)}`, name: mv.name, category: "landmark", location: { name: mv.name, lat: loc.lat, lng: loc.lng } };
  }
  // 3. city-wide text search "name + destination" (accommodation as ranking bias, no radius).
  const results = await provider.searchPlaces({ query: `${mv.name} ${request.destination}`, center: request.accommodation, maxResults: 5 });
  const best = results[0]; // search is relevance-ranked; first = best match
  if (!best) {
    errors.push(`must-visit "${mv.name}": not found — confirm the name or add a place id`);
    return null;
  }
  try {
    return await provider.getPlaceDetails({ placeId: best.placeId });
  } catch {
    errors.push(`must-visit "${mv.name}": matched "${best.name}" but its details could not be loaded`);
    return null;
  }
}

export async function resolveMustVisits(request: TripRequest, provider: ToolProvider): Promise<ResolveMustVisitsResult> {
  const result: ResolveMustVisitsResult = { mustVisit: [], details: new Map(), companions: new Map(), errors: [] };
  const center = await accommodationCenter(request, provider);

  for (const mv of request.mustVisit ?? []) {
    const detail = await resolveOne(mv, request, provider, result.errors);
    if (!detail) {
      result.mustVisit.push(mv); // keep it (unresolved); the error is surfaced
      continue;
    }
    result.details.set(detail.placeId, detail);
    result.mustVisit.push({ name: mv.name, placeId: detail.placeId, location: detail.location });

    const far = center ? haversineMeters(center, detail.location) > FAR_FROM_ACCOMMODATION_M : false;
    if (far) {
      const nearby = await provider.searchPlaces({
        query: "top attractions", // generic — geography comes from center + radius
        center: detail.location,
        radius: COMPANION_RADIUS_M,
        type: "attraction",
        maxResults: 6,
      });
      result.companions.set(detail.placeId, nearby.filter((p) => p.placeId !== detail.placeId));
    }
  }
  return result;
}
