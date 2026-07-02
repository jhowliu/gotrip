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

function detailsTool(provider: ToolProvider) {
  const spec = createColdStartSpec(request, provider);
  const tool = spec.tools.find((t) => t.name === "getPlaceDetails")!;
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

  it("runs several `queries` in one call, merging + de-duping across the batch", async () => {
    // Two queries → two provider searches; "b" appears in both and must not double.
    const { provider, calls } = fakeProvider([
      [place("a"), place("b")],
      [place("b"), place("c")],
    ]);
    const { tool, state } = searchTool(provider);
    const out = (await tool.execute({ queries: ["landmarks", "parks"] }, state)).content as Array<{ name: string; ref: string }>;
    expect(calls).toHaveLength(2); // one provider call per query
    expect(out.map((p) => p.name)).toEqual(["a", "b", "c"]); // merged, de-duped
    expect(new Set(out.map((p) => p.ref)).size).toBe(3); // distinct refs assigned across the batch
  });

  it("re-centers on `near` via geocode and applies a radius", async () => {
    const seen: Array<{ lat?: number; lng?: number; radius?: number }> = [];
    const provider: ToolProvider = {
      async searchPlaces(input) {
        seen.push({ lat: input.center.lat, lng: input.center.lng, radius: input.radius });
        return [];
      },
      async getPlaceDetails(input): Promise<PlaceDetail> {
        return { placeId: input.placeId, name: input.placeId, category: "landmark", location: { name: input.placeId, lat: 0, lng: 0 } };
      },
      async getTravelTime() {
        return { durationMinutes: 10, distanceMeters: 100, mode: "transit" };
      },
      async geocode() {
        return { name: "Pinnacles", lat: -30.6, lng: 115.16 };
      },
      async getTransitRoute() {
        return null;
      },
    };
    const { tool, state } = searchTool(provider);

    await tool.execute({ query: "attractions" }, state); // no `near` → accommodation, no radius
    expect(seen.at(-1)).toEqual({ lat: 0, lng: 0, radius: undefined });

    await tool.execute({ query: "attractions", near: "The Pinnacles Desert" }, state);
    expect(seen.at(-1)).toEqual({ lat: -30.6, lng: 115.16, radius: 40000 });
  });
});

describe("getPlaceDetails batch vs single", () => {
  it("details many refs in one call, returning an array and caching each", async () => {
    const { provider } = fakeProvider([]);
    const { tool, state } = detailsTool(provider);
    state.refs.set("r1", "A");
    state.refs.set("r2", "B");
    const out = (await tool.execute({ refs: ["r1", "r2"] }, state)).content as Array<{ ref: string; name: string }>;
    expect(out.map((r) => r.ref)).toEqual(["r1", "r2"]);
    expect(out.map((r) => r.name)).toEqual(["A", "B"]);
    expect(state.details.has("A") && state.details.has("B")).toBe(true); // both cached
  });

  it("keeps the single-object shape for a lone `ref` (back-compat)", async () => {
    const { provider } = fakeProvider([]);
    const { tool, state } = detailsTool(provider);
    state.refs.set("r1", "A");
    const out = (await tool.execute({ ref: "r1" }, state)).content as { ref: string; name: string };
    expect(Array.isArray(out)).toBe(false);
    expect(out.ref).toBe("r1");
  });

  it("reports a failed ref inline without sinking the rest of the batch", async () => {
    const { provider } = fakeProvider([]);
    provider.getPlaceDetails = async (input) => {
      if (input.placeId === "B") throw new Error("not found");
      return { placeId: input.placeId, name: input.placeId, category: "landmark", location: { name: input.placeId, lat: 0, lng: 0 } };
    };
    const { tool, state } = detailsTool(provider);
    state.refs.set("r1", "A");
    state.refs.set("r2", "B");
    const out = (await tool.execute({ refs: ["r1", "r2"] }, state)).content as Array<{ ref: string; name?: string; error?: string }>;
    expect(out[0]!.name).toBe("A");
    expect(out[1]!.error).toMatch(/not found/); // the bad ref is flagged, not thrown
  });
});
