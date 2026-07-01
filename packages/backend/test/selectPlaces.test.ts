import { describe, expect, it } from "vitest";
import { qualityScore, selectPlaces } from "../src/domain/selectPlaces";
import type { PlaceDetail } from "../src/domain/itinerary";

interface PlaceOpts {
  primaryType?: string;
  category?: string;
  lat?: number;
  lng?: number;
  rating?: number;
  userRatingCount?: number;
}

function place(id: string, opts: PlaceOpts = {}): PlaceDetail {
  const category = opts.category ?? opts.primaryType ?? "landmark";
  const lat = opts.lat ?? 0;
  const lng = opts.lng ?? 0;
  return {
    placeId: id,
    name: id,
    category,
    location: { name: id, lat, lng },
    ...(opts.primaryType ? { primaryType: opts.primaryType } : {}),
    ...(opts.rating !== undefined ? { rating: opts.rating } : {}),
    ...(opts.userRatingCount !== undefined ? { userRatingCount: opts.userRatingCount } : {}),
  };
}

describe("selectPlaces", () => {
  it("dedups similar attractions and keeps a diverse, high-quality subset", () => {
    const places = [
      place("parkA", { primaryType: "park", lat: 0, lng: 0, rating: 4.8, userRatingCount: 5000 }),
      // ~150m from parkA, same type → near-duplicate, should be dropped despite a good score.
      place("parkC", { primaryType: "park", lat: 0.001, lng: 0.001, rating: 4.7, userRatingCount: 3000 }),
      place("parkD", { primaryType: "park", lat: 0.1, lng: 0.1, rating: 4.6, userRatingCount: 1000 }),
      // Popularity trap: dazzling rating, almost nobody rated it → must sink to the bottom.
      place("parkB", { primaryType: "park", lat: 0.05, lng: 0.05, rating: 4.9, userRatingCount: 20 }),
      place("museumX", { primaryType: "museum", lat: 0.2, lng: 0.2, rating: 4.5, userRatingCount: 2000 }),
      place("museumY", { primaryType: "museum", lat: 0.3, lng: 0.3, rating: 4.4, userRatingCount: 800 }),
      place("mustL", { primaryType: "tourist_attraction", lat: 0.5, lng: 0.5, rating: 4.0, userRatingCount: 50 }),
    ];

    const result = selectPlaces({ places, targetCount: 4, pinnedIds: new Set(["mustL"]) });

    expect(result.selected).toHaveLength(4);
    expect(result.shortBy).toBe(0);
    expect(result.selected[0]).toBe("mustL"); // pinned always kept, listed first
    expect(result.selected).toEqual(expect.arrayContaining(["mustL", "parkA", "museumX", "parkD"]));
    expect(result.selected).not.toContain("parkC"); // near-duplicate of parkA
    expect(result.selected).not.toContain("parkB"); // high rating, too few ratings
    expect(result.dropped).toEqual(expect.arrayContaining(["parkB", "parkC", "museumY"]));
  });

  it("relaxes the per-type cap when it can't otherwise hit the target", () => {
    // Five parks, none near-duplicates, no other type available. Cap is 2, target is 4,
    // so it must relax the cap to fill the plan rather than leave it short.
    const places = [
      place("p1", { primaryType: "park", lat: 0.0, lng: 0, rating: 4.9, userRatingCount: 5000 }),
      place("p2", { primaryType: "park", lat: 0.1, lng: 0, rating: 4.8, userRatingCount: 4000 }),
      place("p3", { primaryType: "park", lat: 0.2, lng: 0, rating: 4.7, userRatingCount: 3000 }),
      place("p4", { primaryType: "park", lat: 0.3, lng: 0, rating: 4.6, userRatingCount: 2000 }),
      place("p5", { primaryType: "park", lat: 0.4, lng: 0, rating: 4.5, userRatingCount: 1000 }),
    ];

    const result = selectPlaces({ places, targetCount: 4 });

    expect(result.selected).toHaveLength(4); // relaxed past the cap of 2
    expect(result.shortBy).toBe(0);
    expect(result.selected).toEqual(["p1", "p2", "p3", "p4"]); // still best-first
  });

  it("reports a shortfall when the pool is too thin", () => {
    const places = [
      place("mustL", { primaryType: "tourist_attraction", lat: 0, lng: 0, rating: 4.0 }),
      place("parkA", { primaryType: "park", lat: 0.2, lng: 0.2, rating: 4.5, userRatingCount: 900 }),
      place("museumX", { primaryType: "museum", lat: 0.4, lng: 0.4, rating: 4.6, userRatingCount: 1200 }),
    ];

    const result = selectPlaces({ places, targetCount: 6, pinnedIds: new Set(["mustL"]) });

    expect(result.selected).toHaveLength(3);
    expect(result.shortBy).toBe(3);
  });

  it("weights rating by how many people rated it", () => {
    const loved = place("loved", { rating: 4.5, userRatingCount: 5000 });
    const niche = place("niche", { rating: 4.9, userRatingCount: 8 });
    expect(qualityScore(loved)).toBeGreaterThan(qualityScore(niche));
  });
});
