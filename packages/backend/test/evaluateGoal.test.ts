import { describe, expect, it } from "vitest";
import { evaluateGoal } from "../src/domain/evaluateGoal";
import type { Itinerary, ItineraryItem, PlaceDetail, TripRequest } from "../src/domain/itinerary";

const req: TripRequest = { days: 1, destination: "T", accommodation: { name: "H" }, pace: "relaxed" };

function visit(id: string, start: string, dur = 60, extra: Partial<ItineraryItem> = {}): ItineraryItem {
  return { itemId: id, kind: "visit", placeId: id, name: id, startTime: start, durationMinutes: dur, ...extra };
}
function meal(name: string, start: string, window: [string, string]): ItineraryItem {
  return { itemId: `m-${name}`, kind: "meal", name, startTime: start, durationMinutes: 60, mealWindow: window };
}
function pd(id: string, category = "park", rating?: number): PlaceDetail {
  return {
    placeId: id, name: id, category, location: { name: id, lat: 0, lng: 0 },
    ...(rating !== undefined ? { rating } : {}),
  };
}

describe("evaluateGoal", () => {
  it("FULLNESS: an under-used day with unused candidates is a high-gap goal (not satisfied)", () => {
    const itinerary: Itinerary = { request: req, days: [{ dayIndex: 1, items: [visit("A", "09:00")] }] };
    const details = new Map([["A", pd("A")], ["B", pd("B")], ["C", pd("C")]]); // B, C unused
    const goal = evaluateGoal(itinerary, details);
    expect(goal.findings.find((f) => f.dimension === "FULLNESS")?.gap).toBe("high");
    expect(goal.satisfied).toBe(false);
  });

  it("a comfortably full day with nothing left to add is satisfied", () => {
    const items = [visit("A", "09:00", 120), visit("B", "11:00", 150), visit("C", "14:00", 180)]; // ends 17:00
    const itinerary: Itinerary = { request: req, days: [{ dayIndex: 1, items }] };
    const details = new Map([["A", pd("A", "park")], ["B", pd("B", "museum")], ["C", pd("C", "landmark")]]);
    expect(evaluateGoal(itinerary, details).satisfied).toBe(true); // only med/low findings, no high
  });

  it("DAY_TRIP: a lone-anchor day-trip is a high-gap goal naming the anchor", () => {
    const itinerary: Itinerary = {
      request: { ...req, days: 2 },
      days: [
        { dayIndex: 1, items: [visit("A", "09:00", 120), visit("B", "11:30", 120), visit("C", "14:00", 120)] },
        { dayIndex: 2, items: [visit("FAR", "10:00", 120, { pinned: true })], dayTrip: true },
      ],
    };
    const details = new Map([
      ["A", pd("A")], ["B", pd("B", "museum")], ["C", pd("C", "landmark")], ["FAR", pd("FAR", "landmark")],
    ]);
    const f = evaluateGoal(itinerary, details).findings.find((x) => x.dimension === "DAY_TRIP");
    expect(f?.gap).toBe("high");
    expect(f?.message).toContain("FAR");
  });

  it("DAY_TRIP: demotes a lone anchor to low (non-blocking) once its area searched empty", () => {
    const itinerary: Itinerary = {
      request: { ...req, days: 2 },
      days: [
        { dayIndex: 1, items: [visit("A", "09:00", 120), visit("B", "11:30", 120), visit("C", "14:00", 120)] },
        { dayIndex: 2, items: [visit("FAR", "10:00", 120, { pinned: true })], dayTrip: true },
      ],
    };
    const details = new Map([
      ["A", pd("A")], ["B", pd("B", "museum")], ["C", pd("C", "landmark")], ["FAR", pd("FAR", "landmark")],
    ]);
    // "Pinnacles Desert" ⇄ "FAR" wouldn't match, so use the anchor's own name; article-tolerant.
    const goal = evaluateGoal(itinerary, details, new Set(["far"]));
    const f = goal.findings.find((x) => x.dimension === "DAY_TRIP");
    expect(f?.gap).toBe("low"); // demoted — nothing reachable to add
    expect(goal.satisfied).toBe(true); // no high-gap findings remain → finalize unblocked
  });

  it("MEALS: flags a meal placed outside its (start-based) window", () => {
    const itinerary: Itinerary = {
      request: req,
      days: [{ dayIndex: 1, items: [visit("A", "09:00", 120), meal("Late Lunch", "14:30", ["11:00", "14:00"]), visit("B", "16:00", 120)] }],
    };
    const details = new Map([["A", pd("A")], ["B", pd("B", "museum")]]);
    const meals = evaluateGoal(itinerary, details).findings.filter((x) => x.dimension === "MEALS");
    expect(meals.some((f) => f.gap === "low")).toBe(true);
  });

  it("DIVERSITY: flags a monotonous trip when another theme is available unused", () => {
    const items = [visit("A", "09:00"), visit("B", "10:30"), visit("C", "12:00"), visit("D", "13:30")]; // 4 parks
    const itinerary: Itinerary = { request: req, days: [{ dayIndex: 1, items }] };
    const details = new Map([
      ["A", pd("A", "park")], ["B", pd("B", "park")], ["C", pd("C", "park")], ["D", pd("D", "park")],
      ["T", pd("T", "temple")], // unused, different theme
    ]);
    expect(evaluateGoal(itinerary, details).findings.some((f) => f.dimension === "DIVERSITY")).toBe(true);
  });
});
