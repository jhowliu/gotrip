import { describe, expect, it } from "vitest";
import type { Itinerary, PlaceDetail, TripRequest } from "../src/domain/itinerary";
import { runAgent } from "../src/application/agent/runAgent";
import { createWarmEditSpec } from "../src/application/planning/warmEdit";
import { scheduleItinerary } from "../src/domain/schedule";
import { createScriptedWarmModel } from "../src/infrastructure/llm/scriptedWarmModel";
import { createMockToolProvider } from "../src/infrastructure/tools/mock/mockToolProvider";
import { TOKYO_ACCOMMODATION, TOKYO_PLACES } from "../src/infrastructure/tools/mock/fixtures";

function setup(): { itinerary: Itinerary; details: Map<string, PlaceDetail>; provider: ReturnType<typeof createMockToolProvider> } {
  const details = new Map(TOKYO_PLACES.map((p) => [p.placeId, p]));
  const provider = createMockToolProvider(TOKYO_PLACES);
  const request: TripRequest = { days: 2, destination: "Tokyo", accommodation: TOKYO_ACCOMMODATION };
  const itinerary = scheduleItinerary({
    request,
    assignments: [
      { dayIndex: 1, placeIds: ["p_sensoji", "p_meiji"] },
      { dayIndex: 2, placeIds: ["p_teamlab", "p_ueno"] },
    ],
    details,
    legMinutes: () => 15,
  });
  return { itinerary, details, provider };
}

function visitsByTime(day: Itinerary["days"][number]) {
  return day.items.filter((i) => i.kind === "visit").sort((a, b) => a.startTime.localeCompare(b.startTime));
}

describe("warm-edit agent", () => {
  it("'move the temple to the morning' applies the edit and the plan stays valid", async () => {
    const { itinerary, details, provider } = setup();
    const temple = itinerary.days[0]!.items.find((i) => i.placeId === "p_sensoji")!;
    // Precondition: the temple is not already the first (morning) visit.
    expect(visitsByTime(itinerary.days[0]!)[0]!.placeId).not.toBe("p_sensoji");

    const spec = createWarmEditSpec(itinerary, "Move Senso-ji to the morning", provider, details);
    const model = createScriptedWarmModel([{ op: "move", itemId: temple.itemId, toDay: 1, atTime: "09:00" }]);
    const result = await runAgent(spec, model);

    expect(result.status).toBe("ok");
    expect(result.state.finalized).toBe(true);
    expect(result.validation.hardViolations).toHaveLength(0);
    expect(visitsByTime(result.state.itinerary.days[0]!)[0]!.placeId).toBe("p_sensoji");
  });

  it("rejects an edit that breaks a hard constraint, reporting instead of forcing an impossible plan", async () => {
    const { itinerary, details, provider } = setup();
    const visit = itinerary.days[0]!.items.find((i) => i.kind === "visit")!;

    const spec = createWarmEditSpec(itinerary, "Make this an all-day, 13-hour visit", provider, details);
    const model = createScriptedWarmModel([{ op: "setDuration", itemId: visit.itemId, minutes: 800 }]);
    const result = await runAgent(spec, model);

    expect(result.status).toBe("stopped"); // reported a conflict, did not finalize
    expect(result.state.finalized).toBe(false);
    expect(result.state.itinerary).toBe(itinerary); // edit not committed — itinerary untouched
    expect(result.validation.hardViolations).toHaveLength(0); // the kept plan is still valid
  });

  it("applies an edit with only soft warnings and reports them without re-optimizing", async () => {
    const { itinerary, details, provider } = setup();
    const day2Visits = itinerary.days[1]!.items.filter((i) => i.kind === "visit");

    const spec = createWarmEditSpec(itinerary, "Clear day 2", provider, details);
    const model = createScriptedWarmModel(day2Visits.map((v) => ({ op: "remove", itemId: v.itemId })));
    const result = await runAgent(spec, model);

    expect(result.status).toBe("ok");
    expect(result.state.finalized).toBe(true);
    expect(result.validation.hardViolations).toHaveLength(0);
    expect(result.validation.softWarnings.length).toBeGreaterThan(0); // e.g. EMPTY_DAY
    expect(result.state.itinerary.days[1]!.items.some((i) => i.kind === "visit")).toBe(false);
  });
});
