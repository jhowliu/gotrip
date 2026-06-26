/**
 * The Validator — the reliability core. Pure and deterministic.
 *
 * Hard constraints checked:
 *  - DAY_COUNT          day count equals the requested number of days
 *  - MUST_VISIT_MISSING every must-visit (by placeId) is scheduled
 *  - CLOSED_HOURS       a visit falls within the place's open window (needs details)
 *  - DAY_TOO_TIGHT      a day ends past the pace-adjusted cap
 *
 * Later milestones add flight-buffer and budget. Soft warnings never block.
 */

import type { Itinerary, PlaceDetail, ValidationResult, Violation } from "./itinerary";
import { endTime, paceDayEndCap, toMinutes, withinWindow } from "./timing";

export function validate(
  itinerary: Itinerary,
  details?: ReadonlyMap<string, PlaceDetail>,
): ValidationResult {
  const hardViolations: Violation[] = [];
  const softWarnings: Violation[] = [];
  const { request, days } = itinerary;
  const dayCap = paceDayEndCap(request.pace);

  // Hard: day count must equal the requested number of days.
  if (days.length !== request.days) {
    hardViolations.push({
      code: "DAY_COUNT",
      message: `expected ${request.days} day(s), got ${days.length}`,
      source: "constraint",
    });
  }

  // Hard: every must-visit (by placeId) must be scheduled.
  const scheduled = new Set<string>();
  for (const day of days) {
    for (const item of day.items) {
      if (item.placeId) scheduled.add(item.placeId);
    }
  }
  for (const mv of request.mustVisit ?? []) {
    if (mv.placeId && !scheduled.has(mv.placeId)) {
      hardViolations.push({
        code: "MUST_VISIT_MISSING",
        message: `must-visit "${mv.name}" (${mv.placeId}) is not scheduled`,
        source: "constraint",
      });
    }
  }

  for (const day of days) {
    if (day.items.length === 0) {
      softWarnings.push({
        code: "EMPTY_DAY",
        message: `day ${day.dayIndex} has no items`,
        dayIndex: day.dayIndex,
        source: "constraint",
      });
      continue;
    }

    // Hard: visits must fall inside their place's open window.
    if (details) {
      for (const item of day.items) {
        if (item.kind !== "visit" || !item.placeId) continue;
        const detail = details.get(item.placeId);
        if (detail?.openWindow && !withinWindow(item.startTime, item.durationMinutes, detail.openWindow)) {
          hardViolations.push({
            code: "CLOSED_HOURS",
            message: `"${item.name}" is scheduled ${item.startTime}–${endTime(item)} but is only open ${detail.openWindow[0]}–${detail.openWindow[1]}`,
            dayIndex: day.dayIndex,
            itemId: item.itemId,
            source: "constraint",
          });
        }
      }
    }

    // Hard: the day must not run past the pace cap.
    const last = day.items[day.items.length - 1]!;
    const dayEnd = endTime(last);
    if (toMinutes(dayEnd) > toMinutes(dayCap)) {
      hardViolations.push({
        code: "DAY_TOO_TIGHT",
        message: `day ${day.dayIndex} ends at ${dayEnd}, past the ${dayCap} cap for "${request.pace ?? "default"}" pace`,
        dayIndex: day.dayIndex,
        source: "constraint",
      });
    }

    // Soft: meals should land inside their window.
    for (const item of day.items) {
      if (item.kind === "meal" && item.mealWindow && !withinWindow(item.startTime, item.durationMinutes, item.mealWindow)) {
        softWarnings.push({
          code: "MEAL_OUT_OF_WINDOW",
          message: `${item.name} at ${item.startTime} is outside ${item.mealWindow[0]}–${item.mealWindow[1]}`,
          dayIndex: day.dayIndex,
          itemId: item.itemId,
          source: "constraint",
        });
      }
    }
  }

  return { hardViolations, softWarnings };
}
