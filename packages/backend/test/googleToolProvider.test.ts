import { describe, expect, it } from "vitest";
import { createGoogleToolProvider } from "../src/infrastructure/tools/google/googleToolProvider";

interface Call {
  url: string;
  init?: RequestInit;
}

function fakeFetch(
  handler: (url: string) => { status?: number; body: unknown },
  calls: Call[],
): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const { status = 200, body } = handler(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const header = (init: RequestInit | undefined, name: string): string | undefined =>
  (init?.headers as Record<string, string> | undefined)?.[name];

describe("GoogleToolProvider (offline)", () => {
  it("searchPlaces posts a text query with key + radius bias and maps results", async () => {
    const calls: Call[] = [];
    const provider = createGoogleToolProvider({
      apiKey: "KEY",
      fetchImpl: fakeFetch(
        () => ({
          body: { places: [{ id: "p1", displayName: { text: "Ueno Park" }, types: ["park"], rating: 4.4, location: { latitude: 35.71, longitude: 139.77 } }] },
        }),
        calls,
      ),
    });

    const res = await provider.searchPlaces({ query: "parks in tokyo", center: { name: "Tokyo", lat: 35.68, lng: 139.76 }, radius: 4000, maxResults: 5 });

    expect(res[0]).toMatchObject({ placeId: "p1", name: "Ueno Park", category: "park", rating: 4.4 });
    const call = calls[0]!;
    expect(call.url).toContain("/places:searchText");
    expect(header(call.init, "X-Goog-Api-Key")).toBe("KEY");
    const body = JSON.parse(String(call.init!.body)) as { textQuery: string; locationBias: { circle: { radius: number } } };
    expect(body.textQuery).toBe("parks in tokyo");
    expect(body.locationBias.circle.radius).toBe(4000);
  });

  it("getPlaceDetails GETs by id with a field mask and maps the detail", async () => {
    const calls: Call[] = [];
    const provider = createGoogleToolProvider({
      apiKey: "KEY",
      fetchImpl: fakeFetch(
        () => ({
          body: {
            id: "ChIJx",
            displayName: { text: "Senso-ji" },
            types: ["place_of_worship", "tourist_attraction"],
            location: { latitude: 35.7148, longitude: 139.7967 },
            regularOpeningHours: { periods: [{ open: { day: 0, hour: 6, minute: 0 }, close: { day: 0, hour: 17, minute: 0 } }] },
          },
        }),
        calls,
      ),
    });

    const detail = await provider.getPlaceDetails({ placeId: "ChIJx" });
    expect(detail).toMatchObject({ placeId: "ChIJx", name: "Senso-ji", category: "temple", openWindow: ["06:00", "17:00"] });
    expect(calls[0]!.url).toContain("/places/ChIJx");
    expect(header(calls[0]!.init, "X-Goog-FieldMask")).toContain("regularOpeningHours");
  });

  it("getTravelTime posts a route request and maps seconds → minutes", async () => {
    const calls: Call[] = [];
    const provider = createGoogleToolProvider({
      apiKey: "KEY",
      fetchImpl: fakeFetch(() => ({ body: { routes: [{ distanceMeters: 8200, duration: "1530s" }] } }), calls),
    });

    const tt = await provider.getTravelTime({ origin: { name: "A", lat: 35.69, lng: 139.7 }, destination: { name: "B", lat: 35.65, lng: 139.79 }, mode: "transit" });
    expect(tt).toEqual({ durationMinutes: 26, distanceMeters: 8200, mode: "transit" });
    const body = JSON.parse(String(calls[0]!.init!.body)) as { travelMode: string };
    expect(body.travelMode).toBe("TRANSIT");
  });

  it("geocode resolves an address (and null on no results)", async () => {
    const calls: Call[] = [];
    const ok = createGoogleToolProvider({
      apiKey: "KEY",
      fetchImpl: fakeFetch(() => ({ body: { status: "OK", results: [{ geometry: { location: { lat: 35.69, lng: 139.7 } } }] } }), calls),
    });
    expect(await ok.geocode({ query: "Shinjuku Hotel" })).toEqual({ name: "Shinjuku Hotel", lat: 35.69, lng: 139.7 });
    expect(calls[0]!.url).toContain("address=Shinjuku%20Hotel");

    const none = createGoogleToolProvider({ apiKey: "KEY", fetchImpl: fakeFetch(() => ({ body: { status: "ZERO_RESULTS", results: [] } }), []) });
    expect(await none.geocode({ query: "nowhere" })).toBeNull();
  });

  it("falls back to a geometric estimate when Google returns no route (empty {})", async () => {
    const provider = createGoogleToolProvider({ apiKey: "KEY", fetchImpl: fakeFetch(() => ({ body: {} }), []) });
    const tt = await provider.getTravelTime({
      origin: { name: "Shinjuku", lat: 35.69, lng: 139.7 },
      destination: { name: "Roppongi", lat: 35.665, lng: 139.726 },
      mode: "transit",
    });
    expect(tt.durationMinutes).toBeGreaterThan(0);
    expect(tt.distanceMeters).toBeGreaterThan(0);
    expect(tt.mode).toBe("transit");
  });

  it("throws a readable error on a non-OK response", async () => {
    const provider = createGoogleToolProvider({ apiKey: "BAD", fetchImpl: fakeFetch(() => ({ status: 403, body: { error: { message: "key invalid" } } }), []) });
    await expect(provider.getPlaceDetails({ placeId: "x" })).rejects.toThrow(/google 403/);
  });
});
