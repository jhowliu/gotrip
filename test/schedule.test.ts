import { describe, expect, it } from "vitest";
import { scheduleItinerary } from "../src/domain/schedule";
import { withinWindow } from "../src/domain/timing";
import type { PlaceDetail, TripRequest } from "../src/domain/itinerary";

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

  it("respectWindows lands a narrow-window place inside its window", () => {
    const details = new Map([
      ["near", detail("near", 35.692, 139.702, "cafe", 60)],
      ["far", detail("far", 35.72, 139.78, "museum", 60, ["09:00", "10:30"])],
    ]);
    const placeIds = ["near", "far"];

    const naive = scheduleItinerary({ request, assignments: [{ dayIndex: 1, placeIds }], details, legMinutes: leg });
    const naiveFar = naive.days[0]!.items.find((i) => i.placeId === "far")!;
    expect(withinWindow(naiveFar.startTime, naiveFar.durationMinutes, ["09:00", "10:30"])).toBe(false);

    const fixed = scheduleItinerary({
      request,
      assignments: [{ dayIndex: 1, placeIds }],
      details,
      legMinutes: leg,
      options: { respectWindows: true },
    });
    const fixedFar = fixed.days[0]!.items.find((i) => i.placeId === "far")!;
    expect(withinWindow(fixedFar.startTime, fixedFar.durationMinutes, ["09:00", "10:30"])).toBe(true);
  });
});
