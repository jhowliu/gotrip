/**
 * Timing rules: visit-duration defaults and "HH:MM" clock arithmetic.
 * Pure functions — independently testable, no I/O.
 */

import type { ItineraryItem } from "./itinerary";

/** Category → typical visit minutes. The primary path when details lack an estimate. */
export const DEFAULT_VISIT_MINUTES: Readonly<Record<string, number>> = {
  museum: 90,
  temple: 45,
  shrine: 45,
  park: 60,
  garden: 60,
  landmark: 30,
  viewpoint: 30,
  market: 60,
  restaurant: 75,
  cafe: 45,
  shopping: 90,
};

export const FALLBACK_VISIT_MINUTES = 60;

/** Resolve a visit duration: explicit estimate → category table → fallback. */
export function visitMinutes(category: string, estimated?: number): number {
  if (typeof estimated === "number" && estimated > 0) return estimated;
  return DEFAULT_VISIT_MINUTES[category.toLowerCase()] ?? FALLBACK_VISIT_MINUTES;
}

export function toMinutes(hhmm: string): number {
  const parts = hhmm.split(":");
  const h = Number(parts[0] ?? 0);
  const m = Number(parts[1] ?? 0);
  return h * 60 + m;
}

export function toHHMM(totalMinutes: number): string {
  const wrapped = ((totalMinutes % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function addMinutes(hhmm: string, delta: number): string {
  return toHHMM(toMinutes(hhmm) + delta);
}

/** endTime is derived, never stored. */
export function endTime(item: Pick<ItineraryItem, "startTime" | "durationMinutes">): string {
  return addMinutes(item.startTime, item.durationMinutes);
}
