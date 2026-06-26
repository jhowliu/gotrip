import { describe, expect, it } from "vitest";
import type { TripRequest } from "../src/domain/itinerary";
import { runAgent } from "../src/application/agent/runAgent";
import { createColdStartSpec } from "../src/application/planning/coldStart";
import { withinWindow } from "../src/domain/timing";
import { createMockToolProvider } from "../src/infrastructure/tools/mock/mockToolProvider";
import { createScriptedColdStartModel } from "../src/infrastructure/llm/scriptedModelClient";
import { ADVERSARIAL_ACCOMMODATION, ADVERSARIAL_NARROW_WINDOW } from "../src/infrastructure/tools/mock/fixtures";

describe("self-correction (adversarial fixtures, mock + scripted)", () => {
  it("detects CLOSED_HOURS and re-plans to a valid itinerary", async () => {
    const request: TripRequest = {
      days: 1,
      destination: "Tokyo",
      accommodation: ADVERSARIAL_ACCOMMODATION,
      mustVisit: [{ name: "Sunrise Museum", placeId: "a_sunrise" }],
      pace: "relaxed",
    };
    const provider = createMockToolProvider(ADVERSARIAL_NARROW_WINDOW);

    const result = await runAgent(
      createColdStartSpec(request, provider),
      createScriptedColdStartModel(request),
    );

    // The first plan trips CLOSED_HOURS; the agent re-plans and converges.
    expect(result.status).toBe("ok");
    expect(result.validation.hardViolations).toHaveLength(0);
    expect(result.iterations).toBeGreaterThan(5); // needed at least one re-plan pass

    const itinerary = result.state.itinerary!;
    const sunrise = itinerary.days.flatMap((d) => d.items).find((i) => i.placeId === "a_sunrise")!;
    expect(sunrise).toBeDefined();
    expect(withinWindow(sunrise.startTime, sunrise.durationMinutes, ["09:00", "10:30"])).toBe(true);
  });
});
