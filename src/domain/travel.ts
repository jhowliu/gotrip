/**
 * Travel-time estimation — shared by the mock provider (getTravelTime) and the
 * scheduler (transit items), so a transit block matches what the tool reports.
 * Pure; coordinate-based. Real Google Routes replaces this behind the provider
 * port in M4.
 */

import type { TravelMode } from "./itinerary";
import { haversineMeters } from "./clusterByDay";

const METERS_PER_MIN: Readonly<Record<TravelMode, number>> = {
  walking: 80,
  driving: 600,
  transit: 400,
};

const WAIT_MINUTES: Readonly<Record<TravelMode, number>> = {
  walking: 0,
  driving: 0,
  transit: 5,
};

export function estimateTravelMinutes(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  mode: TravelMode = "transit",
): number {
  const meters = haversineMeters(from, to);
  return Math.round(meters / METERS_PER_MIN[mode]) + WAIT_MINUTES[mode];
}
