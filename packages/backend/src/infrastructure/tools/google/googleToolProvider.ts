/**
 * GoogleToolProvider (M4) — implements the ToolProvider port against the real
 * Google APIs (Places API New v1 · Routes · classic Geocoding). All response
 * shaping is delegated to the pure mappers; this file only builds requests and
 * handles transport. `fetchImpl` is injectable so the wiring is unit-testable
 * without network. Keys live in env (GOOGLE_MAPS_API_KEY), never in code.
 */

import type { GeoLocation, Place, PlaceDetail, TransitRoute, TravelMode, TravelTime } from "../../../domain/itinerary";
import type { GetTravelTimeInput, SearchPlacesInput, ToolProvider } from "../../../application/ports/ToolProvider";
import { haversineMeters } from "../../../domain/clusterByDay";
import { estimateTravelMinutes } from "../../../domain/travel";
import {
  mapGeocode,
  mapPlaceDetail,
  mapRoute,
  mapRouteMatrix,
  mapTextSearch,
  mapTransitRoute,
  type GoogleGeocodeResponse,
  type GoogleMatrixElement,
  type GooglePlace,
  type GoogleRoutesResponse,
  type GoogleTextSearchResponse,
  type GoogleTransitResponse,
} from "./googleMappers";

const PLACES_BASE = "https://places.googleapis.com/v1";
const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const MATRIX_URL = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";
const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

const DETAIL_MASK =
  "id,displayName,formattedAddress,location,rating,userRatingCount,priceLevel,types,primaryType,regularOpeningHours";
const SEARCH_MASK =
  "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.priceLevel,places.types,places.primaryType";

const TRAVEL_MODE: Readonly<Record<TravelMode, string>> = { transit: "TRANSIT", walking: "WALK", driving: "DRIVE" };

export interface GoogleProviderOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export function createGoogleToolProvider(opts: GoogleProviderOptions): ToolProvider {
  const doFetch = opts.fetchImpl ?? fetch;
  const key = opts.apiKey;

  async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
    const res = await doFetch(url, init);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`google ${res.status} ${url.split("?")[0]}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  const latLng = (p: { lat: number; lng: number }): { latitude: number; longitude: number } => ({
    latitude: p.lat,
    longitude: p.lng,
  });

  return {
    async searchPlaces(input: SearchPlacesInput): Promise<Place[]> {
      const body: Record<string, unknown> = { textQuery: input.query, maxResultCount: input.maxResults ?? 10 };
      if (input.type === "restaurant") body.includedType = "restaurant";
      const { lat, lng } = input.center;
      if (typeof lat === "number" && typeof lng === "number") {
        // Always bias to the accommodation so a generic query stays in-region
        // (otherwise Google text search is global). radius defaults to ~20km.
        body.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius: input.radius ?? 20000 } };
      }
      const data = await requestJson<GoogleTextSearchResponse>(`${PLACES_BASE}/places:searchText`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": SEARCH_MASK },
        body: JSON.stringify(body),
      });
      return mapTextSearch(data);
    },

    async getPlaceDetails(input: { placeId: string }): Promise<PlaceDetail> {
      const data = await requestJson<GooglePlace>(`${PLACES_BASE}/places/${encodeURIComponent(input.placeId)}`, {
        headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": DETAIL_MASK },
      });
      return mapPlaceDetail(data);
    },

    async getTravelTime(input: GetTravelTimeInput): Promise<TravelTime> {
      const mode = input.mode ?? "transit";
      const body: Record<string, unknown> = {
        origin: { location: { latLng: latLng(input.origin) } },
        destination: { location: { latLng: latLng(input.destination) } },
        travelMode: TRAVEL_MODE[mode],
      };
      // TRANSIT needs a departure time or Google returns no route.
      if (mode === "transit") body.departureTime = new Date(Date.now() + 60_000).toISOString();
      const fieldMask =
        mode === "transit"
          ? "routes.duration,routes.distanceMeters,routes.legs.steps.transitDetails"
          : "routes.duration,routes.distanceMeters";
      const data = await requestJson<GoogleRoutesResponse>(ROUTES_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": fieldMask },
        body: JSON.stringify(body),
      });
      const route = mapRoute(data, mode);
      if (route.durationMinutes > 0) return route;
      // Google found no route — e.g. transit is unlicensed in some regions
      // (notably Japan). Fall back to the geometric estimate so the tool always
      // returns a sane number; scheduling uses this estimate anyway.
      return {
        durationMinutes: estimateTravelMinutes(input.origin, input.destination, mode),
        distanceMeters: Math.round(haversineMeters(input.origin, input.destination)),
        mode,
      };
    },

    async getTravelMatrix(input): Promise<number[][]> {
      const points = input.points;
      const n = points.length;
      if (n < 2) return [[0]];
      // The matrix API covers DRIVE/WALK (not TRANSIT); driving is a good proxy
      // for ordering + timing and far more accurate than straight-line distance.
      const mode = input.mode === "walking" ? "WALK" : "DRIVE";
      const waypoints = points.map((p) => ({ waypoint: { location: { latLng: latLng(p) } } }));
      const elements = await requestJson<GoogleMatrixElement[]>(MATRIX_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": "originIndex,destinationIndex,duration,condition",
        },
        body: JSON.stringify({ origins: waypoints, destinations: waypoints, travelMode: mode }),
      });
      const matrix = mapRouteMatrix(elements, n);
      // Backfill any pair Google couldn't route with the geometric estimate.
      for (let i = 0; i < n; i += 1) {
        for (let j = 0; j < n; j += 1) {
          if (i !== j && !matrix[i]![j]) matrix[i]![j] = estimateTravelMinutes(points[i]!, points[j]!, "driving");
        }
      }
      return matrix;
    },

    async geocode(input: { query: string }): Promise<GeoLocation | null> {
      const url = `${GEOCODE_URL}?address=${encodeURIComponent(input.query)}&key=${encodeURIComponent(key)}`;
      const data = await requestJson<GoogleGeocodeResponse>(url, {});
      return mapGeocode(data, input.query);
    },

    async getTransitRoute(input: GetTravelTimeInput): Promise<TransitRoute | null> {
      const data = await requestJson<GoogleTransitResponse>(ROUTES_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask":
            "routes.duration,routes.distanceMeters,routes.legs.steps.travelMode,routes.legs.steps.staticDuration,routes.legs.steps.transitDetails",
        },
        body: JSON.stringify({
          origin: { location: { latLng: latLng(input.origin) } },
          destination: { location: { latLng: latLng(input.destination) } },
          travelMode: "TRANSIT",
          departureTime: new Date(Date.now() + 60_000).toISOString(),
        }),
      });
      return mapTransitRoute(data);
    },
  };
}
