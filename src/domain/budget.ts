/**
 * Budget rules — a hard cost ceiling by budget level, and a trim skill that
 * drops the most-expensive non-pinned places until the plan fits. Pure.
 */

import type { BudgetLevel, DayAssignment, Itinerary, PlaceDetail } from "./itinerary";

/** Per-day spend ceiling (ticket/entry costs) by level, in JPY. */
const PER_DAY_CEILING: Readonly<Record<BudgetLevel, number>> = {
  economy: 6_000,
  moderate: 12_000,
  luxury: 25_000,
};

/** Total hard ceiling, or null when no budget level is set (no constraint). */
export function budgetCeiling(level: BudgetLevel | undefined, days: number): number | null {
  if (!level) return null;
  return PER_DAY_CEILING[level] * days;
}

export function itineraryCost(itinerary: Itinerary): number {
  return (
    itinerary.totalCost ??
    itinerary.days.reduce((s, d) => s + d.items.reduce((x, i) => x + (i.estimatedCost ?? 0), 0), 0)
  );
}

export interface TrimInput {
  assignments: DayAssignment[];
  details: ReadonlyMap<string, PlaceDetail>;
  ceiling: number;
  pinnedIds: ReadonlySet<string>;
}

/**
 * Remove the most-expensive non-pinned places until total cost ≤ ceiling.
 * Stops if only pinned places remain (then the plan is genuinely infeasible and
 * the Validator will still report BUDGET_EXCEEDED → graceful exit).
 */
export function trimToBudget(input: TrimInput): DayAssignment[] {
  const days = input.assignments.map((a) => ({ dayIndex: a.dayIndex, placeIds: [...a.placeIds] }));
  const cost = (id: string): number => input.details.get(id)?.ticketPrice ?? 0;
  const total = (): number =>
    days.reduce((s, d) => s + d.placeIds.reduce((x, id) => x + cost(id), 0), 0);

  while (total() > input.ceiling) {
    let bestDay = -1;
    let bestIdx = -1;
    let bestCost = -1;
    days.forEach((d, di) => {
      d.placeIds.forEach((id, ii) => {
        if (!input.pinnedIds.has(id) && cost(id) > bestCost) {
          bestCost = cost(id);
          bestDay = di;
          bestIdx = ii;
        }
      });
    });
    if (bestDay < 0) break; // only pinned places left — can't trim further
    days[bestDay]!.placeIds.splice(bestIdx, 1);
  }

  return days;
}
