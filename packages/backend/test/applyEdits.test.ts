import { describe, expect, it } from "vitest";
import type { ApplyEditsDeps } from "../src/domain/applyEdits";
import type { Itinerary, TripRequest } from "../src/domain/itinerary";
import { applyEdits } from "../src/domain/applyEdits";
import { scheduleItinerary } from "../src/domain/schedule";
import { TOKYO_ACCOMMODATION, TOKYO_PLACES } from "../src/infrastructure/tools/mock/fixtures";

function setup(): { itinerary: Itinerary; deps: ApplyEditsDeps } {
  const details = new Map(TOKYO_PLACES.map((p) => [p.placeId, p]));
  const request: TripRequest = { days: 2, destination: "Tokyo", accommodation: TOKYO_ACCOMMODATION };
  const legMinutes = (): number => 15;
  const itinerary = scheduleItinerary({
    request,
    assignments: [
      { dayIndex: 1, placeIds: ["p_teamlab", "p_meiji"] },
      { dayIndex: 2, placeIds: ["p_sensoji", "p_ueno"] },
    ],
    details,
    legMinutes,
  });
  return { itinerary, deps: { details, legMinutes } };
}

function firstVisit(itinerary: Itinerary, dayIdx = 0) {
  return itinerary.days[dayIdx]!.items.find((i) => i.kind === "visit")!;
}

describe("applyEdits", () => {
  it("setDuration changes the item and re-flows its day", () => {
    const { itinerary, deps } = setup();
    const visit = firstVisit(itinerary);
    const res = applyEdits(itinerary, [{ op: "setDuration", itemId: visit.itemId, minutes: 200 }], deps);
    expect(res.errors).toHaveLength(0);
    const updated = res.itinerary.days[0]!.items.find((i) => i.placeId === visit.placeId)!;
    expect(updated.durationMinutes).toBe(200);
  });

  it("remove drops the item; pin marks it", () => {
    const { itinerary, deps } = setup();
    const visit = firstVisit(itinerary);

    const removed = applyEdits(itinerary, [{ op: "remove", itemId: visit.itemId }], deps);
    expect(removed.itinerary.days[0]!.items.some((i) => i.placeId === visit.placeId)).toBe(false);

    const pinned = applyEdits(itinerary, [{ op: "pin", itemId: visit.itemId }], deps);
    expect(pinned.itinerary.days[0]!.items.find((i) => i.placeId === visit.placeId)!.pinned).toBe(true);
  });

  it("move relocates an item to another day", () => {
    const { itinerary, deps } = setup();
    const visit = firstVisit(itinerary);
    const res = applyEdits(itinerary, [{ op: "move", itemId: visit.itemId, toDay: 2 }], deps);
    expect(res.itinerary.days[0]!.items.some((i) => i.placeId === visit.placeId)).toBe(false);
    expect(res.itinerary.days[1]!.items.some((i) => i.placeId === visit.placeId)).toBe(true);
  });

  it("add inserts a place into a day", () => {
    const { itinerary, deps } = setup();
    const res = applyEdits(itinerary, [{ op: "add", placeId: "p_shibuya", day: 1 }], deps);
    expect(res.errors).toHaveLength(0);
    expect(res.itinerary.days[0]!.items.some((i) => i.placeId === "p_shibuya")).toBe(true);
  });

  it("rejects an illegal op and leaves the itinerary unchanged", () => {
    const { itinerary, deps } = setup();
    const res = applyEdits(itinerary, [{ op: "remove", itemId: "does-not-exist" }], deps);
    expect(res.errors.length).toBeGreaterThan(0);
    expect(res.changed).toBe(false);
    expect(res.itinerary).toBe(itinerary); // same reference — untouched
  });

  it("only re-lays-out affected days; untouched days keep the same object", () => {
    const { itinerary, deps } = setup();
    const visit = firstVisit(itinerary);
    const res = applyEdits(itinerary, [{ op: "setDuration", itemId: visit.itemId, minutes: 100 }], deps);
    expect(res.itinerary.days[1]).toBe(itinerary.days[1]); // day 2 untouched → same object
    expect(res.itinerary.days[0]).not.toBe(itinerary.days[0]); // day 1 re-laid-out
  });
});
