/**
 * In-memory caching decorator for a ToolProvider — memoizes the idempotent,
 * paid calls (place details, geocode, search) by caching the in-flight Promise,
 * so a planning run never pays Google twice for the same lookup. Travel time is
 * left uncached. Lives at the port boundary; the inner layers are unaware.
 */

import type { GeoLocation, Place, PlaceDetail, TransitRoute } from "../../domain/itinerary";
import type { GetTravelTimeInput, SearchPlacesInput, ToolProvider } from "../../application/ports/ToolProvider";

export function withCache(provider: ToolProvider): ToolProvider {
  const details = new Map<string, Promise<PlaceDetail>>();
  const geo = new Map<string, Promise<GeoLocation | null>>();
  const search = new Map<string, Promise<Place[]>>();
  const transit = new Map<string, Promise<TransitRoute | null>>();
  const matrix = new Map<string, Promise<number[][]>>();

  const memo = <T>(cache: Map<string, Promise<T>>, key: string, run: () => Promise<T>): Promise<T> => {
    let hit = cache.get(key);
    if (!hit) {
      hit = run();
      cache.set(key, hit);
    }
    return hit;
  };

  return {
    getPlaceDetails: (input) => memo(details, input.placeId, () => provider.getPlaceDetails(input)),
    geocode: (input) => memo(geo, input.query, () => provider.geocode(input)),
    searchPlaces: (input: SearchPlacesInput) =>
      memo(search, JSON.stringify([input.query, input.center, input.radius, input.type, input.maxResults]), () =>
        provider.searchPlaces(input),
      ),
    getTravelTime: (input) => provider.getTravelTime(input),
    getTransitRoute: (input: GetTravelTimeInput) =>
      memo(transit, JSON.stringify([input.origin, input.destination]), () => provider.getTransitRoute(input)),
    ...(provider.getTravelMatrix
      ? {
          getTravelMatrix: (input) =>
            memo(matrix, JSON.stringify([input.points, input.mode]), () => provider.getTravelMatrix!(input)),
        }
      : {}),
  };
}
