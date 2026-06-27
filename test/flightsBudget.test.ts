import { describe, expect, it } from "vitest";
import type { TripRequest } from "../src/domain/itinerary";
import { runAgent } from "../src/application/agent/runAgent";
import { createColdStartSpec } from "../src/application/planning/coldStart";
import { createMockToolProvider } from "../src/infrastructure/tools/mock/mockToolProvider";
import { createScriptedColdStartModel } from "../src/infrastructure/llm/scriptedModelClient";
import {
  ADVERSARIAL_ACCOMMODATION,
  ADVERSARIAL_OVER_BUDGET,
  TOKYO_ACCOMMODATION,
  TOKYO_PLACES,
} from "../src/infrastructure/tools/mock/fixtures";

describe("flights + budget self-correction (mock + scripted)", () => {
  it("trims an over-budget plan under the ceiling and finalizes", async () => {
    const request: TripRequest = {
      days: 1,
      destination: "Tokyo",
      accommodation: ADVERSARIAL_ACCOMMODATION,
      budgetLevel: "economy", // ceiling 6000; fixture totals 12000
      mustVisit: [{ name: "Free Shrine", placeId: "b_shrine" }],
      pace: "relaxed",
    };
    const provider = createMockToolProvider(ADVERSARIAL_OVER_BUDGET);

    const result = await runAgent(
      createColdStartSpec(request, provider),
      createScriptedColdStartModel(request),
    );

    expect(result.status).toBe("ok");
    expect(result.validation.hardViolations).toHaveLength(0);
    expect(result.iterations).toBeGreaterThan(5); // re-planned (trim)

    const itinerary = result.state.itinerary!;
    expect(itinerary.totalCost ?? 0).toBeLessThanOrEqual(6000);
    const scheduled = new Set(itinerary.days.flatMap((d) => d.items.map((i) => i.placeId)));
    expect(scheduled.has("b_shrine")).toBe(true); // must-visit survived the trim
  });

  it("exits gracefully naming FLIGHT_BUFFER when the departure can't be met", async () => {
    const request: TripRequest = {
      days: 2,
      destination: "Tokyo",
      accommodation: TOKYO_ACCOMMODATION,
      departure: { airport: "NRT", datetime: "2026-07-03T11:00" }, // must leave by 08:00 — impossible
      mustVisit: [{ name: "teamLab Planets", placeId: "p_teamlab" }],
      pace: "relaxed",
    };
    const provider = createMockToolProvider(TOKYO_PLACES);

    const result = await runAgent(
      createColdStartSpec(request, provider),
      createScriptedColdStartModel(request),
    );

    expect(result.status).not.toBe("ok"); // couldn't satisfy → graceful exit
    expect(result.state.itinerary).toBeNull(); // never finalized
    expect(result.validation.hardViolations.map((v) => v.code)).toContain("FLIGHT_BUFFER");
    // a partial plan is still available for explanation
    expect(result.state.draft).not.toBeNull();
  });
});
