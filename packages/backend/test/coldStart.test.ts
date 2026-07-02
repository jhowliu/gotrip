import { describe, expect, it } from "vitest";
import type { TripRequest } from "../src/domain/itinerary";
import { runAgent } from "../src/application/agent/runAgent";
import { createColdStartSpec } from "../src/application/planning/coldStart";
import { formatItineraryText } from "../src/application/formatting/format";
import { createMockToolProvider } from "../src/infrastructure/tools/mock/mockToolProvider";
import { createScriptedColdStartModel } from "../src/infrastructure/llm/scriptedModelClient";
import { TOKYO_ACCOMMODATION, TOKYO_PLACES } from "../src/infrastructure/tools/mock/fixtures";

function tokyoRequest(overrides: Partial<TripRequest> = {}): TripRequest {
  return {
    days: 2,
    destination: "Tokyo",
    accommodation: TOKYO_ACCOMMODATION,
    mustVisit: [{ name: "teamLab Planets", placeId: "p_teamlab" }],
    pace: "relaxed",
    ...overrides,
  };
}

describe("cold-start tracer bullet (mock + scripted model)", () => {
  it("produces a valid itinerary and finalizes cleanly", async () => {
    const request = tokyoRequest();
    const provider = createMockToolProvider(TOKYO_PLACES);
    const spec = createColdStartSpec(request, provider);
    const model = createScriptedColdStartModel(request);

    const result = await runAgent(spec, model);

    expect(result.status).toBe("ok");
    expect(result.validation.hardViolations).toHaveLength(0);

    const itinerary = result.state.itinerary;
    expect(itinerary).not.toBeNull();
    expect(itinerary!.days).toHaveLength(request.days);

    // every must-visit is scheduled
    const scheduled = new Set(
      itinerary!.days.flatMap((d) => d.items.map((i) => i.placeId)),
    );
    expect(scheduled.has("p_teamlab")).toBe(true);

    // emitted text rendering is non-empty
    expect(formatItineraryText(itinerary!).length).toBeGreaterThan(0);
  });

  it("runs entirely on fixtures — no network/provider beyond the injected mock", async () => {
    const request = tokyoRequest({ mustVisit: [] });
    const provider = createMockToolProvider(TOKYO_PLACES);
    const result = await runAgent(
      createColdStartSpec(request, provider),
      createScriptedColdStartModel(request),
    );
    expect(result.status).toBe("ok");
  });

  it("exits gracefully when the iteration budget is exhausted", async () => {
    const request = tokyoRequest();
    const provider = createMockToolProvider(TOKYO_PLACES);
    const spec = createColdStartSpec(request, provider);
    // too few turns to reach finalize (needs search→details→planDays→finalize)
    spec.constraints.maxIterations = 2;

    const result = await runAgent(spec, createScriptedColdStartModel(request));

    expect(result.status).toBe("budget_exhausted");
    expect(result.validation.hardViolations.length).toBeGreaterThan(0);
    expect(result.state.itinerary).toBeNull();
  });
});
