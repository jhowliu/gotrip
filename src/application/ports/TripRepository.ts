/**
 * TripRepository port — persistence behind an interface so the agent never knows
 * the storage layer exists. FileSessionStore (per-session JSON) implements it
 * first; a SQLite hybrid store swaps in later (with `listTopTrips`) without
 * touching the inner layers.
 */

import type { Itinerary } from "../../domain/itinerary";

export interface TripRepository {
  load(sessionId: string): Promise<Itinerary | null>;
  save(sessionId: string, itinerary: Itinerary): Promise<void>;
}
