/**
 * Constraint-aware scheduler (M1) — lays out each day with transit items, meals,
 * and opening-window-aware placement. Pure; the travel estimate is injected
 * (`legMinutes`) so it stays I/O-free and matches whatever the provider reports.
 *
 * It does its best in one pass; it does NOT guarantee a valid plan. The Validator
 * judges the result and the agent re-plans (reorder with windows, rebalance days)
 * when it reports hard violations.
 */

import type {
  DayAssignment,
  GeoLocation,
  Itinerary,
  ItineraryDay,
  ItineraryItem,
  PlaceDetail,
  TripRequest,
} from "./itinerary";
import { haversineMeters } from "./clusterByDay";
import {
  DAY_START,
  MEAL_SLOTS,
  TRANSIT_BUFFER_MINUTES,
  addMinutes,
  toMinutes,
  visitMinutes,
  type MealSlot,
} from "./timing";

export interface ScheduleOptions {
  /**
   * Order/place places with an openWindow so they land inside it. Defaults to
   * true (honour opening hours). Set false only to deliberately produce a naive
   * plan — used by tests to exercise the CLOSED_HOURS self-correction loop.
   */
  respectWindows?: boolean;
}

export interface ScheduleInput {
  request: TripRequest;
  assignments: DayAssignment[];
  details: ReadonlyMap<string, PlaceDetail>;
  /** Injected travel estimate (minutes) between two points. */
  legMinutes: (from: GeoLocation, to: GeoLocation) => number;
  mustVisitIds?: ReadonlySet<string>;
  options?: ScheduleOptions;
}

function accommodationPoint(request: TripRequest): GeoLocation | null {
  const { name, lat, lng } = request.accommodation;
  return typeof lat === "number" && typeof lng === "number" ? { name, lat, lng } : null;
}

function nearestNeighborOrder(places: PlaceDetail[], start: GeoLocation | null): PlaceDetail[] {
  const remaining = [...places];
  const ordered: PlaceDetail[] = [];
  let cursor: { lat: number; lng: number } | null = start;
  while (remaining.length > 0) {
    let bestIdx = 0;
    if (cursor) {
      let bestDist = Number.POSITIVE_INFINITY;
      remaining.forEach((p, i) => {
        const d = haversineMeters(cursor!, p.location);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      });
    }
    const next = remaining.splice(bestIdx, 1)[0]!;
    ordered.push(next);
    cursor = next.location;
  }
  return ordered;
}

function orderPlaces(placeIds: string[], input: ScheduleInput, start: GeoLocation | null): PlaceDetail[] {
  const detailed = placeIds
    .map((id) => input.details.get(id))
    .filter((d): d is PlaceDetail => d !== undefined);

  if (input.options?.respectWindows ?? true) {
    // windowed places first (earliest window first), so they land in their slot
    const windowed = detailed
      .filter((d) => d.openWindow)
      .sort((a, b) => toMinutes(a.openWindow![0]) - toMinutes(b.openWindow![0]));
    const rest = nearestNeighborOrder(
      detailed.filter((d) => !d.openWindow),
      start,
    );
    return [...windowed, ...rest];
  }
  return nearestNeighborOrder(detailed, start);
}

/** Insert any meal whose preferred start has been reached and is still in-window. */
function placeDueMeals(
  items: ItineraryItem[],
  pending: MealSlot[],
  cursor: string,
  dayIndex: number,
): string {
  let c = cursor;
  for (let i = pending.length - 1; i >= 0; i -= 1) {
    const meal = pending[i]!;
    if (toMinutes(c) < toMinutes(meal.preferredStart)) continue;
    if (toMinutes(c) > toMinutes(meal.window[1])) {
      pending.splice(i, 1); // window missed — drop it
      continue;
    }
    items.push({
      itemId: `d${dayIndex}-meal-${meal.label.toLowerCase()}`,
      kind: "meal",
      name: meal.label,
      startTime: c,
      durationMinutes: meal.durationMinutes,
      mealWindow: meal.window,
    });
    c = addMinutes(c, meal.durationMinutes);
    pending.splice(i, 1);
  }
  return c;
}

function scheduleDay(assignment: DayAssignment, input: ScheduleInput, start: GeoLocation | null): ItineraryDay {
  const ordered = orderPlaces(assignment.placeIds, input, start);
  const items: ItineraryItem[] = [];
  const pending = [...MEAL_SLOTS];
  let cursor = DAY_START;
  let prev: PlaceDetail | null = null;
  let seq = 0;

  for (const place of ordered) {
    if (prev) {
      const dur = input.legMinutes(prev.location, place.location) + TRANSIT_BUFFER_MINUTES;
      seq += 1;
      items.push({
        itemId: `d${assignment.dayIndex}-t${seq}`,
        kind: "transit",
        name: `Transit to ${place.name}`,
        startTime: cursor,
        durationMinutes: dur,
        mode: "transit",
      });
      cursor = addMinutes(cursor, dur);
    }

    cursor = placeDueMeals(items, pending, cursor, assignment.dayIndex);

    let start_ = cursor;
    if ((input.options?.respectWindows ?? true) && place.openWindow && toMinutes(start_) < toMinutes(place.openWindow[0])) {
      start_ = place.openWindow[0]; // wait until it opens
    }
    const duration = visitMinutes(place.category, place.estimatedVisitMinutes);
    seq += 1;
    items.push({
      itemId: `d${assignment.dayIndex}-v${seq}`,
      kind: "visit",
      placeId: place.placeId,
      name: place.name,
      startTime: start_,
      durationMinutes: duration,
      ...(input.mustVisitIds?.has(place.placeId) ? { pinned: true } : {}),
      ...(typeof place.ticketPrice === "number" ? { estimatedCost: place.ticketPrice } : {}),
    });
    cursor = addMinutes(start_, duration);
    prev = place;
  }

  placeDueMeals(items, pending, cursor, assignment.dayIndex);
  items.sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
  return { dayIndex: assignment.dayIndex, items };
}

export function scheduleItinerary(input: ScheduleInput): Itinerary {
  const start = accommodationPoint(input.request);
  const days = input.assignments.map((a) => scheduleDay(a, input, start));
  const totalCost = days.reduce(
    (sum, day) => sum + day.items.reduce((s, item) => s + (item.estimatedCost ?? 0), 0),
    0,
  );
  return { request: input.request, days, totalCost };
}
