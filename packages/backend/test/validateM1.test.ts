import { describe, expect, it } from "vitest";
import { validate } from "../src/domain/validate";
import type { Itinerary, ItineraryItem, PlaceDetail, TripRequest } from "../src/domain/itinerary";

function request(overrides: Partial<TripRequest> = {}): TripRequest {
  return { days: 1, destination: "T", accommodation: { name: "H" }, ...overrides };
}
function visit(overrides: Partial<ItineraryItem>): ItineraryItem {
  return { itemId: "i1", kind: "visit", name: "X", startTime: "09:00", durationMinutes: 60, ...overrides };
}
function oneDay(req: TripRequest, items: ItineraryItem[]): Itinerary {
  return { request: req, days: [{ dayIndex: 1, items }] };
}

describe("validate (M1 checks)", () => {
  it("detects CLOSED_HOURS when a visit falls outside the open window", () => {
    const details = new Map<string, PlaceDetail>([
      ["x", { placeId: "x", name: "X", category: "museum", location: { name: "X", lat: 0, lng: 0 }, openWindow: ["09:00", "10:30"] }],
    ]);
    const itinerary = oneDay(request(), [visit({ placeId: "x", startTime: "11:00" })]);
    const result = validate(itinerary, details);
    expect(result.hardViolations.map((v) => v.code)).toContain("CLOSED_HOURS");
  });

  it("passes when the visit is inside the window", () => {
    const details = new Map<string, PlaceDetail>([
      ["x", { placeId: "x", name: "X", category: "museum", location: { name: "X", lat: 0, lng: 0 }, openWindow: ["09:00", "10:30"] }],
    ]);
    const itinerary = oneDay(request(), [visit({ placeId: "x", startTime: "09:00", durationMinutes: 60 })]);
    const result = validate(itinerary, details);
    expect(result.hardViolations).toHaveLength(0);
  });

  it("detects DAY_TOO_TIGHT when a day runs past the pace cap", () => {
    // relaxed → 19:00 cap; this day ends at 20:30
    const itinerary = oneDay(request({ pace: "relaxed" }), [visit({ startTime: "18:30", durationMinutes: 120 })]);
    const result = validate(itinerary);
    expect(result.hardViolations.map((v) => v.code)).toContain("DAY_TOO_TIGHT");
  });

  it("packed pace tolerates a later day end", () => {
    const itinerary = oneDay(request({ pace: "packed" }), [visit({ startTime: "18:30", durationMinutes: 120 })]); // ends 20:30 < 21:00
    const result = validate(itinerary);
    expect(result.hardViolations.map((v) => v.code)).not.toContain("DAY_TOO_TIGHT");
  });

  it("flags DAY_TOO_TIGHT (not a false pass) when a day runs past midnight", () => {
    // A visit starting 23:30 for 60m ends 24:30 — the HH:MM wrap must not read as 00:30.
    const itinerary = oneDay(request({ pace: "packed" }), [visit({ startTime: "23:30", durationMinutes: 60 })]);
    const result = validate(itinerary);
    const tight = result.hardViolations.find((v) => v.code === "DAY_TOO_TIGHT");
    expect(tight).toBeDefined();
    expect(tight!.message).toContain("24:30"); // reported un-wrapped, obviously over-long
  });

  it("exempts a day-trip day from the day-end cap", () => {
    const itinerary: Itinerary = {
      request: request({ pace: "relaxed" }),
      days: [{ dayIndex: 1, items: [visit({ startTime: "18:30", durationMinutes: 120 })], dayTrip: true }],
    };
    const result = validate(itinerary);
    expect(result.hardViolations.map((v) => v.code)).not.toContain("DAY_TOO_TIGHT");
  });
});
