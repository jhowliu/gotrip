import { describe, expect, it } from "vitest";
import { validate } from "../src/domain/validate";
import type { Itinerary, TripRequest } from "../src/domain/itinerary";

function tripRequest(overrides: Partial<TripRequest> = {}): TripRequest {
  return {
    days: 2,
    destination: "Tokyo",
    accommodation: { name: "Hotel", lat: 35.69, lng: 139.7 },
    ...overrides,
  };
}

function itinerary(request: TripRequest, dayCount: number, placeIds: string[]): Itinerary {
  const days = Array.from({ length: dayCount }, (_, i) => ({
    dayIndex: i + 1,
    items: i === 0
      ? placeIds.map((placeId, idx) => ({
          itemId: `d1-i${idx + 1}`,
          kind: "visit" as const,
          placeId,
          name: placeId,
          startTime: "09:00",
          durationMinutes: 60,
        }))
      : [],
  }));
  return { request, days };
}

describe("validate", () => {
  it("passes a valid itinerary", () => {
    const request = tripRequest({ mustVisit: [{ name: "X", placeId: "p_x" }] });
    const result = validate(itinerary(request, 2, ["p_x", "p_y"]));
    expect(result.hardViolations).toHaveLength(0);
  });

  it("flags a wrong day count", () => {
    const request = tripRequest({ days: 3 });
    const result = validate(itinerary(request, 2, ["p_x"]));
    expect(result.hardViolations.map((v) => v.code)).toContain("DAY_COUNT");
  });

  it("flags a missing must-visit", () => {
    const request = tripRequest({ mustVisit: [{ name: "TeamLab", placeId: "p_teamlab" }] });
    const result = validate(itinerary(request, 2, ["p_other"]));
    expect(result.hardViolations.map((v) => v.code)).toContain("MUST_VISIT_MISSING");
  });

  it("warns (soft) about an empty day", () => {
    const request = tripRequest();
    const result = validate(itinerary(request, 2, ["p_x"]));
    expect(result.hardViolations).toHaveLength(0);
    expect(result.softWarnings.map((v) => v.code)).toContain("EMPTY_DAY");
  });
});
