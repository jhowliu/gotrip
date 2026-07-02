/**
 * Inter-day clustering — assign candidate places across N days using coordinate
 * (haversine) distance only. No travel-time API calls (those verify same-day legs
 * later). Pure and deterministic given its input.
 *
 * Strategy: honour pinned places, seed the remaining days farthest-first so
 * distinct areas separate, then assign the rest to the nearest day centroid under
 * a soft per-day capacity.
 */

import type { DayAssignment, GeoLocation } from "./itinerary";

export interface ClusterPlace {
  placeId: string;
  lat: number;
  lng: number;
}

export interface ClusterInput {
  places: ClusterPlace[];
  days: number;
  /** Places fixed to a specific day (e.g. user-pinned). 1-based dayIndex. */
  pinned?: { placeId: string; dayIndex: number }[];
  /** Seed reference for empty days (typically the accommodation). */
  center?: GeoLocation;
}

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance in metres. */
export function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

interface Bucket {
  dayIndex: number;
  members: ClusterPlace[];
  sumLat: number;
  sumLng: number;
}

function centroidOf(bucket: Bucket): { lat: number; lng: number } | null {
  if (bucket.members.length === 0) return null;
  return { lat: bucket.sumLat / bucket.members.length, lng: bucket.sumLng / bucket.members.length };
}

function place(bucket: Bucket, p: ClusterPlace): void {
  bucket.members.push(p);
  bucket.sumLat += p.lat;
  bucket.sumLng += p.lng;
}

export function clusterByDay(input: ClusterInput): DayAssignment[] {
  const days = Math.max(1, Math.floor(input.days));
  const buckets: Bucket[] = Array.from({ length: days }, (_, i) => ({
    dayIndex: i + 1,
    members: [],
    sumLat: 0,
    sumLng: 0,
  }));

  const byId = new Map(input.places.map((p) => [p.placeId, p]));
  const assigned = new Set<string>();

  // 1. Honour pinned assignments first.
  for (const pin of input.pinned ?? []) {
    const p = byId.get(pin.placeId);
    const bucket = buckets[pin.dayIndex - 1];
    if (p && bucket && !assigned.has(p.placeId)) {
      place(bucket, p);
      assigned.add(p.placeId);
    }
  }

  // Sorted pool for determinism.
  const pool = input.places
    .filter((p) => !assigned.has(p.placeId))
    .sort((a, b) => a.placeId.localeCompare(b.placeId));

  // 2. Farthest-first seed empty days.
  const seedPoints: { lat: number; lng: number }[] = buckets
    .map(centroidOf)
    .filter((c): c is { lat: number; lng: number } => c !== null);
  if (input.center) seedPoints.push(input.center);

  for (const bucket of buckets) {
    if (bucket.members.length > 0) continue;
    let best: ClusterPlace | null = null;
    let bestScore = -1;
    for (const p of pool) {
      if (assigned.has(p.placeId)) continue;
      const score =
        seedPoints.length === 0 ? 0 : Math.min(...seedPoints.map((s) => haversineMeters(s, p)));
      if (best === null || score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    if (!best) break; // no places left to seed
    place(bucket, best);
    assigned.add(best.placeId);
    seedPoints.push(best);
  }

  // 3. Assign the rest to the nearest centroid under a soft capacity.
  const capacity = Math.ceil(input.places.length / days);
  for (const p of pool) {
    if (assigned.has(p.placeId)) continue;
    const open = buckets.filter((b) => b.members.length < capacity);
    const candidates = open.length > 0 ? open : buckets;
    let best = candidates[0]!;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const b of candidates) {
      const c = centroidOf(b) ?? input.center ?? null;
      const dist = c ? haversineMeters(c, p) : 0;
      if (dist < bestDist) {
        bestDist = dist;
        best = b;
      }
    }
    place(best, p);
    assigned.add(p.placeId);
  }

  return buckets.map((b) => ({ dayIndex: b.dayIndex, placeIds: b.members.map((m) => m.placeId) }));
}

export interface ClusterByCostInput {
  ids: string[];
  days: number;
  /** Travel minutes between two places (real matrix) — the clustering cost. */
  cost: (a: string, b: string) => number;
  /** Travel minutes from the accommodation to a place — seeds the farthest day first. */
  centerCost?: (id: string) => number;
  pinned?: { id: string; dayIndex: number }[];
}

/**
 * Like clusterByDay, but partitions on a real travel-cost matrix instead of
 * straight-line coordinates — so an island reached by a long road (short as the
 * crow flies) is correctly kept off a downtown day. Medoid-based: seed one day
 * per far-apart place, then assign the rest to the nearest medoid under a soft
 * per-day capacity.
 */
export function clusterByCost(input: ClusterByCostInput): DayAssignment[] {
  const days = Math.max(1, Math.floor(input.days));
  const buckets: string[][] = Array.from({ length: days }, () => []);
  const medoids: (string | null)[] = Array.from({ length: days }, () => null);
  const assigned = new Set<string>();

  for (const pin of input.pinned ?? []) {
    const bucket = buckets[pin.dayIndex - 1];
    if (bucket && !assigned.has(pin.id)) {
      bucket.push(pin.id);
      assigned.add(pin.id);
      if (!medoids[pin.dayIndex - 1]) medoids[pin.dayIndex - 1] = pin.id;
    }
  }

  const pool = input.ids.filter((id) => !assigned.has(id)).sort();

  // Farthest-first seeds: first the place farthest from the hotel, then each next
  // day the place farthest (max-min travel) from the already-seeded days.
  for (let d = 0; d < days; d += 1) {
    if (medoids[d]) continue;
    const seeds = medoids.filter((m): m is string => m !== null);
    let best: string | null = null;
    let bestScore = -1;
    for (const id of pool) {
      if (assigned.has(id)) continue;
      const score =
        seeds.length === 0
          ? (input.centerCost?.(id) ?? 0)
          : Math.min(...seeds.map((m) => input.cost(m, id)));
      if (score > bestScore) {
        bestScore = score;
        best = id;
      }
    }
    if (!best) break;
    medoids[d] = best;
    buckets[d]!.push(best);
    assigned.add(best);
  }

  const capacity = Math.ceil(input.ids.length / days);
  for (const id of pool) {
    if (assigned.has(id)) continue;
    const open = buckets.map((b, d) => ({ d, size: b.length })).filter((x) => x.size < capacity);
    const candidates = open.length > 0 ? open : buckets.map((b, d) => ({ d, size: b.length }));
    let bestDay = candidates[0]!.d;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const { d } of candidates) {
      const medoid = medoids[d];
      const c = medoid ? input.cost(medoid, id) : (input.centerCost?.(id) ?? 0);
      if (c < bestCost) {
        bestCost = c;
        bestDay = d;
      }
    }
    buckets[bestDay]!.push(id);
    assigned.add(id);
  }

  return buckets.map((ids, d) => ({ dayIndex: d + 1, placeIds: ids }));
}

export interface CarveDayTripsInput {
  /** All sightseeing ids (must-visits included, restaurants excluded). */
  attractionIds: string[];
  /** Far must-visit ids (subset of attractionIds) — each earns its own day. */
  anchorIds: string[];
  days: number;
  /** Travel minutes between two places (real matrix). */
  cost: (a: string, b: string) => number;
  /** Travel minutes accommodation → a place. */
  centerCost: (id: string) => number;
}

export interface CarveDayTripsResult {
  assignments: DayAssignment[];
  /** 1-based day indices that are day-trips (long commute expected). */
  dayTripDays: number[];
}

/**
 * Carve out day-trips. A far anchor (a must-visit hours from the accommodation) is
 * invisible to the agent — it's auto-pinned by code — so the agent can't dedicate a
 * day to it; code does. Each anchor gets its own day plus any companion that sits
 * closer to the anchor than to the accommodation (a lookout by the desert, not back
 * in town); the remaining "city" places are clustered into the other days by real
 * travel. Returns null when there's no clean carve (no anchors, or too few days to
 * keep at least one city day) — the caller then keeps the agent's own grouping.
 */
export function carveDayTrips(input: CarveDayTripsInput): CarveDayTripsResult | null {
  const days = Math.max(1, Math.floor(input.days));
  const anchors = [...new Set(input.anchorIds)].filter((id) => input.attractionIds.includes(id));
  if (anchors.length === 0 || anchors.length >= days) return null; // keep ≥1 city day

  const anchorSet = new Set(anchors);
  const dayTripPlaces = new Map<string, string[]>(anchors.map((a) => [a, [a]] as [string, string[]]));
  const cityIds: string[] = [];
  for (const id of input.attractionIds) {
    if (anchorSet.has(id)) continue;
    let nearest: string | null = null;
    let nearestCost = Number.POSITIVE_INFINITY;
    for (const a of anchors) {
      const c = input.cost(a, id);
      if (c < nearestCost) {
        nearestCost = c;
        nearest = a;
      }
    }
    // Belongs to the day-trip only if it's genuinely nearer the anchor than home.
    if (nearest && nearestCost < input.centerCost(id)) dayTripPlaces.get(nearest)!.push(id);
    else cityIds.push(id);
  }

  const cityDayCount = days - anchors.length;
  const cityDays = clusterByCost({
    ids: cityIds,
    days: cityDayCount,
    cost: input.cost,
    centerCost: input.centerCost,
  });
  const assignments: DayAssignment[] = cityDays.map((d, i) => ({ dayIndex: i + 1, placeIds: d.placeIds }));
  anchors.forEach((a, i) => {
    assignments.push({ dayIndex: cityDayCount + i + 1, placeIds: dayTripPlaces.get(a)! });
  });
  return { assignments, dayTripDays: anchors.map((_, i) => cityDayCount + i + 1) };
}
