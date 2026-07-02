import { describe, expect, it } from "vitest";
import { scheduleItinerary, summariseDays } from "../src/domain/schedule";
import { withinWindow } from "../src/domain/timing";
import type { GeoLocation, Itinerary, ItineraryItem, PlaceDetail, TripRequest } from "../src/domain/itinerary";

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

  it("schedules a late-opening venue (night market) last, not first", () => {
    const details = new Map([
      ["day", detail("day", 0, 0.01, "park", 60)], // all-day
      ["market", detail("market", 0, 0.02, "market", 60, ["17:00", "23:00"])], // opens 17:00
    ]);
    const itinerary = scheduleItinerary({
      request: { days: 1, destination: "T", accommodation: { name: "H", lat: 0, lng: 0 } },
      assignments: [{ dayIndex: 1, placeIds: ["day", "market"] }],
      details,
      legMinutes: () => 10,
    });
    const visits = itinerary.days[0]!.items.filter((i) => i.kind === "visit");
    expect(visits.map((i) => i.placeId)).toEqual(["day", "market"]); // daytime first, market last
    expect(visits[0]!.startTime).toBe("09:00"); // day isn't dragged to the evening
    const market = visits[1]!;
    expect(withinWindow(market.startTime, market.durationMinutes, ["17:00", "23:00"])).toBe(true);
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

  it("marks day-trip days from dayTripDays", () => {
    const details = new Map([
      ["c", detail("c", 35.69, 139.7, "park", 60)],
      ["far", detail("far", 36.5, 140.5, "landmark", 60)],
    ]);
    const itinerary = scheduleItinerary({
      request: { days: 2, destination: "T", accommodation: { name: "H", lat: 35.69, lng: 139.7 } },
      assignments: [{ dayIndex: 1, placeIds: ["c"] }, { dayIndex: 2, placeIds: ["far"] }],
      details,
      legMinutes: leg,
      dayTripDays: new Set([2]),
    });
    expect(itinerary.days[0]!.dayTrip).toBeUndefined();
    expect(itinerary.days[1]!.dayTrip).toBe(true);
  });

  it("times the out-and-back commute on a day-trip day (but not on a plain day)", () => {
    const details = new Map([["far", detail("far", 0, 0.5, "landmark", 60)]]);
    const req: TripRequest = { days: 1, destination: "T", accommodation: { name: "H", lat: 0, lng: 0 } };
    const args = { request: req, assignments: [{ dayIndex: 1, placeIds: ["far"] }], details, legMinutes: () => 120 };

    const trip = scheduleItinerary({ ...args, dayTripDays: new Set([1]) });
    const transits = trip.days[0]!.items.filter((i) => i.kind === "transit");
    expect(transits).toHaveLength(2); // drive out + drive back
    expect(transits.at(-1)!.name).toBe("Transit to H"); // return leg
    expect(summariseDays(trip).days[0]!.travelMinutes).toBeGreaterThan(0);

    // A plain single-stop day has no commute legs (unchanged behaviour).
    const plain = scheduleItinerary(args);
    expect(plain.days[0]!.items.filter((i) => i.kind === "transit")).toHaveLength(0);
  });
});

describe("summariseDays", () => {
  const item = (o: Partial<ItineraryItem>): ItineraryItem => ({
    itemId: "i", kind: "visit", name: "X", startTime: "09:00", durationMinutes: 60, ...o,
  });
  const req: TripRequest = { days: 1, destination: "T", accommodation: { name: "H" } };

  it("names each day's visits and flags the pinned must-visit", () => {
    const itinerary: Itinerary = {
      request: req,
      days: [{ dayIndex: 1, items: [item({ name: "Museum" }), item({ name: "The Desert", pinned: true })] }],
    };
    expect(summariseDays(itinerary).days[0]!.places).toEqual(["Museum", "The Desert (must-visit)"]);
  });

  it("reports an unwrapped end (and minutes) for a day that runs past midnight", () => {
    const itinerary: Itinerary = {
      request: req,
      days: [{ dayIndex: 1, items: [item({ startTime: "23:30", durationMinutes: 60 })] }],
    };
    const day = summariseDays(itinerary).days[0]!;
    expect(day.endsAt).toBe("24:30");
    expect(day.endsAtMinutes).toBe(1470);
  });

  it("surfaces the day-trip flag", () => {
    const itinerary: Itinerary = {
      request: req,
      days: [{ dayIndex: 1, items: [item({})], dayTrip: true }],
    };
    expect(summariseDays(itinerary).days[0]!.dayTrip).toBe(true);
  });
});
