/**
 * Assemble a draft Itinerary from day assignments + place details.
 *
 * M0: a deterministic layout — visits only, laid out sequentially from a fixed
 * day start. In M1 the intra-day ordering and meal/transit insertion move to the
 * LLM; this stays as the pure skeleton the LLM (or tests) builds on.
 */

import type {
  DayAssignment,
  Itinerary,
  ItineraryDay,
  ItineraryItem,
  PlaceDetail,
  TripRequest,
} from "./itinerary";
import { endTime, visitMinutes } from "./timing";

const DAY_START = "09:00";

export interface AssembleInput {
  request: TripRequest;
  assignments: DayAssignment[];
  details: ReadonlyMap<string, PlaceDetail>;
  mustVisitIds?: ReadonlySet<string>;
}

export function assembleItinerary(input: AssembleInput): Itinerary {
  const days: ItineraryDay[] = input.assignments.map((assignment) => {
    let cursor = DAY_START;
    const items: ItineraryItem[] = [];

    assignment.placeIds.forEach((placeId, idx) => {
      const detail = input.details.get(placeId);
      if (!detail) return; // unknown place — the validator will flag a missing must-visit

      const durationMinutes = visitMinutes(detail.category, detail.estimatedVisitMinutes);
      const item: ItineraryItem = {
        itemId: `d${assignment.dayIndex}-i${idx + 1}`,
        kind: "visit",
        placeId,
        name: detail.name,
        startTime: cursor,
        durationMinutes,
        ...(input.mustVisitIds?.has(placeId) ? { pinned: true } : {}),
        ...(typeof detail.ticketPrice === "number" ? { estimatedCost: detail.ticketPrice } : {}),
      };
      items.push(item);
      cursor = endTime(item);
    });

    return { dayIndex: assignment.dayIndex, items };
  });

  const totalCost = days.reduce(
    (sum, day) => sum + day.items.reduce((s, item) => s + (item.estimatedCost ?? 0), 0),
    0,
  );

  return { request: input.request, days, totalCost };
}
