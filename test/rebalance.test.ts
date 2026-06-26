import { describe, expect, it } from "vitest";
import { dayBudgetMinutes, estimateDayLoadMinutes, rebalanceForBudget } from "../src/domain/rebalance";
import type { PlaceDetail } from "../src/domain/itinerary";

function bigMuseum(id: string, lat: number, lng: number): PlaceDetail {
  return { placeId: id, name: id, category: "museum", location: { name: id, lat, lng }, estimatedVisitMinutes: 120 };
}
const leg = (): number => 20;

describe("rebalanceForBudget", () => {
  it("moves places off an over-budget day until each day fits", () => {
    const details = new Map<string, PlaceDetail>([
      ["a", bigMuseum("a", 35.69, 139.7)],
      ["b", bigMuseum("b", 35.7, 139.71)],
      ["c", bigMuseum("c", 35.71, 139.72)],
      ["d", bigMuseum("d", 35.72, 139.73)],
    ]);
    // everything piled onto day 1, day 2 empty
    const assignments = [
      { dayIndex: 1, placeIds: ["a", "b", "c", "d"] },
      { dayIndex: 2, placeIds: [] },
    ];

    const budget = dayBudgetMinutes(undefined);
    expect(estimateDayLoadMinutes(["a", "b", "c", "d"], details, leg)).toBeGreaterThan(budget);

    const result = rebalanceForBudget({ assignments, details, legMinutes: leg });

    for (const day of result) {
      expect(estimateDayLoadMinutes(day.placeIds, details, leg)).toBeLessThanOrEqual(budget);
    }
    // all four places still present, none dropped
    const all = result.flatMap((d) => d.placeIds).sort();
    expect(all).toEqual(["a", "b", "c", "d"]);
    // day 2 received some
    expect(result[1]!.placeIds.length).toBeGreaterThan(0);
  });

  it("leaves an already-fitting plan unchanged", () => {
    const details = new Map<string, PlaceDetail>([["a", bigMuseum("a", 35.69, 139.7)]]);
    const assignments = [
      { dayIndex: 1, placeIds: ["a"] },
      { dayIndex: 2, placeIds: [] },
    ];
    const result = rebalanceForBudget({ assignments, details, legMinutes: leg });
    expect(result[0]!.placeIds).toEqual(["a"]);
  });
});
