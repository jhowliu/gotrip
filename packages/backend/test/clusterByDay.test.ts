import { describe, expect, it } from "vitest";
import { carveDayTrips, clusterByCost, clusterByDay, haversineMeters } from "../src/domain/clusterByDay";

describe("clusterByCost", () => {
  it("keeps a far-by-road place (e.g. an island) off the near cluster", () => {
    // p1,p2 are close; p3 is far from both by real road time (short as the crow flies).
    const cost = (a: string, b: string): number => ([a, b].sort().join("-") === "p1-p2" ? 5 : 100);
    const centerCost = (id: string): number => (id === "p3" ? 90 : 10);

    const result = clusterByCost({ ids: ["p1", "p2", "p3"], days: 2, cost, centerCost });
    const dayOf = (id: string): number => result.find((d) => d.placeIds.includes(id))!.dayIndex;

    expect(dayOf("p1")).toBe(dayOf("p2")); // the near pair shares a day
    expect(dayOf("p3")).not.toBe(dayOf("p1")); // the island is on its own day
    expect(result.find((d) => d.placeIds.includes("p3"))!.placeIds).toEqual(["p3"]);
  });

  it("honours pinned day assignments", () => {
    const result = clusterByCost({
      ids: ["a", "b"],
      days: 2,
      cost: () => 10,
      pinned: [{ id: "a", dayIndex: 2 }],
    });
    expect(result.find((d) => d.dayIndex === 2)!.placeIds).toContain("a");
  });
});

describe("carveDayTrips", () => {
  // A city cluster (c1,c2,c3) near the accommodation, plus a far anchor and a
  // companion right next to it (both hours away, close to each other).
  const near = new Set(["c1", "c2", "c3", "far", "companion"]);
  const cost = (a: string, b: string): number => {
    const cityPair = near.has(a) && near.has(b) && a !== "far" && a !== "companion" && b !== "far" && b !== "companion";
    if (cityPair) return 8;
    if ([a, b].sort().join("-") === "companion-far") return 5; // companion sits by the anchor
    return 130; // city ↔ anchor area
  };
  const centerCost = (id: string): number => (id === "far" || id === "companion" ? 130 : 10);

  it("gives a far anchor its own day-trip day and clusters the city into the rest", () => {
    const result = carveDayTrips({
      attractionIds: ["c1", "c2", "c3", "far", "companion"],
      anchorIds: ["far"],
      days: 2,
      cost,
      centerCost,
    });
    expect(result).not.toBeNull();
    const { assignments, dayTripDays } = result!;
    expect(assignments).toHaveLength(2);
    expect(dayTripDays).toEqual([2]); // city day first, then the anchor day

    const tripDay = assignments.find((a) => dayTripDays.includes(a.dayIndex))!;
    expect(tripDay.placeIds).toContain("far");
    expect(tripDay.placeIds).toContain("companion"); // nearer the anchor than home → same day
    const cityDay = assignments.find((a) => !dayTripDays.includes(a.dayIndex))!;
    expect(cityDay.placeIds.sort()).toEqual(["c1", "c2", "c3"]);
  });

  it("returns null when there's no far anchor (nothing to carve)", () => {
    expect(
      carveDayTrips({ attractionIds: ["c1", "c2"], anchorIds: [], days: 2, cost, centerCost }),
    ).toBeNull();
  });

  it("returns null when carving would leave no city day", () => {
    // 1 day, 1 anchor → dedicating it a day leaves zero city days.
    expect(
      carveDayTrips({ attractionIds: ["far", "c1"], anchorIds: ["far"], days: 1, cost, centerCost }),
    ).toBeNull();
  });
});

describe("clusterByDay", () => {
  it("assigns every place exactly once across the requested number of days", () => {
    const places = [
      { placeId: "a", lat: 35.69, lng: 139.7 },
      { placeId: "b", lat: 35.68, lng: 139.71 },
      { placeId: "c", lat: 35.71, lng: 139.8 },
      { placeId: "d", lat: 35.72, lng: 139.79 },
      { placeId: "e", lat: 35.66, lng: 139.7 },
    ];
    const result = clusterByDay({ places, days: 2 });

    expect(result).toHaveLength(2);
    const assigned = result.flatMap((d) => d.placeIds).sort();
    expect(assigned).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("keeps geographically close points on the same day", () => {
    // two tight western points, two tight eastern points
    const places = [
      { placeId: "w1", lat: 35.69, lng: 139.7 },
      { placeId: "w2", lat: 35.685, lng: 139.702 },
      { placeId: "e1", lat: 35.71, lng: 139.8 },
      { placeId: "e2", lat: 35.715, lng: 139.798 },
    ];
    const result = clusterByDay({ places, days: 2 });

    const dayOf = (id: string): number =>
      result.find((d) => d.placeIds.includes(id))!.dayIndex;

    expect(dayOf("w1")).toBe(dayOf("w2"));
    expect(dayOf("e1")).toBe(dayOf("e2"));
    expect(dayOf("w1")).not.toBe(dayOf("e1"));
  });

  it("respects pinned day assignments", () => {
    const places = [
      { placeId: "a", lat: 35.69, lng: 139.7 },
      { placeId: "b", lat: 35.7, lng: 139.71 },
    ];
    const result = clusterByDay({ places, days: 2, pinned: [{ placeId: "a", dayIndex: 2 }] });

    expect(result.find((d) => d.dayIndex === 2)!.placeIds).toContain("a");
  });

  it("computes a plausible great-circle distance", () => {
    // Tokyo Station → Shinjuku Station ≈ 6 km
    const meters = haversineMeters({ lat: 35.681, lng: 139.767 }, { lat: 35.69, lng: 139.7 });
    expect(meters).toBeGreaterThan(5000);
    expect(meters).toBeLessThan(7500);
  });
});
