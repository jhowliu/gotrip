/**
 * The Validator — the reliability core. Pure and deterministic.
 *
 * M0 scope: only two hard constraints (day count, must-visits present). Later
 * milestones extend this with opening-hours, travel feasibility, flight buffer,
 * and budget. Soft warnings are surfaced but never block.
 */

import type { Itinerary, ValidationResult, Violation } from "./itinerary";

export function validate(itinerary: Itinerary): ValidationResult {
  const hardViolations: Violation[] = [];
  const softWarnings: Violation[] = [];
  const { request, days } = itinerary;

  // Hard: day count must equal the requested number of days.
  if (days.length !== request.days) {
    hardViolations.push({
      code: "DAY_COUNT",
      message: `expected ${request.days} day(s), got ${days.length}`,
      source: "constraint",
    });
  }

  // Hard: every must-visit (identified by placeId) must be scheduled.
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

  // Soft: a day with no items is unusual but not invalid.
  for (const day of days) {
    if (day.items.length === 0) {
      softWarnings.push({
        code: "EMPTY_DAY",
        message: `day ${day.dayIndex} has no items`,
        dayIndex: day.dayIndex,
        source: "constraint",
      });
    }
  }

  return { hardViolations, softWarnings };
}
