/**
 * Timing rules: visit-duration defaults and "HH:MM" clock arithmetic.
 * Pure functions — independently testable, no I/O.
 */

import type { ItineraryItem, Pace } from "./itinerary";

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

/** Each day starts here. */
export const DAY_START = "09:00";

/** Conservative buffer: leave for the airport this long before departure. */
export const AIRPORT_BUFFER_MINUTES = 180;

/** Landing → ready to start sightseeing (immigration, baggage, transfer). */
export const ARRIVAL_TRANSFER_MINUTES = 90;

/** Extract "HH:MM" from an ISO datetime, lexically (timezone-stable for tests). */
export function timeOfDayFromIso(iso: string): string {
  const t = iso.split("T")[1] ?? "";
  const hhmm = t.slice(0, 5);
  return /^\d{2}:\d{2}$/.test(hhmm) ? hhmm : "00:00";
}

/** Buffer added to every transit leg, absorbing headway/transfer variance. */
export const TRANSIT_BUFFER_MINUTES = 10;

/**
 * Latest a day should end, by pace. Relaxed days end earlier (more slack);
 * packed days run later. Used by the DAY_TOO_TIGHT check.
 */
export function paceDayEndCap(pace?: Pace): string {
  if (pace === "relaxed") return "19:00";
  if (pace === "packed") return "21:00";
  return "20:00";
}

export interface MealSlot {
  label: string;
  window: [string, string];
  preferredStart: string;
  durationMinutes: number;
}

export const MEAL_SLOTS: readonly MealSlot[] = [
  { label: "Lunch", window: ["11:30", "13:30"], preferredStart: "12:00", durationMinutes: 60 },
  { label: "Dinner", window: ["18:00", "20:00"], preferredStart: "18:30", durationMinutes: 60 },
];

/** Is [start, start+duration] fully inside [window.0, window.1]? */
export function withinWindow(start: string, durationMinutes: number, window: [string, string]): boolean {
  const s = toMinutes(start);
  const e = s + durationMinutes;
  return s >= toMinutes(window[0]) && e <= toMinutes(window[1]);
}
