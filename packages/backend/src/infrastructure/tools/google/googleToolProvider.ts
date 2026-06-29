/**
 * GoogleToolProvider (M4) — implements the ToolProvider port against the real
 * Google APIs (Places API New v1 · Routes · classic Geocoding). All response
 * shaping is delegated to the pure mappers; this file only builds requests and
 * handles transport. `fetchImpl` is injectable so the wiring is unit-testable
 * without network. Keys live in env (GOOGLE_MAPS_API_KEY), never in code.
 */

import type { GeoLocation, Place, PlaceDetail, TravelMode, TravelTime } from "../../../domain/itinerary";
import type { GetTravelTimeInput, SearchPlacesInput, ToolProvider } from "../../../application/ports/ToolProvider";
import { haversineMeters } from "../../../domain/clusterByDay";
import { estimateTravelMinutes } from "../../../domain/travel";
import {
  mapGeocode,
  mapPlaceDetail,
  mapRoute,
  mapTextSearch,
  type GoogleGeocodeResponse,
  type GooglePlace,
  type GoogleRoutesResponse,
  type GoogleTextSearchResponse,
} from "./googleMappers";

const PLACES_BASE = "https://places.googleapis.com/v1";
const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

const DETAIL_MASK = "id,displayName,formattedAddress,location,rating,priceLevel,types,regularOpeningHours";
const SEARCH_MASK =
  "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.priceLevel,places.types";

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
      if (typeof lat === "number" && typeof lng === "number" && input.radius) {
        body.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius: input.radius } };
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

    async geocode(input: { query: string }): Promise<GeoLocation | null> {
      const url = `${GEOCODE_URL}?address=${encodeURIComponent(input.query)}&key=${encodeURIComponent(key)}`;
      const data = await requestJson<GoogleGeocodeResponse>(url, {});
      return mapGeocode(data, input.query);
    },
  };
}
