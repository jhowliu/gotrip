/**
 * Intra-day route ordering — arrange a day's stops into the shortest walking/
 * transit path so the plan doesn't zig-zag back and forth. Pure and deterministic.
 *
 * The greedy nearest-neighbour used before can strand a nearby stop by grabbing a
 * slightly-closer one on the wrong side; this solves the open-path TSP exactly for
 * a normal day's handful of stops (Held-Karp) and falls back to nearest-neighbour
 * + 2-opt only for improbably long days. "Open path" = we start at the
 * accommodation and don't return, matching a day of sightseeing.
 *
 * Cost defaults to great-circle distance (what ordering has always used); inject a
 * real travel-time matrix here later without touching callers.
 */

import type { GeoLocation } from "./itinerary";
import { haversineMeters } from "./clusterByDay";

export type LegCost = (a: GeoLocation, b: GeoLocation) => number;

/** Above this many stops, skip exact DP (2^n) and refine a greedy tour instead. */
const EXACT_MAX = 12;

const defaultCost: LegCost = (a, b) => haversineMeters(a, b);

export function orderByShortestPath<T extends { location: GeoLocation }>(
  stops: T[],
  start: GeoLocation | null,
  cost: LegCost = defaultCost,
): T[] {
  const n = stops.length;
  if (n <= 1) return [...stops];
  if (n === 2) {
    const [a, b] = stops as [T, T];
    if (!start) return [a, b];
    return cost(start, a.location) <= cost(start, b.location) ? [a, b] : [b, a];
  }
  return n <= EXACT_MAX
    ? heldKarpPath(stops, start, cost)
    : twoOpt(nearestNeighbor(stops, start, cost), start, cost);
}

/** Exact shortest Hamiltonian path from a fixed origin (open end), via Held-Karp. */
function heldKarpPath<T extends { location: GeoLocation }>(stops: T[], start: GeoLocation | null, cost: LegCost): T[] {
  const n = stops.length;
  const dist = stops.map((a) => stops.map((b) => cost(a.location, b.location)));
  // Cost from the origin to each stop; 0 when there's no fixed start (free start).
  const fromOrigin = stops.map((s) => (start ? cost(start, s.location) : 0));
  const size = 1 << n;
  const dp = Array.from({ length: size }, () => new Array<number>(n).fill(Number.POSITIVE_INFINITY));
  const parent = Array.from({ length: size }, () => new Array<number>(n).fill(-1));
  for (let j = 0; j < n; j += 1) dp[1 << j]![j] = fromOrigin[j]!;

  for (let s = 1; s < size; s += 1) {
    for (let j = 0; j < n; j += 1) {
      if (!(s & (1 << j))) continue;
      const cur = dp[s]![j]!;
      if (!Number.isFinite(cur)) continue;
      for (let k = 0; k < n; k += 1) {
        if (s & (1 << k)) continue;
        const ns = s | (1 << k);
        const cand = cur + dist[j]![k]!;
        if (cand < dp[ns]![k]!) {
          dp[ns]![k] = cand;
          parent[ns]![k] = j;
        }
      }
    }
  }

  const full = size - 1;
  let end = 0;
  let best = Number.POSITIVE_INFINITY;
  for (let j = 0; j < n; j += 1) {
    if (dp[full]![j]! < best) {
      best = dp[full]![j]!;
      end = j;
    }
  }

  const idx: number[] = [];
  let s = full;
  let j = end;
  while (j !== -1) {
    idx.push(j);
    const p = parent[s]![j]!;
    s ^= 1 << j;
    j = p;
  }
  idx.reverse();
  return idx.map((i) => stops[i]!);
}

function nearestNeighbor<T extends { location: GeoLocation }>(stops: T[], start: GeoLocation | null, cost: LegCost): T[] {
  const remaining = [...stops];
  const ordered: T[] = [];
  let cursor: GeoLocation | null = start;
  while (remaining.length > 0) {
    let bi = 0;
    if (cursor) {
      let bd = Number.POSITIVE_INFINITY;
      remaining.forEach((s, i) => {
        const d = cost(cursor!, s.location);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      });
    }
    const next = remaining.splice(bi, 1)[0]!;
    ordered.push(next);
    cursor = next.location;
  }
  return ordered;
}

function pathCost<T extends { location: GeoLocation }>(order: T[], start: GeoLocation | null, cost: LegCost): number {
  let total = start && order[0] ? cost(start, order[0].location) : 0;
  for (let i = 1; i < order.length; i += 1) total += cost(order[i - 1]!.location, order[i]!.location);
  return total;
}

function twoOpt<T extends { location: GeoLocation }>(initial: T[], start: GeoLocation | null, cost: LegCost): T[] {
  let best = [...initial];
  let bestCost = pathCost(best, start, cost);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i += 1) {
      for (let k = i + 1; k < best.length; k += 1) {
        const cand = [...best.slice(0, i), ...best.slice(i, k + 1).reverse(), ...best.slice(k + 1)];
        const c = pathCost(cand, start, cost);
        if (c + 1e-9 < bestCost) {
          best = cand;
          bestCost = c;
          improved = true;
        }
      }
    }
  }
  return best;
}
