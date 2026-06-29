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
  ARRIVAL_TRANSFER_MINUTES,
  DAY_START,
  MEAL_SLOTS,
  TRANSIT_BUFFER_MINUTES,
  addMinutes,
  timeOfDayFromIso,
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

export function dayStartTime(dayIndex: number, request: TripRequest): string {
  if (dayIndex === 1 && request.arrival) {
    const ready = addMinutes(timeOfDayFromIso(request.arrival.datetime), ARRIVAL_TRANSFER_MINUTES);
    return toMinutes(ready) > toMinutes(DAY_START) ? ready : DAY_START;
  }
  return DAY_START;
}

/** A visit resolved into everything the day layout needs. */
export interface LayoutVisit {
  placeId: string;
  name: string;
  durationMinutes: number;
  location: GeoLocation;
  openWindow?: [string, string];
  pinned?: boolean;
  estimatedCost?: number;
}

export function toLayoutVisit(place: PlaceDetail, mustVisitIds?: ReadonlySet<string>): LayoutVisit {
  return {
    placeId: place.placeId,
    name: place.name,
    durationMinutes: visitMinutes(place.category, place.estimatedVisitMinutes),
    location: place.location,
    ...(place.openWindow ? { openWindow: place.openWindow } : {}),
    ...(mustVisitIds?.has(place.placeId) ? { pinned: true } : {}),
    ...(typeof place.ticketPrice === "number" ? { estimatedCost: place.ticketPrice } : {}),
  };
}

/**
 * Lay out one day from an ordered visit list: transit items between visits,
 * meals in their windows, opening-window-aware start times. Shared by the cold
 * scheduler and applyEdits (which preserves the user's order).
 */
export function layoutDay(
  dayIndex: number,
  ordered: LayoutVisit[],
  dayStart: string,
  legMinutes: (a: GeoLocation, b: GeoLocation) => number,
  respectWindows = true,
): ItineraryItem[] {
  const items: ItineraryItem[] = [];
  const pending = [...MEAL_SLOTS];
  let cursor = dayStart;
  let prev: LayoutVisit | null = null;
  let seq = 0;

  for (const v of ordered) {
    if (prev) {
      const dur = legMinutes(prev.location, v.location) + TRANSIT_BUFFER_MINUTES;
      seq += 1;
      items.push({
        itemId: `d${dayIndex}-t${seq}`,
        kind: "transit",
        name: `Transit to ${v.name}`,
        startTime: cursor,
        durationMinutes: dur,
        mode: "transit",
      });
      cursor = addMinutes(cursor, dur);
    }

    cursor = placeDueMeals(items, pending, cursor, dayIndex);

    let start_ = cursor;
    if (respectWindows && v.openWindow && toMinutes(start_) < toMinutes(v.openWindow[0])) {
      start_ = v.openWindow[0]; // wait until it opens
    }
    seq += 1;
    items.push({
      itemId: `d${dayIndex}-v${seq}`,
      kind: "visit",
      placeId: v.placeId,
      name: v.name,
      startTime: start_,
      durationMinutes: v.durationMinutes,
      ...(v.pinned ? { pinned: true } : {}),
      ...(typeof v.estimatedCost === "number" ? { estimatedCost: v.estimatedCost } : {}),
    });
    cursor = addMinutes(start_, v.durationMinutes);
    prev = v;
  }

  placeDueMeals(items, pending, cursor, dayIndex);
  items.sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
  return items;
}

function scheduleDay(assignment: DayAssignment, input: ScheduleInput, start: GeoLocation | null): ItineraryDay {
  const ordered = orderPlaces(assignment.placeIds, input, start).map((p) =>
    toLayoutVisit(p, input.mustVisitIds),
  );
  const items = layoutDay(
    assignment.dayIndex,
    ordered,
    dayStartTime(assignment.dayIndex, input.request),
    input.legMinutes,
    input.options?.respectWindows ?? true,
  );
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
