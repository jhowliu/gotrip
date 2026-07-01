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
import { estimateTravelMinutes } from "../../../domain/travel";

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

      // Name match: when the query names a specific place (e.g. must-visit
      // resolution "teamLab Planets Tokyo"), narrow to it; generic queries pass.
      const q = input.query.toLowerCase();
      const named = list.filter((p) => q.includes(p.name.toLowerCase()));
      if (named.length > 0) list = named;

      const { lat, lng } = input.center;
      if (typeof lat === "number" && typeof lng === "number") {
        const center = { lat, lng };
        if (input.radius) list = list.filter((p) => haversineMeters(center, p.location) <= input.radius!);
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
      const mode = input.mode ?? "transit";
      return {
        durationMinutes: estimateTravelMinutes(input.origin, input.destination, mode),
        distanceMeters: Math.round(haversineMeters(input.origin, input.destination)),
        mode,
      };
    },

    async getTravelMatrix(input) {
      const mode = input.mode ?? "driving";
      return input.points.map((a) =>
        input.points.map((b) => (a === b ? 0 : estimateTravelMinutes(a, b, mode))),
      );
    },

    async geocode(input: { query: string }) {
      const q = input.query.toLowerCase();
      const match = places.find(
        (p) => p.name.toLowerCase().includes(q) || q.includes(p.name.toLowerCase()),
      );
      return match ? match.location : null;
    },

    async getTransitRoute() {
      return null; // no transit-line data in the mock
    },
  };
}
