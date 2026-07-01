import { describe, expect, it } from "vitest";
import type { Place, PlaceDetail, TripRequest } from "../src/domain/itinerary";
import type { ToolProvider } from "../src/application/ports/ToolProvider";
import { createColdStartSpec } from "../src/application/planning/coldStart";

const place = (id: string): Place => ({ placeId: id, name: id, category: "landmark", rating: 4.5 });

/** Provider that serves a scripted sequence of search result pages and records the maxResults it was asked for. */
function fakeProvider(pages: Place[][]): { provider: ToolProvider; calls: Array<number | undefined> } {
  const calls: Array<number | undefined> = [];
  let i = 0;
  const provider: ToolProvider = {
    async searchPlaces(input) {
      calls.push(input.maxResults);
      return pages[Math.min(i++, pages.length - 1)] ?? [];
    },
    async getPlaceDetails(input): Promise<PlaceDetail> {
      return { placeId: input.placeId, name: input.placeId, category: "landmark", location: { name: input.placeId, lat: 0, lng: 0 } };
    },
    async getTravelTime() {
      return { durationMinutes: 10, distanceMeters: 100, mode: "transit" };
    },
    async geocode() {
      return null;
    },
    async getTransitRoute() {
      return null;
    },
  };
  return { provider, calls };
}

const request: TripRequest = { days: 2, destination: "Test", accommodation: { name: "H", lat: 0, lng: 0 }, pace: "relaxed" };

function searchTool(provider: ToolProvider) {
  const spec = createColdStartSpec(request, provider);
  const tool = spec.tools.find((t) => t.name === "searchPlaces")!;
  return { tool, state: spec.initialState };
}

describe("searchPlaces dedup + maxResults floor", () => {
  it("raises maxResults to a floor even when the agent asks for fewer", async () => {
    const { provider, calls } = fakeProvider([[place("a"), place("b")]]);
    const { tool, state } = searchTool(provider);
    await tool.execute({ query: "attractions", maxResults: 3 }, state);
    // days 2 × relaxed target 5 = 10 keep-target → floor = max(12, 20) = 20
    expect(calls[0]).toBe(20);
  });

  it("omits places already surfaced so a repeat search returns only new ones", async () => {
    const { provider } = fakeProvider([
      [place("a"), place("b"), place("c")],
      [place("a"), place("b"), place("c")], // same query → same results, all seen
      [place("c"), place("d")], // different query → one already seen, one new
    ]);
    const { tool, state } = searchTool(provider);

    const r1 = (await tool.execute({ query: "attractions" }, state)).content as Array<{ name: string }>;
    expect(r1.map((p) => p.name)).toEqual(["a", "b", "c"]);

    const r2 = (await tool.execute({ query: "attractions" }, state)).content as unknown[];
    expect(r2).toEqual([]); // nothing new

    const r3 = (await tool.execute({ query: "parks" }, state)).content as Array<{ name: string }>;
    expect(r3.map((p) => p.name)).toEqual(["d"]); // only the genuinely new place
  });
});
