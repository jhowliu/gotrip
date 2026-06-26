import { describe, expect, it } from "vitest";
import { clusterByDay, haversineMeters } from "../src/domain/clusterByDay";

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
