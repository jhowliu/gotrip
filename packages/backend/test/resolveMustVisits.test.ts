import { describe, expect, it } from "vitest";
import type { PlaceDetail, TripRequest } from "../src/domain/itinerary";
import type { ToolProvider } from "../src/application/ports/ToolProvider";
import { resolveMustVisits } from "../src/application/planning/resolveMustVisits";
import { createMockToolProvider } from "../src/infrastructure/tools/mock/mockToolProvider";

const ACC = { name: "Hotel", lat: 35.6938, lng: 139.7034 };

const PLACES: PlaceDetail[] = [
  { placeId: "near_park", name: "Near Park", category: "park", location: { name: "Near Park", lat: 35.695, lng: 139.705 }, ticketPrice: 0 },
  { placeId: "far_tower", name: "Far Tower", category: "landmark", location: { name: "Far Tower", lat: 35.65, lng: 139.79 }, ticketPrice: 0 },
  { placeId: "bay_museum", name: "Bay Museum", category: "museum", location: { name: "Bay Museum", lat: 35.652, lng: 139.792 }, ticketPrice: 0 },
];

function request(mustVisit: TripRequest["mustVisit"]): TripRequest {
  return { days: 2, destination: "Tokyo", accommodation: ACC, mustVisit };
}

describe("resolveMustVisits", () => {
  it("resolves a name-only must-visit via city-wide search, and adds companions for a far one", async () => {
    const provider = createMockToolProvider(PLACES);
    const r = await resolveMustVisits(request([{ name: "Far Tower" }]), provider);

    expect(r.errors).toEqual([]);
    expect(r.mustVisit[0]!.placeId).toBe("far_tower"); // filled in from search
    expect(r.details.get("far_tower")?.name).toBe("Far Tower");
    // Far Tower is ~9km from the hotel → companion search around it (~2.5km) finds Bay Museum.
    expect(r.companions.get("far_tower")?.map((p) => p.placeId)).toEqual(["bay_museum"]);
  });

  it("uses a place id directly with no search call (and no companions when near)", async () => {
    let searches = 0;
    const base = createMockToolProvider(PLACES);
    const counting: ToolProvider = { ...base, searchPlaces: (i) => ((searches += 1), base.searchPlaces(i)) };

    const r = await resolveMustVisits(request([{ name: "Near Park", placeId: "near_park" }]), counting);

    expect(searches).toBe(0); // resolved by id; near the hotel → no companion search
    expect(r.errors).toEqual([]);
    expect(r.mustVisit[0]!.placeId).toBe("near_park");
  });

  it("reports an actionable error for an unfindable must-visit instead of dropping it", async () => {
    const empty: ToolProvider = {
      searchPlaces: async () => [],
      getPlaceDetails: async () => {
        throw new Error("unused");
      },
      getTravelTime: async () => ({ durationMinutes: 0, distanceMeters: 0, mode: "transit" }),
      geocode: async () => null,
      getTransitRoute: async () => null,
    };

    const r = await resolveMustVisits(request([{ name: "Made-up Place" }]), empty);

    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("Made-up Place");
    expect(r.mustVisit[0]!.placeId).toBeUndefined(); // kept, unresolved — never silently dropped
    expect(r.details.size).toBe(0);
  });
});
