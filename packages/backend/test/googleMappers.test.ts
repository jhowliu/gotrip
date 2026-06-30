import { describe, expect, it } from "vitest";
import {
  googleTypesToCategory,
  mapGeocode,
  mapPlaceDetail,
  mapPriceLevel,
  mapRoute,
  mapTextSearch,
  mapTransitRoute,
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

  it("clamps a midnight / past-midnight close to end of day (else it reads as closed)", () => {
    // open 06:00, close 00:00 (midnight) — was wrapping to [06:00,00:00] and flagging everything closed.
    expect(openingHoursToWindow({ periods: [{ open: { day: 1, hour: 6 }, close: { day: 2, hour: 0, minute: 0 } }] })).toEqual(["06:00", "23:59"]);
    // open 18:00, close 02:00 next day → clamp.
    expect(openingHoursToWindow({ periods: [{ open: { day: 1, hour: 18 }, close: { day: 2, hour: 2 } }] })).toEqual(["18:00", "23:59"]);
    // normal same-day window is untouched.
    expect(openingHoursToWindow({ periods: [{ open: { day: 1, hour: 9 }, close: { day: 1, hour: 17, minute: 30 } }] })).toEqual(["09:00", "17:30"]);
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

  it("maps a transit route into legs + a readable summary", () => {
    const resp = {
      routes: [
        {
          duration: "1500s",
          distanceMeters: 8200,
          legs: [
            {
              steps: [
                { travelMode: "WALK", staticDuration: "240s" },
                {
                  travelMode: "TRANSIT",
                  transitDetails: {
                    stopDetails: { departureStop: { name: "Ximen" }, arrivalStop: { name: "Taipei City Hall" } },
                    transitLine: { name: "Bannan Line", nameShort: "BL", vehicle: { type: "SUBWAY" } },
                    stopCount: 4,
                  },
                },
                { travelMode: "WALK", staticDuration: "120s" },
              ],
            },
          ],
        },
      ],
    };
    const route = mapTransitRoute(resp);
    expect(route).not.toBeNull();
    expect(route!.durationMinutes).toBe(25);
    expect(route!.summary).toBe("BL Ximen→Taipei City Hall (4 stops)");
    expect(route!.legs.filter((l) => l.mode === "transit")).toHaveLength(1);
    expect(route!.legs[0]).toMatchObject({ mode: "walk", durationMinutes: 4 });
  });

  it("returns null when there is no transit route", () => {
    expect(mapTransitRoute({})).toBeNull();
    expect(mapTransitRoute({ routes: [{ legs: [] }] })).toBeNull();
  });
});
