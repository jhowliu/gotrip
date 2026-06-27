/**
 * applyEdits — structured edit operations on an Itinerary. Pure and atomic: if
 * any operation is illegal the itinerary is returned unchanged with errors.
 * Only days touched by an edit are re-laid-out; untouched days keep their exact
 * object (byte-identical). Travel/details are injected so it stays I/O-free.
 *
 * Same operation set backs the future drag-and-drop UI; edits are literal (no
 * silent re-optimisation — the user's order is preserved).
 */

import type { GeoLocation, Itinerary, ItineraryDay, PlaceDetail, ValidationResult } from "./itinerary";
import { dayStartTime, layoutDay, type LayoutVisit } from "./schedule";
import { toMinutes, visitMinutes } from "./timing";
import { validate } from "./validate";

export type EditOp =
  | { op: "move"; itemId: string; toDay: number; atTime?: string }
  | { op: "add"; placeId: string; day: number }
  | { op: "remove"; itemId: string }
  | { op: "setDuration"; itemId: string; minutes: number }
  | { op: "pin"; itemId: string };

export interface ApplyEditsDeps {
  details: ReadonlyMap<string, PlaceDetail>;
  legMinutes: (a: GeoLocation, b: GeoLocation) => number;
}

export interface ApplyEditsResult {
  itinerary: Itinerary; // unchanged when errors is non-empty
  validation: ValidationResult;
  errors: string[];
  changed: boolean;
}

interface EditVisit {
  itemId: string;
  placeId: string;
  name: string;
  startTime: string;
  durationMinutes: number;
  pinned: boolean;
  estimatedCost?: number;
}

function buildModel(itinerary: Itinerary): Map<number, EditVisit[]> {
  const model = new Map<number, EditVisit[]>();
  for (const day of itinerary.days) {
    const visits: EditVisit[] = [];
    for (const item of day.items) {
      if (item.kind !== "visit" || !item.placeId) continue;
      visits.push({
        itemId: item.itemId,
        placeId: item.placeId,
        name: item.name,
        startTime: item.startTime,
        durationMinutes: item.durationMinutes,
        pinned: Boolean(item.pinned),
        ...(item.estimatedCost !== undefined ? { estimatedCost: item.estimatedCost } : {}),
      });
    }
    model.set(day.dayIndex, visits);
  }
  return model;
}

function locate(model: Map<number, EditVisit[]>, itemId: string): { dayIndex: number; idx: number } | null {
  for (const [dayIndex, visits] of model) {
    const idx = visits.findIndex((v) => v.itemId === itemId);
    if (idx >= 0) return { dayIndex, idx };
  }
  return null;
}

export function applyEdits(itinerary: Itinerary, ops: EditOp[], deps: ApplyEditsDeps): ApplyEditsResult {
  const dayCount = itinerary.days.length;
  const model = buildModel(itinerary);
  const affected = new Set<number>();
  const errors: string[] = [];

  const unchanged = (): ApplyEditsResult => ({
    itinerary,
    validation: validate(itinerary, deps.details),
    errors,
    changed: false,
  });

  for (const op of ops) {
    switch (op.op) {
      case "move": {
        if (op.toDay < 1 || op.toDay > dayCount) {
          errors.push(`move: day ${op.toDay} out of range`);
          break;
        }
        const loc = locate(model, op.itemId);
        if (!loc) {
          errors.push(`move: item "${op.itemId}" not found`);
          break;
        }
        const moved = model.get(loc.dayIndex)!.splice(loc.idx, 1)[0]!;
        const target = model.get(op.toDay)!;
        if (op.atTime) {
          moved.startTime = op.atTime;
          const at = toMinutes(op.atTime);
          const pos = target.findIndex((v) => toMinutes(v.startTime) > at);
          if (pos < 0) target.push(moved);
          else target.splice(pos, 0, moved);
        } else {
          target.push(moved);
        }
        affected.add(loc.dayIndex).add(op.toDay);
        break;
      }
      case "add": {
        if (op.day < 1 || op.day > dayCount) {
          errors.push(`add: day ${op.day} out of range`);
          break;
        }
        const detail = deps.details.get(op.placeId);
        if (!detail) {
          errors.push(`add: unknown placeId "${op.placeId}"`);
          break;
        }
        model.get(op.day)!.push({
          itemId: `new-${op.placeId}`,
          placeId: op.placeId,
          name: detail.name,
          startTime: "23:59", // appended; layout reassigns
          durationMinutes: visitMinutes(detail.category, detail.estimatedVisitMinutes),
          pinned: false,
          ...(typeof detail.ticketPrice === "number" ? { estimatedCost: detail.ticketPrice } : {}),
        });
        affected.add(op.day);
        break;
      }
      case "remove": {
        const loc = locate(model, op.itemId);
        if (!loc) {
          errors.push(`remove: item "${op.itemId}" not found`);
          break;
        }
        model.get(loc.dayIndex)!.splice(loc.idx, 1);
        affected.add(loc.dayIndex);
        break;
      }
      case "setDuration": {
        if (op.minutes <= 0) {
          errors.push(`setDuration: minutes must be positive`);
          break;
        }
        const loc = locate(model, op.itemId);
        if (!loc) {
          errors.push(`setDuration: item "${op.itemId}" not found`);
          break;
        }
        model.get(loc.dayIndex)![loc.idx]!.durationMinutes = op.minutes;
        affected.add(loc.dayIndex);
        break;
      }
      case "pin": {
        const loc = locate(model, op.itemId);
        if (!loc) {
          errors.push(`pin: item "${op.itemId}" not found`);
          break;
        }
        model.get(loc.dayIndex)![loc.idx]!.pinned = true;
        affected.add(loc.dayIndex);
        break;
      }
    }
    if (errors.length > 0) return unchanged(); // atomic: abort on first error
  }

  // Re-layout only affected days; keep untouched days byte-identical.
  const newDays: ItineraryDay[] = [];
  for (const day of itinerary.days) {
    if (!affected.has(day.dayIndex)) {
      newDays.push(day);
      continue;
    }
    const layout: LayoutVisit[] = [];
    for (const ev of model.get(day.dayIndex) ?? []) {
      const detail = deps.details.get(ev.placeId);
      if (!detail) {
        errors.push(`missing details for "${ev.placeId}" (needed to re-layout day ${day.dayIndex})`);
        return unchanged();
      }
      layout.push({
        placeId: ev.placeId,
        name: ev.name,
        durationMinutes: ev.durationMinutes,
        location: detail.location,
        ...(detail.openWindow ? { openWindow: detail.openWindow } : {}),
        ...(ev.pinned ? { pinned: true } : {}),
        ...(ev.estimatedCost !== undefined ? { estimatedCost: ev.estimatedCost } : {}),
      });
    }
    const items = layoutDay(day.dayIndex, layout, dayStartTime(day.dayIndex, itinerary.request), deps.legMinutes);
    newDays.push({ dayIndex: day.dayIndex, items });
  }

  const totalCost = newDays.reduce(
    (s, d) => s + d.items.reduce((x, i) => x + (i.estimatedCost ?? 0), 0),
    0,
  );
  const next: Itinerary = { request: itinerary.request, days: newDays, totalCost };
  return { itinerary: next, validation: validate(next, deps.details), errors: [], changed: affected.size > 0 };
}
