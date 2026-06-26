/**
 * The ToolProvider port — the real-data source behind the tools. Mock and Google
 * implementations both satisfy this; the inner layers don't change between
 * M0–M3 (mock) and M4 (Google). This is what makes "mock-first" work.
 */

import type { GeoLocation, Location, Place, PlaceDetail, PlaceType, TravelMode, TravelTime } from "../../domain/itinerary";

export interface SearchPlacesInput {
  query: string;
  center: Location;
  radius?: number;
  type?: PlaceType;
  maxResults?: number;
}

export interface GetTravelTimeInput {
  origin: GeoLocation | { lat: number; lng: number };
  destination: GeoLocation | { lat: number; lng: number };
  mode?: TravelMode;
}

export interface ToolProvider {
  searchPlaces(input: SearchPlacesInput): Promise<Place[]>;
  getPlaceDetails(input: { placeId: string }): Promise<PlaceDetail>;
  getTravelTime(input: GetTravelTimeInput): Promise<TravelTime>;
}
