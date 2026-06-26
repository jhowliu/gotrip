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
