/**
 * Goal evaluation — the QUALITY layer, distinct from validate() (feasibility).
 *
 * validate() answers "is this plan legal?" and BLOCKS finalize. evaluateGoal()
 * answers "is this plan GOOD?" — a graded, NEVER-blocking assessment that points
 * the agent at the highest-value improvement, so it pursues a rich trip instead of
 * merely a legal one. Without it the only strong signal is "no violations", whose
 * cheapest satisfier is dropping places — the plan shrinks toward empty. This is
 * the counter-force. Pure domain, no I/O.
 *
 * Top-level goal: a rich, well-paced, coherent trip that covers the must-sees and
 * the destination's variety, comfortably within each day's rhythm and budget.
 * Each dimension below is one facet of that goal.
 */

import type { Itinerary, PlaceDetail } from "./itinerary";
import { MEAL_SLOTS, paceDayEndCap, toMinutes } from "./timing";
import { summariseDays } from "./schedule";

export type GoalGap = "high" | "med" | "low";

export type GoalDimension =
  | "FULLNESS"
  | "BALANCE"
  | "COHERENCE"
  | "DIVERSITY"
  | "RATING"
  | "DAY_TRIP"
  | "MEALS";

export interface GoalFinding {
  dimension: GoalDimension;
  gap: GoalGap;
  /** Plain-language observation + the concrete move to close it. */
  message: string;
  dayIndex?: number;
}

export interface GoalResult {
  /** No high-gap findings → the trip is "good enough" to finalize. */
  satisfied: boolean;
  /** Ranked high→med→low, capped — the few most valuable improvements. */
  findings: GoalFinding[];
}

/** A day should run to within this of the pace cap, else it's under-used. */
const FULLNESS_SLACK = 180;
/** Travel per stop above this means the day zig-zags across town. */
const COHERENCE_TRAVEL_PER_STOP = 40;
/** One category owning ≥ this share of the trip is monotonous. */
const DIVERSITY_DOMINANCE = 0.6;
/** A skipped candidate must beat a used stop by this rating margin to suggest a swap. */
const RATING_EDGE = 0.4;
const RATING_FLOOR = 4.3;
const MAX_FINDINGS = 5;

const RESTAURANT = new Set(["restaurant", "cafe", "food"]);
const GAP_RANK: Record<GoalGap, number> = { high: 0, med: 1, low: 2 };

/** Has the agent already searched around this anchor and found no reachable stops?
 *  Tolerant match ("The Pinnacles Desert" ⇄ "Pinnacles Desert") since the anchor
 *  name and the `near=` query may differ by an article. */
function anchorExhausted(anchor: string, exhausted: ReadonlySet<string>): boolean {
  const a = anchor.trim().toLowerCase();
  for (const e of exhausted) {
    const x = e.trim().toLowerCase();
    if (x && (a === x || a.includes(x) || x.includes(a))) return true;
  }
  return false;
}

/**
 * @param exhaustedAnchors day-trip anchor names whose `near=` search came back
 *   empty — i.e. there are no companion stops to add. Their DAY_TRIP finding is
 *   demoted to `low` so it stops blocking finalize (a remote anchor with nothing
 *   around it is a legitimate single-stop day, not a fixable gap).
 */
export function evaluateGoal(
  itinerary: Itinerary,
  details: ReadonlyMap<string, PlaceDetail>,
  exhaustedAnchors: ReadonlySet<string> = new Set(),
): GoalResult {
  const { request } = itinerary;
  const summary = summariseDays(itinerary);
  const cap = toMinutes(paceDayEndCap(request.pace));
  const findings: GoalFinding[] = [];

  const scheduled = new Set<string>();
  for (const d of itinerary.days) {
    for (const it of d.items) if (it.kind === "visit" && it.placeId) scheduled.add(it.placeId);
  }
  const usedVisits = [...scheduled]
    .map((id) => details.get(id))
    .filter((x): x is PlaceDetail => x !== undefined);
  const unused = [...details.values()].filter(
    (p) => !scheduled.has(p.placeId) && !RESTAURANT.has(p.category),
  );
  const mustNames = new Set((request.mustVisit ?? []).map((m) => m.name));

  // A) FULLNESS — each non-day-trip day should be well-used.
  for (const d of summary.days) {
    if (d.dayTrip) continue;
    if (d.visits === 0) {
      findings.push({
        dimension: "FULLNESS", gap: "high", dayIndex: d.day,
        message: `day ${d.day} has no sightseeing — add places (candidates you skipped, or searchPlaces).`,
      });
    } else if (d.endsAtMinutes < cap - FULLNESS_SLACK) {
      findings.push({
        dimension: "FULLNESS", gap: unused.length > 0 ? "high" : "med", dayIndex: d.day,
        message: `day ${d.day} ends at ${d.endsAt} — under-used; add a nearby stop (a candidate you skipped, or searchPlaces near this day's area) or move one from a fuller day. Don't drop places to "fix" this.`,
      });
    }
  }

  // B) BALANCE — city days shouldn't be lopsided (day-trips are legitimately uneven).
  const cityDays = summary.days.filter((d) => !d.dayTrip && d.visits > 0);
  if (cityDays.length >= 2) {
    const full = cityDays.reduce((a, b) => (b.visits > a.visits ? b : a));
    const light = cityDays.reduce((a, b) => (b.visits < a.visits ? b : a));
    const spread = full.visits - light.visits;
    if (spread >= 3) {
      findings.push({
        dimension: "BALANCE", gap: spread >= 4 ? "high" : "med",
        message: `days are lopsided (day ${full.day} has ${full.visits} stops, day ${light.day} has ${light.visits}) — move a stop from day ${full.day} to day ${light.day}.`,
      });
    }
  }

  // C) COHERENCE — a day that hops across town wastes time in transit.
  for (const d of summary.days) {
    if (d.dayTrip || d.visits < 2) continue;
    if (d.travelMinutes / d.visits > COHERENCE_TRAVEL_PER_STOP) {
      findings.push({
        dimension: "COHERENCE", gap: "med", dayIndex: d.day,
        message: `day ${d.day} spends ${d.travelMinutes} min travelling across ${d.visits} stops — regroup so same-area places share a day.`,
      });
    }
  }

  // D) DIVERSITY — don't fill the trip with one category when others are available.
  if (usedVisits.length >= 4) {
    const byCat = new Map<string, number>();
    for (const v of usedVisits) byCat.set(v.category, (byCat.get(v.category) ?? 0) + 1);
    const top = [...byCat.entries()].sort((a, b) => b[1] - a[1])[0]!;
    if (top[1] / usedVisits.length >= DIVERSITY_DOMINANCE && unused.some((p) => p.category !== top[0])) {
      findings.push({
        dimension: "DIVERSITY", gap: "med",
        message: `the trip is mostly ${top[0]} (${top[1]}/${usedVisits.length}) — swap one for a different-theme candidate to vary it.`,
      });
    }
  }

  // E) RATING — a clearly better candidate is sitting unused while a weaker stop is in.
  const droppableUsed = usedVisits.filter((v) => !mustNames.has(v.name) && typeof v.rating === "number");
  const ratedUnused = unused.filter((p) => typeof p.rating === "number");
  if (droppableUsed.length > 0 && ratedUnused.length > 0) {
    const worst = droppableUsed.reduce((a, b) => ((a.rating ?? 0) <= (b.rating ?? 0) ? a : b));
    const best = ratedUnused.reduce((a, b) => ((a.rating ?? 0) >= (b.rating ?? 0) ? a : b));
    if ((best.rating ?? 0) - (worst.rating ?? 0) >= RATING_EDGE && (best.rating ?? 0) >= RATING_FLOOR) {
      findings.push({
        dimension: "RATING", gap: "low",
        message: `you used ${worst.name} (${worst.rating}) but skipped higher-rated ${best.name} (${best.rating}) — consider swapping.`,
      });
    }
  }

  // F) DAY_TRIP — a lone anchor isn't worth the drive; enrich it with a nearby stop.
  // Unless the agent already searched around it and found nothing (exhausted): then a
  // single-stop day is the best available, so demote to `low` and stop nagging.
  for (const d of summary.days) {
    if (!d.dayTrip || d.visits > 1) continue;
    const anchor = (d.places[0] ?? "the anchor").replace(" (must-visit)", "");
    if (anchorExhausted(anchor, exhaustedAnchors)) {
      findings.push({
        dimension: "DAY_TRIP", gap: "low", dayIndex: d.day,
        message: `day ${d.day}'s anchor (${anchor}) has no reachable nearby stops — keep it as a single-anchor day trip.`,
      });
    } else {
      findings.push({
        dimension: "DAY_TRIP", gap: "high", dayIndex: d.day,
        message: `day ${d.day} is a day-trip with a single stop (${anchor}) — a long drive for one place; add a nearby stop with searchPlaces near="${anchor}".`,
      });
    }
  }

  // G) MEALS — a day that runs through a mealtime should have a meal, in its window.
  const lunch = MEAL_SLOTS[0]!;
  for (const d of itinerary.days) {
    if (d.dayTrip) continue;
    const s = summary.days.find((x) => x.day === d.dayIndex);
    if (!s || s.visits === 0) continue;
    const meals = d.items.filter((i) => i.kind === "meal");
    if (s.endsAtMinutes >= toMinutes("13:00") && !meals.some((m) => m.mealWindow?.[0] === lunch.window[0])) {
      findings.push({
        dimension: "MEALS", gap: "med", dayIndex: d.dayIndex,
        message: `day ${d.dayIndex} runs through lunch but has no meal — add a restaurant on this day.`,
      });
    }
    for (const m of meals) {
      // Start-in-window (not full-fit): a meal that begins inside its window is fine
      // even if it runs a little past — only a genuinely misplaced meal is flagged.
      if (!m.mealWindow) continue;
      const start = toMinutes(m.startTime);
      if (start < toMinutes(m.mealWindow[0]) || start > toMinutes(m.mealWindow[1])) {
        findings.push({
          dimension: "MEALS", gap: "low", dayIndex: d.dayIndex,
          message: `${m.name} starts ${m.startTime}, outside its ${m.mealWindow[0]}–${m.mealWindow[1]} window.`,
        });
      }
    }
  }

  findings.sort((a, b) => GAP_RANK[a.gap] - GAP_RANK[b.gap]);
  const ranked = findings.slice(0, MAX_FINDINGS);
  return { satisfied: !ranked.some((f) => f.gap === "high"), findings: ranked };
}
