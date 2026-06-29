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

// --- Taipei demo fixture: backs the web/CLI in mock mode (no Google key) ---
// The Tokyo set above stays the test regression suite; this is the demo data.

export const TAIPEI_ACCOMMODATION: Location = {
  name: "Taipei Main Station Hotel",
  lat: 25.0478,
  lng: 121.517,
};

export const TAIPEI_PLACES: PlaceDetail[] = [
  {
    placeId: "p_taipei101",
    name: "Taipei 101",
    category: "landmark",
    location: { name: "Taipei 101", lat: 25.0339, lng: 121.5645 },
    rating: 4.5,
    priceLevel: 2,
    estimatedVisitMinutes: 90,
    ticketPrice: 600,
  },
  {
    placeId: "p_palace",
    name: "National Palace Museum",
    category: "museum",
    location: { name: "National Palace Museum", lat: 25.1024, lng: 121.5485 },
    rating: 4.6,
    priceLevel: 1,
    estimatedVisitMinutes: 120,
    ticketPrice: 350,
  },
  {
    placeId: "p_cks",
    name: "Chiang Kai-shek Memorial Hall",
    category: "landmark",
    location: { name: "Chiang Kai-shek Memorial Hall", lat: 25.0347, lng: 121.5219 },
    rating: 4.6,
    priceLevel: 0,
    estimatedVisitMinutes: 60,
    ticketPrice: 0,
  },
  {
    placeId: "p_longshan",
    name: "Longshan Temple",
    category: "temple",
    location: { name: "Longshan Temple", lat: 25.037, lng: 121.4998 },
    rating: 4.5,
    priceLevel: 0,
    estimatedVisitMinutes: 45,
    ticketPrice: 0,
  },
  {
    placeId: "p_shilin",
    name: "Shilin Night Market",
    category: "market",
    location: { name: "Shilin Night Market", lat: 25.0877, lng: 121.524 },
    rating: 4.3,
    priceLevel: 1,
    estimatedVisitMinutes: 90,
    ticketPrice: 0,
  },
  {
    placeId: "p_daan",
    name: "Da'an Forest Park",
    category: "park",
    location: { name: "Da'an Forest Park", lat: 25.0295, lng: 121.536 },
    rating: 4.5,
    priceLevel: 0,
    estimatedVisitMinutes: 60,
    ticketPrice: 0,
  },
];

// --- Adversarial fixture: a must-visit with a narrow morning window ---
// A naive (geometry-only) schedule visits it late → CLOSED_HOURS; the agent must
// re-plan with respectWindows so it lands inside 09:00–10:30.

export const ADVERSARIAL_ACCOMMODATION: Location = {
  name: "Center Hotel",
  lat: 35.69,
  lng: 139.7,
};

export const ADVERSARIAL_NARROW_WINDOW: PlaceDetail[] = [
  {
    placeId: "a_near",
    name: "Near Cafe",
    category: "cafe",
    location: { name: "Near Cafe", lat: 35.692, lng: 139.702 },
    estimatedVisitMinutes: 60,
    ticketPrice: 0,
  },
  {
    placeId: "a_mid",
    name: "Mid Park",
    category: "park",
    location: { name: "Mid Park", lat: 35.7, lng: 139.72 },
    estimatedVisitMinutes: 60,
    ticketPrice: 0,
  },
  {
    placeId: "a_sunrise",
    name: "Sunrise Museum",
    category: "museum",
    location: { name: "Sunrise Museum", lat: 35.72, lng: 139.78 },
    estimatedVisitMinutes: 60,
    openWindow: ["09:00", "10:30"],
    ticketPrice: 0,
  },
];

// --- Adversarial fixture: pricey galleries that bust an economy budget ---
// A free must-visit survives; the agent must trim the expensive non-must-visits.

export const ADVERSARIAL_OVER_BUDGET: PlaceDetail[] = [
  {
    placeId: "b_shrine",
    name: "Free Shrine",
    category: "shrine",
    location: { name: "Free Shrine", lat: 35.69, lng: 139.7 },
    estimatedVisitMinutes: 45,
    ticketPrice: 0,
  },
  {
    placeId: "b_gallA",
    name: "Gallery A",
    category: "museum",
    location: { name: "Gallery A", lat: 35.692, lng: 139.702 },
    estimatedVisitMinutes: 60,
    ticketPrice: 4000,
  },
  {
    placeId: "b_gallB",
    name: "Gallery B",
    category: "museum",
    location: { name: "Gallery B", lat: 35.694, lng: 139.704 },
    estimatedVisitMinutes: 60,
    ticketPrice: 4000,
  },
  {
    placeId: "b_gallC",
    name: "Gallery C",
    category: "museum",
    location: { name: "Gallery C", lat: 35.696, lng: 139.706 },
    estimatedVisitMinutes: 60,
    ticketPrice: 4000,
  },
];
