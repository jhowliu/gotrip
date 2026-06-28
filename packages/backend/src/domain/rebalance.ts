/**
 * Rebalance day assignments to fit a per-day time budget. Used by the agent's
 * re-plan when the Validator reports DAY_TOO_TIGHT: greedily move the outlier
 * place off the heaviest day onto the lightest, until days fit or no move helps.
 * Pure; travel estimate injected.
 */

import type { DayAssignment, GeoLocation, Pace, PlaceDetail } from "./itinerary";
import { haversineMeters } from "./clusterByDay";
import { DAY_START, TRANSIT_BUFFER_MINUTES, paceDayEndCap, toMinutes, visitMinutes } from "./timing";

export interface RebalanceInput {
  assignments: DayAssignment[];
  details: ReadonlyMap<string, PlaceDetail>;
  legMinutes: (a: GeoLocation, b: GeoLocation) => number;
  pace?: Pace;
}

/** Minutes available in a day for the given pace. */
export function dayBudgetMinutes(pace?: Pace): number {
  return toMinutes(paceDayEndCap(pace)) - toMinutes(DAY_START);
}

/** Rough load estimate (visits + transit + meals) without a full schedule. */
export function estimateDayLoadMinutes(
  placeIds: string[],
  details: ReadonlyMap<string, PlaceDetail>,
  legMinutes: (a: GeoLocation, b: GeoLocation) => number,
): number {
  const places = placeIds
    .map((id) => details.get(id))
    .filter((d): d is PlaceDetail => d !== undefined);
  if (places.length === 0) return 0;

  const visit = places.reduce((s, p) => s + visitMinutes(p.category, p.estimatedVisitMinutes), 0);
  let transit = 0;
  for (let i = 1; i < places.length; i += 1) {
    transit += legMinutes(places[i - 1]!.location, places[i]!.location) + TRANSIT_BUFFER_MINUTES;
  }
  let meals = 60; // lunch
  if (visit + transit + meals > 5 * 60) meals += 60; // dinner on a long day
  return visit + transit + meals;
}

function farthestPlaceId(placeIds: string[], details: ReadonlyMap<string, PlaceDetail>): string | null {
  const places = placeIds
    .map((id) => details.get(id))
    .filter((d): d is PlaceDetail => d !== undefined);
  if (places.length === 0) return null;

  const cx = places.reduce((s, p) => s + p.location.lat, 0) / places.length;
  const cy = places.reduce((s, p) => s + p.location.lng, 0) / places.length;
  let best = places[0]!.placeId;
  let bestDist = -1;
  for (const p of places) {
    const d = haversineMeters({ lat: cx, lng: cy }, p.location);
    if (d > bestDist) {
      bestDist = d;
      best = p.placeId;
    }
  }
  return best;
}

export function rebalanceForBudget(input: RebalanceInput): DayAssignment[] {
  const budget = dayBudgetMinutes(input.pace);
  const days = input.assignments.map((a) => ({ dayIndex: a.dayIndex, placeIds: [...a.placeIds] }));

  for (let iter = 0; iter < 50; iter += 1) {
    const loads = days.map((d) => estimateDayLoadMinutes(d.placeIds, input.details, input.legMinutes));
    let heavy = 0;
    let light = 0;
    loads.forEach((l, i) => {
      if (l > loads[heavy]!) heavy = i;
      if (l < loads[light]!) light = i;
    });

    if (loads[heavy]! <= budget) break; // all days fit
    if (heavy === light) break;

    const heavyDay = days[heavy]!;
    if (heavyDay.placeIds.length <= 1) break;
    const moveId = farthestPlaceId(heavyDay.placeIds, input.details);
    if (!moveId) break;

    heavyDay.placeIds = heavyDay.placeIds.filter((id) => id !== moveId);
    days[light]!.placeIds.push(moveId);
  }

  return days;
}
