import { describe, expect, it } from "vitest";
import { scheduleItinerary } from "../src/domain/schedule";
import { withinWindow } from "../src/domain/timing";
import type { GeoLocation, PlaceDetail, TripRequest } from "../src/domain/itinerary";

function detail(
  id: string,
  lat: number,
  lng: number,
  category: string,
  minutes?: number,
  openWindow?: [string, string],
): PlaceDetail {
  return {
    placeId: id,
    name: id,
    category,
    location: { name: id, lat, lng },
    ...(minutes ? { estimatedVisitMinutes: minutes } : {}),
    ...(openWindow ? { openWindow } : {}),
  };
}

const request: TripRequest = {
  days: 1,
  destination: "Test",
  accommodation: { name: "H", lat: 35.69, lng: 139.7 },
};
const leg = (): number => 15; // fixed travel estimate → transit 15 + 10 buffer

describe("scheduleItinerary", () => {
  it("inserts transit items with a buffer between visits", () => {
    const details = new Map([
      ["x", detail("x", 35.69, 139.7, "park", 60)],
      ["y", detail("y", 35.7, 139.72, "park", 60)],
    ]);
    const itinerary = scheduleItinerary({
      request,
      assignments: [{ dayIndex: 1, placeIds: ["x", "y"] }],
      details,
      legMinutes: leg,
    });
    const items = itinerary.days[0]!.items;
    const transit = items.find((i) => i.kind === "transit");
    expect(transit).toBeDefined();
    expect(transit!.durationMinutes).toBe(25);
    expect(items.filter((i) => i.kind === "visit")).toHaveLength(2);
  });

  it("falls back to the category table when details lack visit minutes", () => {
    const details = new Map([["m", detail("m", 35.69, 139.7, "museum")]]); // no estimate → 90
    const itinerary = scheduleItinerary({
      request,
      assignments: [{ dayIndex: 1, placeIds: ["m"] }],
      details,
      legMinutes: leg,
    });
    const visit = itinerary.days[0]!.items.find((i) => i.kind === "visit");
    expect(visit!.durationMinutes).toBe(90);
  });

  it("places a meal inside its window", () => {
    const details = new Map([
      ["a", detail("a", 35.69, 139.7, "museum", 150)],
      ["b", detail("b", 35.7, 139.72, "park", 30)],
    ]);
    const itinerary = scheduleItinerary({
      request,
      assignments: [{ dayIndex: 1, placeIds: ["a", "b"] }],
      details,
      legMinutes: leg,
    });
    const lunch = itinerary.days[0]!.items.find((i) => i.kind === "meal" && i.name === "Lunch");
    expect(lunch).toBeDefined();
    expect(withinWindow(lunch!.startTime, lunch!.durationMinutes, lunch!.mealWindow!)).toBe(true);
  });

  it("honours opening windows by default; respectWindows:false produces the naive (violating) plan", () => {
    const details = new Map([
      ["near", detail("near", 35.692, 139.702, "cafe", 60)],
      ["far", detail("far", 35.72, 139.78, "museum", 60, ["09:00", "10:30"])],
    ]);
    const placeIds = ["near", "far"];

    // default (window-aware) → "far" lands inside its window
    const def = scheduleItinerary({ request, assignments: [{ dayIndex: 1, placeIds }], details, legMinutes: leg });
    const defFar = def.days[0]!.items.find((i) => i.placeId === "far")!;
    expect(withinWindow(defFar.startTime, defFar.durationMinutes, ["09:00", "10:30"])).toBe(true);

    // opt out → naive geometry order schedules "far" late → outside its window
    const naive = scheduleItinerary({
      request,
      assignments: [{ dayIndex: 1, placeIds }],
      details,
      legMinutes: leg,
      options: { respectWindows: false },
    });
    const naiveFar = naive.days[0]!.items.find((i) => i.placeId === "far")!;
    expect(withinWindow(naiveFar.startTime, naiveFar.durationMinutes, ["09:00", "10:30"])).toBe(false);
  });

  it("orders visits by the injected travel cost, not straight-line distance", () => {
    const details = new Map([
      ["near", detail("near", 0, 0.01, "park", 30)],
      ["far", detail("far", 0, 0.5, "park", 30)],
    ]);
    // Real times: from the hotel, "far" is quick (5) while "near" is slow (50) —
    // the opposite of straight-line distance. Ordering must follow the real cost.
    const realLeg = (a: GeoLocation, b: GeoLocation): number => {
      if (a.lng === 0 && b.lng === 0.5) return 5; // hotel → far
      if (a.lng === 0 && b.lng === 0.01) return 50; // hotel → near
      return 30;
    };
    const itinerary = scheduleItinerary({
      request: { days: 1, destination: "T", accommodation: { name: "H", lat: 0, lng: 0 } },
      assignments: [{ dayIndex: 1, placeIds: ["near", "far"] }],
      details,
      legMinutes: realLeg,
    });
    const order = itinerary.days[0]!.items.filter((i) => i.kind === "visit").map((i) => i.placeId);
    expect(order).toEqual(["far", "near"]);
  });

  it("fills a meal slot with an open restaurant, and falls back to a generic block otherwise", () => {
    const details = new Map([["m", detail("m", 35.69, 139.7, "museum", 180)]]); // 09:00–12:00 → lunch due
    const oneDay = { days: 1, destination: "T", accommodation: { name: "H", lat: 35.69, lng: 139.7 } };
    const lunchSpot = detail("bistro", 35.69, 139.701, "restaurant", 60, ["11:00", "14:30"]);
    const dinnerOnly = detail("izakaya", 35.69, 139.701, "restaurant", 60, ["18:00", "22:00"]);

    const withRestaurant = scheduleItinerary({
      request: oneDay,
      assignments: [{ dayIndex: 1, placeIds: ["m"] }],
      details,
      legMinutes: () => 10,
      mealsByDay: new Map([[1, [lunchSpot]]]),
    });
    const lunch = withRestaurant.days[0]!.items.find((i) => i.kind === "meal")!;
    expect(lunch.name).toBe("bistro");
    expect(lunch.placeId).toBe("bistro");

    // A dinner-only place isn't open at lunch → generic block, no placeId.
    const generic = scheduleItinerary({
      request: oneDay,
      assignments: [{ dayIndex: 1, placeIds: ["m"] }],
      details,
      legMinutes: () => 10,
      mealsByDay: new Map([[1, [dinnerOnly]]]),
    });
    const genericLunch = generic.days[0]!.items.find((i) => i.kind === "meal")!;
    expect(genericLunch.name).toBe("Lunch");
    expect(genericLunch.placeId).toBeUndefined();
  });
});
