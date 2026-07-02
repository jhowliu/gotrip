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
import { orderByShortestPath } from "./route";
import { estimateMealCost } from "./pricing";
import {
  ARRIVAL_TRANSFER_MINUTES,
  DAY_START,
  MEAL_SLOTS,
  TRANSIT_BUFFER_MINUTES,
  addMinutes,
  dayEndMinutes,
  timeOfDayFromIso,
  toClock,
  toMinutes,
  visitMinutes,
  withinWindow,
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
  /** Candidate restaurants per day (1-based) — placed into meal slots, not as visits. */
  mealsByDay?: ReadonlyMap<number, PlaceDetail[]>;
  /** Day indices (1-based) built around a far anchor — a long commute is expected,
   *  so the day-end cap / light-day check don't apply. */
  dayTripDays?: ReadonlySet<number>;
  options?: ScheduleOptions;
}

function accommodationPoint(request: TripRequest): GeoLocation | null {
  const { name, lat, lng } = request.accommodation;
  return typeof lat === "number" && typeof lng === "number" ? { name, lat, lng } : null;
}

/** Opens at/after this → an evening venue (night market), scheduled LAST. */
const EVENING_OPEN_LIMIT = "16:00";
/** Closes before this → a morning/early place that must be done FIRST. */
const MORNING_CLOSE_LIMIT = "16:00";

type WindowKind = "morning" | "evening" | "flexible";

/**
 * Where in the day a visit belongs, by its open window. A place that opens late
 * (a night market) is anchored to the EVENING; one that closes early (a museum
 * shutting at noon) to the MORNING; everything else is flexible and routed by
 * proximity in between. This is by time-of-day, not "restricted → go first" — so a
 * 17:00 night market lands last, instead of dragging the whole day to start at 17:00.
 */
function windowKind(window?: [string, string]): WindowKind {
  if (!window) return "flexible";
  if (toMinutes(window[0]) >= toMinutes(EVENING_OPEN_LIMIT)) return "evening";
  if (toMinutes(window[1]) < toMinutes(MORNING_CLOSE_LIMIT)) return "morning";
  return "flexible";
}

const windowLength = (w: [string, string]): number => toMinutes(w[1]) - toMinutes(w[0]);

function orderPlaces(placeIds: string[], input: ScheduleInput, start: GeoLocation | null): PlaceDetail[] {
  const detailed = placeIds
    .map((id) => input.details.get(id))
    .filter((d): d is PlaceDetail => d !== undefined);

  // Order by the injected travel cost (real matrix when available, else geometric)
  // so the route reflects actual road distances rather than straight lines.
  const cost = input.legMinutes;
  if (!(input.options?.respectWindows ?? true)) {
    // Naive order (no window awareness) — used to exercise self-correction.
    return orderByShortestPath(detailed, start, cost);
  }

  // Anchor time-restricted places to their part of the day; route the flexible ones
  // by shortest path in between. Tie-break by tightness (shorter window first) so the
  // most-constrained place wins its slot.
  const kindOf = (d: PlaceDetail): WindowKind => windowKind(d.openWindow);
  const morning = detailed
    .filter((d) => kindOf(d) === "morning")
    .sort((a, b) => toMinutes(a.openWindow![1]) - toMinutes(b.openWindow![1]) || windowLength(a.openWindow!) - windowLength(b.openWindow!));
  const evening = detailed
    .filter((d) => kindOf(d) === "evening")
    .sort((a, b) => toMinutes(a.openWindow![0]) - toMinutes(b.openWindow![0]) || windowLength(a.openWindow!) - windowLength(b.openWindow!));
  const flexible = detailed.filter((d) => kindOf(d) === "flexible");
  const afterMorning = morning.length > 0 ? morning[morning.length - 1]!.location : start;
  return [...morning, ...orderByShortestPath(flexible, afterMorning, cost), ...evening];
}

/** Insert any meal whose preferred start has been reached and is still in-window. */
function placeDueMeals(
  items: ItineraryItem[],
  pending: MealSlot[],
  cursor: string,
  dayIndex: number,
  mealCandidates: PlaceDetail[],
): string {
  let c = cursor;
  for (let i = pending.length - 1; i >= 0; i -= 1) {
    const meal = pending[i]!;
    if (toMinutes(c) < toMinutes(meal.preferredStart)) continue;
    if (toMinutes(c) > toMinutes(meal.window[1])) {
      pending.splice(i, 1); // window missed — drop it
      continue;
    }
    // Prefer a real restaurant open at this meal time; else a generic meal block.
    const pickIdx = bestMealCandidate(mealCandidates, c, meal.durationMinutes);
    const restaurant = pickIdx >= 0 ? mealCandidates.splice(pickIdx, 1)[0]! : null;
    items.push({
      itemId: `d${dayIndex}-meal-${meal.label.toLowerCase()}`,
      kind: "meal",
      name: restaurant ? restaurant.name : meal.label,
      startTime: c,
      durationMinutes: meal.durationMinutes,
      mealWindow: meal.window,
      ...(restaurant ? { placeId: restaurant.placeId, estimatedCost: estimateMealCost(restaurant.priceLevel) } : {}),
    });
    c = addMinutes(c, meal.durationMinutes);
    pending.splice(i, 1);
  }
  return c;
}

/** Highest-rated candidate open across [start, start+duration]; -1 if none fit. */
function bestMealCandidate(candidates: PlaceDetail[], start: string, durationMinutes: number): number {
  let best = -1;
  let bestRating = -1;
  candidates.forEach((c, i) => {
    if (c.openWindow && !withinWindow(start, durationMinutes, c.openWindow)) return;
    const rating = c.rating ?? 0;
    if (rating > bestRating) {
      bestRating = rating;
      best = i;
    }
  });
  return best;
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
  mealCandidates: PlaceDetail[] = [],
  /** When set (day-trip days), schedule the accommodation→first and last→accommodation
   *  legs so the long commute is timed, not invisible. */
  commuteFrom: GeoLocation | null = null,
): ItineraryItem[] {
  const items: ItineraryItem[] = [];
  const pending = [...MEAL_SLOTS];
  const meals = [...mealCandidates]; // mutated as candidates are consumed
  let cursor = dayStart;
  // Seed `prev` with the accommodation on a day-trip day so the first leg (the long
  // drive out) is scheduled just like any inter-stop leg.
  let prev: { location: GeoLocation } | null = commuteFrom ? { location: commuteFrom } : null;
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

    cursor = placeDueMeals(items, pending, cursor, dayIndex, meals);

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

  // Return leg home (day-trip days) — the drive back is part of the day.
  if (commuteFrom && ordered.length > 0 && prev) {
    const dur = legMinutes(prev.location, commuteFrom) + TRANSIT_BUFFER_MINUTES;
    seq += 1;
    items.push({
      itemId: `d${dayIndex}-t${seq}`,
      kind: "transit",
      name: `Transit to ${commuteFrom.name}`,
      startTime: cursor,
      durationMinutes: dur,
      mode: "transit",
    });
    cursor = addMinutes(cursor, dur);
  }

  placeDueMeals(items, pending, cursor, dayIndex, meals);
  items.sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
  return items;
}

function scheduleDay(assignment: DayAssignment, input: ScheduleInput, start: GeoLocation | null): ItineraryDay {
  const ordered = orderPlaces(assignment.placeIds, input, start).map((p) =>
    toLayoutVisit(p, input.mustVisitIds),
  );
  const dayTrip = input.dayTripDays?.has(assignment.dayIndex) ?? false;
  const items = layoutDay(
    assignment.dayIndex,
    ordered,
    dayStartTime(assignment.dayIndex, input.request),
    input.legMinutes,
    input.options?.respectWindows ?? true,
    input.mealsByDay?.get(assignment.dayIndex) ?? [],
    dayTrip ? start : null, // time the commute out-and-back on a day-trip day
  );
  return { dayIndex: assignment.dayIndex, items, ...(dayTrip ? { dayTrip: true } : {}) };
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

/** Per-day travel time is a legibility/quality signal — a lopsided plan (one heavy
 *  day, one light) or an over-long day shows up here for the agent to rebalance.
 *  `places` names the day's visits (must-visits flagged) so the agent can see WHAT
 *  is on each day — e.g. a far pinned anchor that's blowing up the travel time. */
export interface DaySummary {
  day: number;
  visits: number;
  travelMinutes: number;
  /** Display end ("24:09" when the day runs past midnight — deliberately not wrapped). */
  endsAt: string;
  /** Absolute end minutes (may exceed 1440) — what the day-end guards compare on. */
  endsAtMinutes: number;
  /** Visit names in order; a pinned must-visit is marked so the agent recognises it. */
  places: string[];
  /** Present when this is a day-trip day (long commute expected). */
  dayTrip?: boolean;
}

export function summariseDays(itinerary: Itinerary): { totalTravelMinutes: number; days: DaySummary[] } {
  const days = itinerary.days.map((d): DaySummary => {
    const travelMinutes = d.items
      .filter((i) => i.kind === "transit")
      .reduce((s, i) => s + i.durationMinutes, 0);
    const endsAtMinutes = dayEndMinutes(d.items);
    const places = d.items
      .filter((i) => i.kind === "visit")
      .map((i) => (i.pinned ? `${i.name} (must-visit)` : i.name));
    return {
      day: d.dayIndex,
      visits: places.length,
      travelMinutes,
      endsAt: toClock(endsAtMinutes),
      endsAtMinutes,
      places,
      ...(d.dayTrip ? { dayTrip: true } : {}),
    };
  });
  return { totalTravelMinutes: days.reduce((s, d) => s + d.travelMinutes, 0), days };
}
