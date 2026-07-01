/**
 * Attraction curation — pick a diverse, high-quality subset of the detailed
 * candidates so a plan isn't padded with near-duplicates (five similar parks).
 * Pure and deterministic. The agent searches broadly; this trims the pool down
 * to what actually fits the trip, and reports a shortfall so the agent can go
 * search for more when the pool is too thin.
 *
 * Rules: pinned (must-visit) places are always kept; the rest are ranked by a
 * quality score (rating weighted by how many people rated it, so a 4.9 with 8
 * ratings loses to a 4.5 with 5000) and picked greedily under a per-type cap and
 * a near-duplicate suppressor (same fine type + very close = redundant).
 */

import type { PlaceDetail } from "./itinerary";
import { haversineMeters } from "./clusterByDay";

export interface SelectInput {
  places: PlaceDetail[];
  /** Soft target — how many places to keep (e.g. days × perDayVisitTarget). */
  targetCount: number;
  /** Must-visits — always kept, and they count toward caps / near-dup. */
  pinnedIds?: ReadonlySet<string>;
  /** Max places sharing one fine type (primaryType, else category). Default 2. */
  perTypeCap?: number;
  /** Two same-type places closer than this are near-duplicates. Default 400m. */
  nearDuplicateMeters?: number;
}

export interface SelectResult {
  /** Chosen placeIds — pinned first, then picks in quality order. */
  selected: string[];
  dropped: string[];
  /** How many short of targetCount (0 = met) — a hint to search for more. */
  shortBy: number;
}

const DEFAULT_PER_TYPE_CAP = 2;
const DEFAULT_NEAR_DUPLICATE_M = 400;

const typeKey = (p: PlaceDetail): string => (p.primaryType ?? p.category).toLowerCase();

/**
 * Quality score = rating × popularity weight. The weight is log-scaled on the
 * rating count so a handful of glowing ratings can't outrank a broadly-loved
 * place. When the count is unknown (e.g. mock data) it falls back to rating alone.
 */
export function qualityScore(p: PlaceDetail): number {
  const rating = p.rating ?? 0;
  const weight = typeof p.userRatingCount === "number" ? Math.log10(p.userRatingCount + 1) : 1;
  return rating * weight;
}

export function selectPlaces(input: SelectInput): SelectResult {
  const perTypeCap = input.perTypeCap ?? DEFAULT_PER_TYPE_CAP;
  const nearM = input.nearDuplicateMeters ?? DEFAULT_NEAR_DUPLICATE_M;
  const pinned = input.pinnedIds ?? new Set<string>();

  const selected: PlaceDetail[] = [];
  const typeCounts = new Map<string, number>();
  const bump = (p: PlaceDetail): void => {
    selected.push(p);
    typeCounts.set(typeKey(p), (typeCounts.get(typeKey(p)) ?? 0) + 1);
  };

  // Pinned first — always kept (they still occupy a type-cap / near-dup slot).
  for (const p of input.places) if (pinned.has(p.placeId)) bump(p);

  const isNearDuplicate = (p: PlaceDetail): boolean =>
    selected.some((s) => typeKey(s) === typeKey(p) && haversineMeters(s.location, p.location) < nearM);

  // Rank the rest by quality (desc), tie-break by id for determinism.
  const ranked = input.places
    .filter((p) => !pinned.has(p.placeId))
    .sort((a, b) => qualityScore(b) - qualityScore(a) || a.placeId.localeCompare(b.placeId));

  // Pass A: honour the per-type cap and drop near-duplicates outright.
  const deferred: PlaceDetail[] = [];
  for (const p of ranked) {
    if (selected.length >= input.targetCount) break;
    if (isNearDuplicate(p)) continue; // genuinely redundant — never add
    if ((typeCounts.get(typeKey(p)) ?? 0) >= perTypeCap) {
      deferred.push(p); // only capped out — eligible if we come up short
      continue;
    }
    bump(p);
  }

  // Pass B: still short → relax the cap (but keep near-dup suppression).
  for (const p of deferred) {
    if (selected.length >= input.targetCount) break;
    if (isNearDuplicate(p)) continue;
    bump(p);
  }

  const keep = new Set(selected.map((p) => p.placeId));
  return {
    selected: selected.map((p) => p.placeId),
    dropped: input.places.map((p) => p.placeId).filter((id) => !keep.has(id)),
    shortBy: Math.max(0, input.targetCount - selected.length),
  };
}
