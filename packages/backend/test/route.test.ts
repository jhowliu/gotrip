import { describe, expect, it } from "vitest";
import { orderByShortestPath } from "../src/domain/route";
import type { GeoLocation } from "../src/domain/itinerary";

const at = (id: string, lat: number, lng: number): { id: string; location: GeoLocation } => ({
  id,
  location: { name: id, lat, lng },
});

describe("orderByShortestPath", () => {
  it("does not strand a nearby stop the way greedy nearest-neighbour does", () => {
    // From the start, B is *slightly* closer than A — greedy grabs B, sweeps left
    // through C and D, then pays a long jump back out to A. The shortest path hits
    // A first, then sweeps left in one pass. (points laid out along a line, lat=0)
    const start: GeoLocation = { name: "S", lat: 0, lng: 0 };
    const stops = [
      at("A", 0, 1.0),
      at("B", 0, -0.9),
      at("C", 0, -2.0),
      at("D", 0, -3.0),
    ];
    const order = orderByShortestPath(stops, start).map((s) => s.id);
    expect(order).toEqual(["A", "B", "C", "D"]);
  });

  it("routes a free (no fixed start) day as a clean sweep, never backtracking", () => {
    const stops = [at("A", 0, 1.0), at("B", 0, -0.9), at("C", 0, -2.0), at("D", 0, -3.0)];
    const lngs = orderByShortestPath(stops, null).map((s) => s.location.lng);
    const monotonic =
      lngs.every((v, i) => i === 0 || v >= lngs[i - 1]!) ||
      lngs.every((v, i) => i === 0 || v <= lngs[i - 1]!);
    expect(monotonic).toBe(true);
  });

  it("returns short lists unchanged", () => {
    expect(orderByShortestPath([], null)).toEqual([]);
    const one = [at("A", 0, 0)];
    expect(orderByShortestPath(one, null).map((s) => s.id)).toEqual(["A"]);
  });
});
