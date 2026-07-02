import { describe, expect, it } from "vitest";
import type { PlaceDetail, TripRequest } from "../src/domain/itinerary";
import { createColdStartSpec, type PlanningState } from "../src/application/planning/coldStart";
import { createMockToolProvider } from "../src/infrastructure/tools/mock/mockToolProvider";

function detail(id: string, lat: number, lng: number, category = "landmark", openWindow?: [string, string]): PlaceDetail {
  return { placeId: id, name: id, category, location: { name: id, lat, lng }, ...(openWindow ? { openWindow } : {}) };
}

// Two areas: a "downtown" cluster near (0,0) and a "coast" cluster near (0,0.5).
const A = detail("A", 0, 0.01);
const B = detail("B", 0, 0.02);
const C = detail("C", 0, 0.5);
const D = detail("D", 0, 0.51);
const R = detail("R", 0, 0.011, "restaurant", ["11:00", "14:30"]); // an eatery, near downtown
const MV = detail("MV", 0, 0.005); // must-visit, close to the downtown cluster

const request: TripRequest = {
  days: 2,
  destination: "T",
  accommodation: { name: "H", lat: 0, lng: 0 },
  mustVisit: [{ name: "MV", placeId: "MV" }],
  pace: "relaxed",
};

function setup() {
  const provider = createMockToolProvider([A, B, C, D, R, MV]);
  const spec = createColdStartSpec(request, provider, { details: new Map([["MV", MV]]) });
  const state = spec.initialState as PlanningState;
  for (const [ref, place] of [["r1", A], ["r2", B], ["r3", C], ["r4", D], ["r5", R]] as const) {
    state.refs.set(ref, place.placeId);
    state.details.set(place.placeId, place);
  }
  const planDays = spec.tools.find((t) => t.name === "planDays")!;
  return { planDays, state };
}

describe("planDays (agent-chosen day grouping)", () => {
  it("schedules the agent's grouping and returns a per-day travel summary", async () => {
    const { planDays, state } = setup();
    const out = await planDays.execute(
      { days: [{ day: 1, refs: ["r1", "r2"] }, { day: 2, refs: ["r3", "r4"] }] },
      state,
    );
    const content = out.content as {
      totalTravelMinutes: number;
      days: Array<{ day: number; visits: number; travelMinutes: number; endsAt: string }>;
      hardViolations: Array<{ code: string }>;
    };
    expect(content.days).toHaveLength(2);
    expect(content.days.every((d) => typeof d.travelMinutes === "number" && /^\d{2}:\d{2}$/.test(d.endsAt))).toBe(true);
    // Tiny fixture ends early → only DAY_TOO_LIGHT is expected, nothing unexpected (CLOSED_HOURS etc.).
    expect(content.hardViolations.every((v) => v.code === "DAY_TOO_LIGHT")).toBe(true);
    expect(state.draft).not.toBeNull();
    expect(state.draft!.days).toHaveLength(2);
  });

  it("pins a must-visit the agent left out — into the nearest day", async () => {
    const { planDays, state } = setup();
    // Agent never mentions MV; it must still be scheduled, on the downtown day (1).
    await planDays.execute({ days: [{ day: 1, refs: ["r1", "r2"] }, { day: 2, refs: ["r3", "r4"] }] }, state);
    const scheduled = state.assignments!.flatMap((a) => a.placeIds);
    expect(scheduled).toContain("MV");
    expect(state.assignments![0]!.placeIds).toContain("MV"); // nearest cluster = downtown
  });

  it("routes a restaurant into meals, never scheduling it as a sightseeing visit", async () => {
    const { planDays, state } = setup();
    await planDays.execute({ days: [{ day: 1, refs: ["r1", "r2", "r5"] }, { day: 2, refs: ["r3", "r4"] }] }, state);
    const day1 = state.draft!.days[0]!.items;
    expect(day1.some((i) => i.kind === "visit" && i.placeId === "R")).toBe(false); // not a visit
    expect(state.assignments![0]!.placeIds).not.toContain("R"); // excluded from the visit assignment
  });

  it("fetches details for a ref the agent searched but never detailed", async () => {
    const { planDays, state } = setup();
    state.details.delete("R"); // agent searched the restaurant but skipped getPlaceDetails
    await planDays.execute({ days: [{ day: 1, refs: ["r1", "r2", "r5"] }, { day: 2, refs: ["r3", "r4"] }] }, state);
    expect(state.details.has("R")).toBe(true); // planDays resolved it on demand
  });

  it("flags a day that ends far too early as DAY_TOO_LIGHT", async () => {
    const { planDays, state } = setup();
    const out = await planDays.execute({ days: [{ day: 1, refs: ["r1", "r2"] }, { day: 2, refs: ["r3", "r4"] }] }, state);
    const content = out.content as { hardViolations: Array<{ code: string }> };
    expect(out.isError).toBe(true);
    expect(content.hardViolations.some((v) => v.code === "DAY_TOO_LIGHT")).toBe(true);
  });

  it("rejects a plan with no usable refs", async () => {
    const { planDays, state } = setup();
    const out = await planDays.execute({ days: [{ day: 1, refs: ["nope"] }] }, state);
    expect(out.isError).toBe(true);
  });

  it("carves a far must-visit onto its own day-trip day, exempt from day-end caps", async () => {
    // FAR is ~56 km out (lng 0.5) → >60 min drive → a day-trip anchor, not a city stop.
    const FAR = detail("FAR", 0, 0.5);
    const req: TripRequest = {
      days: 2,
      destination: "T",
      accommodation: { name: "H", lat: 0, lng: 0 },
      mustVisit: [{ name: "FAR", placeId: "FAR" }],
      pace: "relaxed",
    };
    const provider = createMockToolProvider([A, B, FAR]);
    const spec = createColdStartSpec(req, provider, { details: new Map([["FAR", FAR]]) });
    const state = spec.initialState as PlanningState;
    for (const [ref, place] of [["r1", A], ["r2", B]] as const) {
      state.refs.set(ref, place.placeId);
      state.details.set(place.placeId, place);
    }
    const planDays = spec.tools.find((t) => t.name === "planDays")!;

    // Agent groups only the two city stops; the far must-visit is invisible to it.
    const out = await planDays.execute({ days: [{ day: 1, refs: ["r1"] }, { day: 2, refs: ["r2"] }] }, state);
    const content = out.content as {
      days: Array<{ day: number; dayTrip?: boolean; places: string[] }>;
      hardViolations: Array<{ code: string; dayIndex?: number }>;
    };

    const tripDay = content.days.find((d) => d.dayTrip);
    expect(tripDay).toBeDefined();
    expect(tripDay!.places.some((p) => p.includes("FAR") && p.includes("must-visit"))).toBe(true);
    // The day-trip's long commute is expected — it must not trip a day-end guard.
    const tripViolations = content.hardViolations.filter((v) => v.dayIndex === tripDay!.day);
    expect(tripViolations.map((v) => v.code)).not.toContain("DAY_TOO_TIGHT");
    expect(tripViolations.map((v) => v.code)).not.toContain("DAY_TOO_LIGHT");
  });
});
