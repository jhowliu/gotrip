/**
 * Formatter skill — render an Itinerary as readable text or canonical JSON.
 * Pure; independently testable.
 */

import type { Itinerary } from "../../domain/itinerary";
import { endTime } from "../../domain/timing";

export function formatItineraryJson(itinerary: Itinerary): string {
  return JSON.stringify(itinerary, null, 2);
}

export function formatItineraryText(itinerary: Itinerary): string {
  const { request, days } = itinerary;
  const lines: string[] = [];
  lines.push(`Trip to ${request.destination} — ${request.days} day(s)`);
  if (typeof itinerary.totalCost === "number") {
    lines.push(`Estimated cost: ${itinerary.totalCost}`);
  }
  lines.push("");

  for (const day of days) {
    lines.push(`Day ${day.dayIndex}`);
    if (day.items.length === 0) {
      lines.push("  (no items)");
    }
    for (const item of day.items) {
      const span = `${item.startTime}–${endTime(item)}`;
      const tags: string[] = [item.kind];
      if (item.pinned) tags.push("must-visit");
      lines.push(`  ${span}  ${item.name} [${tags.join(", ")}]`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
