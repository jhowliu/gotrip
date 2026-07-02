import { describe, expect, it } from "vitest";
import type { TripRequest } from "../src/domain/itinerary";
import { runAgent } from "../src/application/agent/runAgent";
import { createColdStartSpec } from "../src/application/planning/coldStart";
import { withinWindow } from "../src/domain/timing";
import { createMockToolProvider } from "../src/infrastructure/tools/mock/mockToolProvider";
import { createScriptedColdStartModel } from "../src/infrastructure/llm/scriptedModelClient";
import { ADVERSARIAL_ACCOMMODATION, ADVERSARIAL_NARROW_WINDOW } from "../src/infrastructure/tools/mock/fixtures";

describe("window-aware planning (adversarial fixtures, mock + scripted)", () => {
  it("schedules a narrow-window must-visit inside its open window and finalizes", async () => {
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

    // planDays orders the time-restricted place first, so it lands in its window
    // on the first pass (no CLOSED_HOURS to recover from — recovery is covered by
    // the over-budget trim test).
    expect(result.status).toBe("ok");
    expect(result.validation.hardViolations).toHaveLength(0);

    const itinerary = result.state.itinerary!;
    const sunrise = itinerary.days.flatMap((d) => d.items).find((i) => i.placeId === "a_sunrise")!;
    expect(sunrise).toBeDefined();
    expect(withinWindow(sunrise.startTime, sunrise.durationMinutes, ["09:00", "10:30"])).toBe(true);
  });
});
