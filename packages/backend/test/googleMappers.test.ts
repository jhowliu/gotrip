import { describe, expect, it } from "vitest";
import {
  googleTypesToCategory,
  mapGeocode,
  mapPlaceDetail,
  mapPriceLevel,
  mapRoute,
  mapTextSearch,
  openingHoursToWindow,
  type GooglePlace,
} from "../src/infrastructure/tools/google/googleMappers";

const TEAMLAB: GooglePlace = {
  id: "ChIJteamlab",
  displayName: { text: "teamLab Planets TOKYO" },
  formattedAddress: "6 Chome-1-16 Toyosu, Koto City, Tokyo",
  location: { latitude: 35.6499, longitude: 139.7903 },
  rating: 4.5,
  priceLevel: "PRICE_LEVEL_EXPENSIVE",
  types: ["tourist_attraction", "museum", "point_of_interest"],
  regularOpeningHours: {
    periods: [{ open: { day: 0, hour: 9, minute: 0 }, close: { day: 0, hour: 22, minute: 0 } }],
  },
};

describe("googleMappers", () => {
  it("maps a Place Details response to a domain PlaceDetail", () => {
    const detail = mapPlaceDetail(TEAMLAB);
    expect(detail).toMatchObject({
      placeId: "ChIJteamlab",
      name: "teamLab Planets TOKYO",
      category: "museum", // museum wins over tourist_attraction
      location: { name: "teamLab Planets TOKYO", lat: 35.6499, lng: 139.7903 },
      openWindow: ["09:00", "22:00"],
      rating: 4.5,
      priceLevel: 3,
    });
  });

  it("treats a 24h place (open with no close) as always open", () => {
    expect(openingHoursToWindow({ periods: [{ open: { day: 0, hour: 0, minute: 0 } }] })).toBeUndefined();
    expect(openingHoursToWindow({ periods: [] })).toBeUndefined();
    expect(openingHoursToWindow(undefined)).toBeUndefined();
  });

  it("maps google types to a category by priority, falling back to landmark", () => {
    expect(googleTypesToCategory(["place_of_worship", "tourist_attraction"])).toBe("temple");
    expect(googleTypesToCategory(["park"])).toBe("park");
    expect(googleTypesToCategory(["restaurant", "food"])).toBe("restaurant");
    expect(googleTypesToCategory(["bus_station"])).toBe("landmark");
    expect(googleTypesToCategory([])).toBe("landmark");
  });

  it("maps price level enums", () => {
    expect(mapPriceLevel("PRICE_LEVEL_FREE")).toBe(0);
    expect(mapPriceLevel("PRICE_LEVEL_MODERATE")).toBe(2);
    expect(mapPriceLevel("PRICE_LEVEL_VERY_EXPENSIVE")).toBe(4);
    expect(mapPriceLevel(undefined)).toBeUndefined();
    expect(mapPriceLevel("PRICE_LEVEL_UNSPECIFIED")).toBeUndefined();
  });

  it("maps a text-search response to lightweight Place summaries", () => {
    const places = mapTextSearch({ places: [TEAMLAB] });
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({
      placeId: "ChIJteamlab",
      name: "teamLab Planets TOKYO",
      category: "museum",
      rating: 4.5,
      priceLevel: 3,
      shortAddress: "6 Chome-1-16 Toyosu, Koto City, Tokyo",
    });
    expect(mapTextSearch({})).toEqual([]);
  });

  it("maps a geocode response (and null on empty)", () => {
    const resp = { status: "OK", results: [{ geometry: { location: { lat: 35.69, lng: 139.70 } }, formatted_address: "Shinjuku" }] };
    expect(mapGeocode(resp, "Shinjuku Hotel")).toEqual({ name: "Shinjuku Hotel", lat: 35.69, lng: 139.7 });
    expect(mapGeocode({ status: "ZERO_RESULTS", results: [] }, "Nowhere")).toBeNull();
  });

  it("maps a routes response (duration seconds → minutes)", () => {
    expect(mapRoute({ routes: [{ distanceMeters: 8200, duration: "1530s" }] }, "transit")).toEqual({
      durationMinutes: 26,
      distanceMeters: 8200,
      mode: "transit",
    });
    expect(mapRoute({}, "walking")).toEqual({ durationMinutes: 0, distanceMeters: 0, mode: "walking" });
  });
});
