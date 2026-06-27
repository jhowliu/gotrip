import { describe, expect, it } from "vitest";
import { budgetCeiling, itineraryCost, resolveBudget, trimToBudget } from "../src/domain/budget";
import type { Itinerary, PlaceDetail, TripRequest } from "../src/domain/itinerary";

function req(overrides: Partial<TripRequest>): TripRequest {
  return { days: 2, destination: "T", accommodation: { name: "H" }, ...overrides };
}

function priced(id: string, price: number): PlaceDetail {
  return { placeId: id, name: id, category: "museum", location: { name: id, lat: 0, lng: 0 }, ticketPrice: price };
}

describe("budget", () => {
  it("computes the ceiling by level and days, or null when unset", () => {
    expect(budgetCeiling("economy", 2)).toBe(12_000);
    expect(budgetCeiling("luxury", 1)).toBe(25_000);
    expect(budgetCeiling(undefined, 3)).toBeNull();
  });

  it("resolveBudget: per-day band (× days), level fallback, band wins over level", () => {
    expect(resolveBudget(req({ budget: { min: 3000, max: 5000 } }))).toEqual({ minTotal: 6000, maxTotal: 10_000 });
    expect(resolveBudget(req({ budgetLevel: "economy" }))).toEqual({ maxTotal: 12_000 });
    expect(resolveBudget(req({}))).toBeNull();
    // explicit band takes precedence over the level
    expect(resolveBudget(req({ days: 1, budgetLevel: "luxury", budget: { max: 5000 } }))).toEqual({ maxTotal: 5000 });
  });

  it("sums itinerary cost from item estimatedCost", () => {
    const request = { days: 1, destination: "T", accommodation: { name: "H" } } satisfies TripRequest;
    const itinerary: Itinerary = {
      request,
      days: [
        {
          dayIndex: 1,
          items: [
            { itemId: "i1", kind: "visit", name: "A", startTime: "09:00", durationMinutes: 60, estimatedCost: 3800 },
            { itemId: "i2", kind: "visit", name: "B", startTime: "11:00", durationMinutes: 60, estimatedCost: 500 },
          ],
        },
      ],
    };
    expect(itineraryCost(itinerary)).toBe(4300);
  });

  it("trims the most-expensive non-pinned places until under the ceiling", () => {
    const details = new Map([
      ["a", priced("a", 4000)],
      ["b", priced("b", 4000)],
      ["c", priced("c", 4000)],
      ["keep", priced("keep", 0)],
    ]);
    const result = trimToBudget({
      assignments: [{ dayIndex: 1, placeIds: ["a", "b", "c", "keep"] }],
      details,
      ceiling: 6000,
      pinnedIds: new Set(["keep"]),
    });

    const remaining = result.flatMap((d) => d.placeIds);
    expect(remaining).toContain("keep");
    const total = remaining.reduce((s, id) => s + (details.get(id)?.ticketPrice ?? 0), 0);
    expect(total).toBeLessThanOrEqual(6000);
  });

  it("never trims a pinned place, even if still over budget", () => {
    const details = new Map([["m", priced("m", 10_000)]]);
    const result = trimToBudget({
      assignments: [{ dayIndex: 1, placeIds: ["m"] }],
      details,
      ceiling: 6000,
      pinnedIds: new Set(["m"]),
    });
    expect(result[0]!.placeIds).toEqual(["m"]);
  });
});
