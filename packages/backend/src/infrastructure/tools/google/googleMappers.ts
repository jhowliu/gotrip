/**
 * Pure mappers from Google API responses → domain types. No network, no SDK —
 * just shape translation, so they're exhaustively unit-testable against recorded
 * JSON. The GoogleToolProvider (M4) does the fetching and delegates the shaping
 * here. Targets Places API (New) v1 + classic Geocoding + Routes API.
 */

import type { GeoLocation, Place, PlaceDetail, PriceLevel, TravelMode, TravelTime } from "../../../domain/itinerary";

// ---- Places API (New) v1 shapes (only the fields we request) ----

export interface GooglePeriodPoint {
  day?: number;
  hour?: number;
  minute?: number;
}
export interface GooglePeriod {
  open?: GooglePeriodPoint;
  close?: GooglePeriodPoint;
}
export interface GooglePlace {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
  rating?: number;
  priceLevel?: string; // "PRICE_LEVEL_*"
  types?: string[];
  regularOpeningHours?: { periods?: GooglePeriod[] };
}

const PRICE_LEVELS: Readonly<Record<string, PriceLevel>> = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

export function mapPriceLevel(level?: string): PriceLevel | undefined {
  return level ? PRICE_LEVELS[level] : undefined;
}

/** First matching Google type wins → our domain category (drives visit-minutes). */
const TYPE_CATEGORY: ReadonlyArray<readonly [string, string]> = [
  ["museum", "museum"],
  ["art_gallery", "museum"],
  ["aquarium", "landmark"],
  ["zoo", "landmark"],
  ["amusement_park", "landmark"],
  ["national_park", "park"],
  ["park", "park"],
  ["garden", "garden"],
  ["hindu_temple", "temple"],
  ["church", "temple"],
  ["mosque", "temple"],
  ["synagogue", "temple"],
  ["place_of_worship", "temple"],
  ["shopping_mall", "shopping"],
  ["department_store", "shopping"],
  ["market", "market"],
  ["store", "shopping"],
  ["bakery", "cafe"],
  ["cafe", "cafe"],
  ["restaurant", "restaurant"],
  ["food", "restaurant"],
  ["tourist_attraction", "landmark"],
  ["point_of_interest", "landmark"],
];

export function googleTypesToCategory(types: string[] = []): string {
  const set = new Set(types);
  for (const [type, category] of TYPE_CATEGORY) if (set.has(type)) return category;
  return "landmark";
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * Reduce Google's per-day periods to one daily ["HH:MM","HH:MM"] window (the
 * domain carries a single window). Uses the first period; a 24h place (open with
 * no close) or missing data → undefined (treated as always open).
 */
export function openingHoursToWindow(hours?: { periods?: GooglePeriod[] }): [string, string] | undefined {
  const period = hours?.periods?.[0];
  if (!period?.open || !period.close) return undefined;
  const open = `${pad2(period.open.hour ?? 0)}:${pad2(period.open.minute ?? 0)}`;
  const close = `${pad2(period.close.hour ?? 0)}:${pad2(period.close.minute ?? 0)}`;
  return [open, close];
}

export function mapPlaceDetail(place: GooglePlace): PlaceDetail {
  const name = place.displayName?.text ?? place.id;
  const detail: PlaceDetail = {
    placeId: place.id,
    name,
    category: googleTypesToCategory(place.types),
    location: { name, lat: place.location?.latitude ?? 0, lng: place.location?.longitude ?? 0 },
  };
  const window = openingHoursToWindow(place.regularOpeningHours);
  if (window) detail.openWindow = window;
  if (typeof place.rating === "number") detail.rating = place.rating;
  const price = mapPriceLevel(place.priceLevel);
  if (price !== undefined) detail.priceLevel = price;
  return detail;
}

export function mapPlaceSummary(place: GooglePlace): Place {
  const summary: Place = {
    placeId: place.id,
    name: place.displayName?.text ?? place.id,
    category: googleTypesToCategory(place.types),
  };
  if (typeof place.rating === "number") summary.rating = place.rating;
  const price = mapPriceLevel(place.priceLevel);
  if (price !== undefined) summary.priceLevel = price;
  if (place.formattedAddress) summary.shortAddress = place.formattedAddress;
  return summary;
}

export interface GoogleTextSearchResponse {
  places?: GooglePlace[];
}
export function mapTextSearch(resp: GoogleTextSearchResponse): Place[] {
  return (resp.places ?? []).map(mapPlaceSummary);
}

// ---- Geocoding API (classic JSON) ----

export interface GoogleGeocodeResponse {
  status?: string;
  results?: Array<{ geometry?: { location?: { lat: number; lng: number } }; formatted_address?: string }>;
}
export function mapGeocode(resp: GoogleGeocodeResponse, name: string): GeoLocation | null {
  const loc = resp.results?.[0]?.geometry?.location;
  if (!loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") return null;
  return { name, lat: loc.lat, lng: loc.lng };
}

// ---- Routes API (computeRoutes) ----

export interface GoogleRoutesResponse {
  routes?: Array<{ distanceMeters?: number; duration?: string }>;
}
export function mapRoute(resp: GoogleRoutesResponse, mode: TravelMode): TravelTime {
  const route = resp.routes?.[0];
  const seconds = route?.duration ? Number.parseInt(String(route.duration).replace("s", ""), 10) : 0;
  return {
    durationMinutes: Math.round((Number.isFinite(seconds) ? seconds : 0) / 60),
    distanceMeters: route?.distanceMeters ?? 0,
    mode,
  };
}
