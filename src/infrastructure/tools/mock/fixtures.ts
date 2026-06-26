/**
 * Realistic fixture — a small set of real-ish Tokyo places with coordinates.
 * Used for the M0 smoke test / demo. Adversarial fixtures (which trip specific
 * constraints) arrive in M1.
 */

import type { Location, PlaceDetail } from "../../../domain/itinerary";

/** A typical Shinjuku accommodation, used as the planning center. */
export const TOKYO_ACCOMMODATION: Location = {
  name: "Shinjuku Hotel",
  lat: 35.6938,
  lng: 139.7034,
};

export const TOKYO_PLACES: PlaceDetail[] = [
  {
    placeId: "p_meiji",
    name: "Meiji Shrine",
    category: "shrine",
    location: { name: "Meiji Shrine", lat: 35.6764, lng: 139.6993 },
    rating: 4.6,
    priceLevel: 0,
    estimatedVisitMinutes: 75,
    ticketPrice: 0,
  },
  {
    placeId: "p_shinjuku_gyoen",
    name: "Shinjuku Gyoen",
    category: "garden",
    location: { name: "Shinjuku Gyoen", lat: 35.6852, lng: 139.71 },
    rating: 4.6,
    priceLevel: 1,
    estimatedVisitMinutes: 90,
    ticketPrice: 500,
  },
  {
    placeId: "p_teamlab",
    name: "teamLab Planets",
    category: "museum",
    location: { name: "teamLab Planets", lat: 35.6499, lng: 139.7903 },
    rating: 4.5,
    priceLevel: 3,
    estimatedVisitMinutes: 120,
    ticketPrice: 3800,
  },
  {
    placeId: "p_sensoji",
    name: "Senso-ji",
    category: "temple",
    location: { name: "Senso-ji", lat: 35.7148, lng: 139.7967 },
    rating: 4.5,
    priceLevel: 0,
    estimatedVisitMinutes: 60,
    ticketPrice: 0,
  },
  {
    placeId: "p_ueno",
    name: "Ueno Park",
    category: "park",
    location: { name: "Ueno Park", lat: 35.7156, lng: 139.7745 },
    rating: 4.4,
    priceLevel: 0,
    estimatedVisitMinutes: 75,
    ticketPrice: 0,
  },
  {
    placeId: "p_shibuya",
    name: "Shibuya Crossing",
    category: "landmark",
    location: { name: "Shibuya Crossing", lat: 35.6595, lng: 139.7004 },
    rating: 4.5,
    priceLevel: 0,
    estimatedVisitMinutes: 40,
    ticketPrice: 0,
  },
];
