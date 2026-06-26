/**
 * Mock ToolProvider — serves the fixtures with zero network/API calls. Search
 * returns lightweight summaries (so the agent triages before paying for details);
 * details/travel are derived from the fixture coordinates.
 */

import type { Place, PlaceDetail } from "../../../domain/itinerary";
import type {
  GetTravelTimeInput,
  SearchPlacesInput,
  ToolProvider,
} from "../../../application/ports/ToolProvider";
import { haversineMeters } from "../../../domain/clusterByDay";

const RESTAURANT_CATEGORIES = new Set(["restaurant", "cafe"]);

function toPlace(detail: PlaceDetail): Place {
  const place: Place = {
    placeId: detail.placeId,
    name: detail.name,
    category: detail.category,
  };
  if (typeof detail.rating === "number") place.rating = detail.rating;
  if (typeof detail.priceLevel === "number") place.priceLevel = detail.priceLevel;
  return place;
}

export function createMockToolProvider(places: PlaceDetail[]): ToolProvider {
  const byId = new Map(places.map((p) => [p.placeId, p]));

  return {
    async searchPlaces(input: SearchPlacesInput): Promise<Place[]> {
      let list = places;
      if (input.type === "restaurant") {
        list = places.filter((p) => RESTAURANT_CATEGORIES.has(p.category));
      } else if (input.type === "attraction") {
        list = places.filter((p) => !RESTAURANT_CATEGORIES.has(p.category));
      }

      const { lat, lng } = input.center;
      if (typeof lat === "number" && typeof lng === "number") {
        const center = { lat, lng };
        list = [...list].sort(
          (a, b) => haversineMeters(center, a.location) - haversineMeters(center, b.location),
        );
      }

      const max = input.maxResults ?? 10;
      return list.slice(0, max).map(toPlace);
    },

    async getPlaceDetails(input: { placeId: string }): Promise<PlaceDetail> {
      const detail = byId.get(input.placeId);
      if (!detail) throw new Error(`no such place: ${input.placeId}`);
      return detail;
    },

    async getTravelTime(input: GetTravelTimeInput) {
      const meters = haversineMeters(input.origin, input.destination);
      const mode = input.mode ?? "transit";
      const metersPerMin = mode === "walking" ? 80 : mode === "driving" ? 600 : 400;
      const wait = mode === "transit" ? 5 : 0;
      return {
        durationMinutes: Math.round(meters / metersPerMin) + wait,
        distanceMeters: Math.round(meters),
        mode,
      };
    },
  };
}
