/**
 * Domain entities — pure types, zero I/O, zero external deps.
 * Everything else in the system is built around these.
 */

export interface Location {
  name: string;
  lat?: number;
  lng?: number;
}

/** A location guaranteed to carry coordinates (e.g. after geocoding / details lookup). */
export interface GeoLocation {
  name: string;
  lat: number;
  lng: number;
}

export interface FlightInfo {
  airport: string;
  datetime: string; // ISO 8601
}

export interface MustVisit {
  name: string;
  placeId?: string; // carried when picked from autocomplete → zero ambiguity
  location?: Location;
}

export type BudgetLevel = "economy" | "moderate" | "luxury";
export type Pace = "relaxed" | "packed";

/** A per-day spend band (destination currency). `max` is the hard ceiling. */
export interface BudgetRange {
  min?: number;
  max: number;
}

export interface TripRequest {
  days: number;
  destination: string;
  accommodation: Location;
  mustVisit?: MustVisit[];
  arrival?: FlightInfo;
  departure?: FlightInfo;
  budgetLevel?: BudgetLevel;
  /** Explicit per-day budget band; takes precedence over budgetLevel. */
  budget?: BudgetRange;
  pace?: Pace;
}

export type PlaceType = "attraction" | "restaurant";
export type PriceLevel = 0 | 1 | 2 | 3 | 4;

/** Lightweight result from a place search — what the agent triages before paying for details. */
export interface Place {
  placeId: string;
  name: string;
  category: string;
  rating?: number;
  priceLevel?: PriceLevel;
  shortAddress?: string;
}

/** Full place details — carries coordinates and the data planning needs. */
export interface PlaceDetail {
  placeId: string;
  name: string;
  category: string;
  location: GeoLocation;
  openingHours?: string[];
  /** Daily open window ["HH:MM","HH:MM"] for timing checks. Omitted = always open. */
  openWindow?: [string, string];
  rating?: number;
  priceLevel?: PriceLevel;
  estimatedVisitMinutes?: number;
  ticketPrice?: number;
}

export type TravelMode = "transit" | "walking" | "driving";

export interface TravelTime {
  durationMinutes: number;
  distanceMeters: number;
  mode: TravelMode;
}

/** One leg of a transit journey — a walk segment or a ride on a line. */
export interface TransitStep {
  mode: "walk" | "transit";
  durationMinutes?: number;
  line?: string; // e.g. "Bannan Line" / "BL"
  vehicle?: string; // SUBWAY / BUS / TRAIN …
  from?: string; // board stop
  to?: string; // alight stop
  stops?: number; // intermediate stop count
}

/** A door-to-door transit route with a human-readable summary (Google, covered regions). */
export interface TransitRoute {
  legs: TransitStep[];
  summary: string;
  durationMinutes: number;
  distanceMeters: number;
}

export type ItemKind = "visit" | "meal" | "transit";

/**
 * One scheduled block in the itinerary. Single source of time truth:
 * store `startTime` + `durationMinutes`; `endTime` is computed (see timing.ts).
 */
export interface ItineraryItem {
  itemId: string; // stable id — conversational edits refer to it, never an array index
  kind: ItemKind;
  placeId?: string;
  name: string;
  startTime: string; // "HH:MM"
  durationMinutes: number;
  mode?: TravelMode; // transit-only
  mealWindow?: [string, string]; // meal-only
  pinned?: boolean; // must-visit / user-fixed — re-plan must not move it
  estimatedCost?: number;
}

export interface ItineraryDay {
  dayIndex: number; // 1-based
  items: ItineraryItem[]; // ordered by startTime
}

export interface Itinerary {
  request: TripRequest;
  days: ItineraryDay[];
  totalCost?: number;
}

export type ViolationSource = "user_instruction" | "constraint";

export interface Violation {
  code: string;
  message: string; // plain language — a hint for the agent to self-correct
  dayIndex?: number;
  itemId?: string;
  source: ViolationSource;
}

export interface ValidationResult {
  hardViolations: Violation[]; // non-empty = invalid, blocks finalize
  softWarnings: Violation[]; // informational only
}

/** A day assignment produced by clusterByDay. */
export interface DayAssignment {
  dayIndex: number; // 1-based
  placeIds: string[];
}
