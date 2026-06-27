import { describe, expect, it } from "vitest";
import { validate } from "../src/domain/validate";
import type { Itinerary, ItineraryItem, TripRequest } from "../src/domain/itinerary";

function request(overrides: Partial<TripRequest> = {}): TripRequest {
  return { days: 1, destination: "T", accommodation: { name: "H" }, ...overrides };
}
function visit(overrides: Partial<ItineraryItem>): ItineraryItem {
  return { itemId: "i", kind: "visit", name: "X", startTime: "09:00", durationMinutes: 60, ...overrides };
}
function oneDay(req: TripRequest, items: ItineraryItem[]): Itinerary {
  return { request: req, days: [{ dayIndex: 1, items }] };
}

describe("validate (flights + budget)", () => {
  it("detects BUDGET_EXCEEDED", () => {
    const req = request({ budgetLevel: "economy" }); // ceiling 6000
    const result = validate(oneDay(req, [visit({ estimatedCost: 8000 })]));
    expect(result.hardViolations.map((v) => v.code)).toContain("BUDGET_EXCEEDED");
  });

  it("detects ARRIVAL_TOO_EARLY", () => {
    const req = request({ arrival: { airport: "NRT", datetime: "2026-07-01T08:00" } }); // ready 09:30
    const result = validate(oneDay(req, [visit({ startTime: "09:00" })]));
    expect(result.hardViolations.map((v) => v.code)).toContain("ARRIVAL_TOO_EARLY");
  });

  it("detects FLIGHT_BUFFER", () => {
    const req = request({ departure: { airport: "NRT", datetime: "2026-07-01T13:00" } }); // leave by 10:00
    const result = validate(oneDay(req, [visit({ startTime: "11:00", durationMinutes: 60 })])); // ends 12:00
    expect(result.hardViolations.map((v) => v.code)).toContain("FLIGHT_BUFFER");
  });

  it("passes within budget and both flight windows", () => {
    const req = request({
      budgetLevel: "luxury",
      arrival: { airport: "NRT", datetime: "2026-07-01T06:00" }, // ready 07:30
      departure: { airport: "NRT", datetime: "2026-07-01T22:00" }, // leave by 19:00
    });
    const result = validate(oneDay(req, [visit({ startTime: "09:00", durationMinutes: 60, estimatedCost: 1000 })]));
    expect(result.hardViolations).toHaveLength(0);
  });
});
