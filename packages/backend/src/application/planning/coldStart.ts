/**
 * Cold-start planning use case: build the `AgentSpec` for planning a trip from
 * scratch. Tools wrap the `ToolProvider` (real data) + pure domain skills
 * (clusterByDay, scheduleItinerary, rebalanceForBudget, validate, estimateCost)
 * and accumulate into a shared planning state. Hard-constraint validation lives
 * in `validate`; the finalizeItinerary tool is the success exit. When finalize
 * reports violations the agent re-plans (respect windows / rebalance) and retries.
 */

import { z } from "zod";

import type { AgentSpec, ToolDef, ToolOutcome } from "../agent/AgentSpec";
import type { ToolProvider } from "../ports/ToolProvider";
import type {
  DayAssignment,
  GeoLocation,
  Itinerary,
  Place,
  PlaceDetail,
  PlaceType,
  TripRequest,
  ValidationResult,
} from "../../domain/itinerary";
import { carveDayTrips, clusterByCost, haversineMeters } from "../../domain/clusterByDay";
import { selectPlaces } from "../../domain/selectPlaces";
import { perDayVisitTarget } from "../../domain/timing";
import { scheduleItinerary, summariseDays } from "../../domain/schedule";
import { validate } from "../../domain/validate";
import { evaluateGoal } from "../../domain/evaluateGoal";
import { estimateCost } from "../../domain/estimateCost";
import { estimateTravelMinutes } from "../../domain/travel";
import { baseModel, escalationModel } from "./models";

export interface PlanningState {
  request: TripRequest;
  places: Map<string, Place>;
  /** Model-facing handle → real placeId. The agent never sees raw place ids. */
  refs: Map<string, string>;
  details: Map<string, PlaceDetail>;
  /** `near=` areas whose search returned nothing new — a day-trip anchor here has
   *  no reachable companions, so the goal layer stops demanding one (see evaluateGoal). */
  nearExhausted: Set<string>;
  assignments: DayAssignment[] | null;
  draft: Itinerary | null;
  itinerary: Itinerary | null;
}

/** Coarse geometric estimate — used for day-balancing and as the matrix fallback. */
const legMinutes = (a: GeoLocation, b: GeoLocation): number => estimateTravelMinutes(a, b, "transit");

/** The accommodation as a GeoLocation, or null when it isn't geocoded. */
function accommodationGeo(state: PlanningState): GeoLocation | null {
  const acc = state.request.accommodation;
  return typeof acc.lat === "number" && typeof acc.lng === "number"
    ? { name: acc.name, lat: acc.lat, lng: acc.lng }
    : null;
}

/** Accommodation (if geocoded) + the given places' coordinates, for a matrix. */
function placePoints(state: PlanningState, placeIds: string[]): GeoLocation[] {
  const points: GeoLocation[] = [];
  const center = accommodationGeo(state);
  if (center) points.push(center);
  for (const id of placeIds) {
    const loc = state.details.get(id)?.location;
    if (loc) points.push(loc);
  }
  return points;
}

/** A far must-visit past this real driving time from the accommodation is treated
 *  as a day-trip anchor: it gets its own day, exempt from the day-end / light-day caps. */
const DAY_TRIP_MINUTES = 60;

/**
 * Build a leg-cost function backed by the provider's real travel-time matrix
 * (one call over `points`), so ordering, timing, and clustering use real road
 * distances. Falls back to the geometric estimate when there's no matrix
 * capability or the call fails.
 */
async function buildLegMinutes(
  provider: ToolProvider,
  points: GeoLocation[],
): Promise<(a: GeoLocation, b: GeoLocation) => number> {
  if (!provider.getTravelMatrix || points.length < 2) return legMinutes;
  let matrix: number[][];
  try {
    matrix = await provider.getTravelMatrix({ points, mode: "driving" });
  } catch {
    return legMinutes; // matrix unavailable → geometric estimate
  }
  const key = (p: { lat: number; lng: number }): string => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
  const index = new Map(points.map((p, i) => [key(p), i] as const));
  return (a, b) => {
    const i = index.get(key(a));
    const j = index.get(key(b));
    if (i === undefined || j === undefined) return legMinutes(a, b);
    return matrix[i]?.[j] ?? legMinutes(a, b);
  };
}

function mustVisitIds(request: TripRequest): Set<string> {
  return new Set(
    (request.mustVisit ?? [])
      .map((m) => m.placeId)
      .filter((id): id is string => typeof id === "string"),
  );
}

/** Eateries are scheduled into meal slots, never as sightseeing visits. */
const RESTAURANT_CATEGORIES = new Set(["restaurant", "cafe", "food"]);
const isRestaurant = (detail: PlaceDetail): boolean => RESTAURANT_CATEGORIES.has(detail.category);

function centroidOf(placeIds: string[], details: Map<string, PlaceDetail>): GeoLocation | null {
  const locs = placeIds.map((id) => details.get(id)?.location).filter((l): l is GeoLocation => !!l);
  if (locs.length === 0) return null;
  return {
    name: "centroid",
    lat: locs.reduce((s, l) => s + l.lat, 0) / locs.length,
    lng: locs.reduce((s, l) => s + l.lng, 0) / locs.length,
  };
}

/** Guarantee every must-visit lands on a day — drop it into the nearest cluster if
 *  the agent's day plan left it out (the agent groups attractions; code pins these). */
function ensureMustVisitsPlaced(assignments: DayAssignment[], state: PlanningState): void {
  const placed = new Set(assignments.flatMap((a) => a.placeIds));
  for (const id of mustVisitIds(state.request)) {
    if (placed.has(id)) continue;
    const detail = state.details.get(id);
    if (!detail) continue;
    let best = assignments[0]!;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const a of assignments) {
      const c = centroidOf(a.placeIds, state.details);
      const d = c ? haversineMeters(c, detail.location) : Number.POSITIVE_INFINITY;
      if (d < bestDist) {
        bestDist = d;
        best = a;
      }
    }
    best.placeIds.push(id);
    placed.add(id);
  }
}

/** After day-trips are carved out, re-home the agent's restaurants onto the nearest
 *  CITY day (a day-trip day gets a generic meal block near its anchor instead). */
function mealsByNearestCityDay(
  restaurants: PlaceDetail[],
  assignments: DayAssignment[],
  dayTripDays: ReadonlySet<number>,
  details: Map<string, PlaceDetail>,
  legFn: (a: GeoLocation, b: GeoLocation) => number,
): Map<number, PlaceDetail[]> {
  const cityDays = assignments.filter((a) => !dayTripDays.has(a.dayIndex));
  const meals = new Map<number, PlaceDetail[]>();
  if (cityDays.length === 0) return meals;
  for (const r of restaurants) {
    let bestDay = cityDays[0]!.dayIndex;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const d of cityDays) {
      const c = centroidOf(d.placeIds, details);
      const cost = c ? legFn(r.location, c) : 0;
      if (cost < bestCost) {
        bestCost = cost;
        bestDay = d.dayIndex;
      }
    }
    const list = meals.get(bestDay);
    if (list) list.push(r);
    else meals.set(bestDay, [r]);
  }
  return meals;
}

/** Validate the best itinerary we have (with details for opening-hours checks). */
function validateState(state: PlanningState): ValidationResult {
  const itinerary = state.itinerary ?? state.draft;
  if (!itinerary) {
    return {
      hardViolations: [
        { code: "INCOMPLETE", message: "no itinerary produced", source: "constraint" },
      ],
      softWarnings: [],
    };
  }
  return validate(itinerary, state.details);
}

const searchSchema = z
  .object({
    // One query, or many in a single call (`queries`) — batch several categories at
    // once (e.g. ["temples", "night market", "park"]) instead of a call each.
    query: z.string().optional(),
    queries: z.array(z.string()).optional(),
    type: z.enum(["attraction", "restaurant"]).optional(),
    maxResults: z.number().int().positive().optional(),
    /** Center the search on this place/area instead of the accommodation (e.g. a
     *  far must-visit's name) — for filling a day-trip day with nearby stops. */
    near: z.string().optional(),
  })
  .refine((v) => Boolean(v.query) || (v.queries?.length ?? 0) > 0, {
    message: "provide `query` or a non-empty `queries`",
  });

/** Search radius when `near` re-centers away from the accommodation (a day-trip area). */
const NEAR_RADIUS_M = 40_000;
// One ref, or many in a single call (`refs`) — detail all your candidates at once.
const detailsSchema = z
  .object({ ref: z.string().optional(), refs: z.array(z.string()).optional() })
  .refine((v) => Boolean(v.ref) || (v.refs?.length ?? 0) > 0, {
    message: "provide `ref` or a non-empty `refs`",
  });
const costSchema = z.object({
  items: z.array(z.object({ label: z.string(), amount: z.number() })),
});
const planDaysSchema = z
  .object({
    // Any integer day label — days are re-indexed 1..n by order, so 0-based is fine too.
    days: z.array(z.object({ day: z.number().int(), refs: z.array(z.string()) })),
  })
  .passthrough();
const noInput = z.object({}).passthrough();

function buildTools(provider: ToolProvider): ToolDef<PlanningState>[] {
  return [
    /**
     * in:  { query: "museums", type?: "attraction", maxResults?: 10 }
     * out: [{ ref: "r1", name: "Tokyo National Museum", category: "museum", rating?: 4.5, priceLevel?: 2, shortAddress?: "…" }, …]
     * Places you've already seen are omitted, so an empty result means "nothing new for this query — try a different category".
     */
    {
      name: "searchPlaces",
      description:
        "Search for candidate places near the accommodation. Each result has a short `ref` — pass it to getPlaceDetails. " +
        "Pass `queries: [...]` to run several category searches in ONE call (e.g. ['temples','night market','park']) instead of a call each. " +
        "Places already surfaced are omitted; an empty result means nothing new for those queries (search a different category). " +
        "Pass `near` (a place/area name, e.g. a far must-visit's name) to search around THAT area instead of the accommodation — use it to add nearby stops to a day-trip day.",
      inputSchema: searchSchema,
      async execute(input, state): Promise<ToolOutcome> {
        const { query, queries, type, maxResults, near } = input as {
          query?: string;
          queries?: string[];
          type?: PlaceType;
          maxResults?: number;
          near?: string;
        };
        const queryList = (queries?.length ? queries : query ? [query] : []).filter((q) => q.trim());
        // Over-fetch relative to how many we'll keep: curation drops duplicates, so
        // searching only the keep-target would come up short and force a re-search.
        const keepTarget = Math.max(1, state.request.days) * perDayVisitTarget(state.request.pace);
        const effectiveMax = Math.max(maxResults ?? 0, 12, keepTarget * 2);
        // `near` re-centers the search on a geocoded area (a day-trip destination),
        // with a wide radius; falls back to the accommodation if it can't be located.
        let center = state.request.accommodation;
        let radius: number | undefined;
        if (near) {
          const geo = await provider.geocode({ query: `${near} ${state.request.destination}` });
          if (geo) {
            center = { name: near, lat: geo.lat, lng: geo.lng };
            radius = NEAR_RADIUS_M;
          }
        }
        // Skip places already surfaced (searched, detailed, or seeded) so a repeat
        // search returns only genuinely new candidates — and de-dupe across the batch,
        // so overlapping queries don't surface the same place twice.
        const known = new Set<string>([...state.places.keys(), ...state.details.keys()]);
        const summaries: Array<Record<string, unknown>> = [];
        // Sequential (not parallel): each new ref is `r${refs.size+1}`, so ref
        // assignment must see the prior query's additions to stay unique.
        for (const q of queryList) {
          const results = await provider.searchPlaces({
            query: `${q} in ${state.request.destination}`, // keep results in-region
            center,
            maxResults: effectiveMax,
            ...(radius !== undefined ? { radius } : {}),
            ...(type ? { type } : {}),
          });
          for (const p of results) {
            if (known.has(p.placeId)) continue;
            known.add(p.placeId);
            const ref = `r${state.refs.size + 1}`;
            state.refs.set(ref, p.placeId);
            state.places.set(p.placeId, p);
            summaries.push({
              ref,
              name: p.name,
              category: p.category,
              ...(typeof p.rating === "number" ? { rating: p.rating } : {}),
              ...(typeof p.priceLevel === "number" ? { priceLevel: p.priceLevel } : {}),
              ...(p.shortAddress ? { shortAddress: p.shortAddress } : {}),
            });
          }
        }
        // Remember a `near` area that yielded nothing new: its day-trip anchor has no
        // reachable companions, so the goal layer should stop demanding one. A later
        // productive search of the same area clears it.
        if (near) {
          if (summaries.length === 0) state.nearExhausted.add(near);
          else state.nearExhausted.delete(near);
        }
        return { content: summaries };
      },
    },
    /**
     * in:  { ref: "r1" }
     * out: { ref: "r1", name: "…", category: "museum", openWindow?: ["09:00","17:00"], ticketPrice?: 600, rating?: 4.5 }
     */
    {
      name: "getPlaceDetails",
      description:
        "Fetch full details (coords, opening window, visit minutes, ticket price) for places from searchPlaces. " +
        "Pass `refs: [...]` to detail MANY at once in a single call (preferred — do all your candidates together) or `ref` for one.",
      inputSchema: detailsSchema,
      async execute(input, state): Promise<ToolOutcome> {
        const { ref, refs } = input as { ref?: string; refs?: string[] };
        const list = refs?.length ? refs : ref ? [ref] : [];
        const rows = await Promise.all(
          list.map(async (r) => {
            const placeId = state.refs.get(r) ?? r; // refs map to ids; tolerate a real id too
            try {
              const detail = await provider.getPlaceDetails({ placeId });
              state.details.set(detail.placeId, detail);
              return {
                ref: r,
                name: detail.name,
                category: detail.category,
                ...(detail.openWindow ? { openWindow: detail.openWindow } : {}),
                ...(typeof detail.ticketPrice === "number" ? { ticketPrice: detail.ticketPrice } : {}),
                ...(typeof detail.rating === "number" ? { rating: detail.rating } : {}),
              };
            } catch (e) {
              // One bad ref shouldn't sink the whole batch — report it inline.
              return { ref: r, error: e instanceof Error ? e.message : "lookup failed" };
            }
          }),
        );
        // Single-ref call keeps the single-object shape (back-compat); a batch returns an array.
        return { content: refs?.length ? rows : rows[0] };
      },
    },
    /**
     * in:  { items: [{ label: "tickets", amount: 600 }, { label: "lunch", amount: 300 }] }
     * out: { total: 900, breakdown: [{ label: "tickets", amount: 600 }, …] }
     */
    {
      name: "estimateCost",
      description: "Sum a list of cost items.",
      inputSchema: costSchema,
      execute(input): ToolOutcome {
        const { items } = input as { items: { label: string; amount: number }[] };
        return { content: estimateCost(items) };
      },
    },
    /**
     * in:  {}
     * out: { days: [{ day: 1, places: [{ ref: "r1", name: "…" }, …] }, …], selected: 8, target: 10, note?: "…" }
     * A distance-based *suggestion* — curates a diverse subset and splits it by proximity.
     * Refine it (group by area/theme) and submit your final grouping with planDays.
     */
    {
      name: "clusterByDay",
      description:
        "Suggest a day-by-day grouping (curated, diverse, split by REAL travel distance) as a starting point. Returns days of {ref,name} — refine the grouping by area/theme and submit it with planDays. A `note` means the plan is thin (search more first).",
      inputSchema: noInput,
      async execute(_input, state): Promise<ToolOutcome> {
        const target = Math.max(1, state.request.days) * perDayVisitTarget(state.request.pace);
        const selection = selectPlaces({
          places: [...state.details.values()].filter((d) => !isRestaurant(d)), // restaurants → meals
          targetCount: target,
          pinnedIds: mustVisitIds(state.request),
        });
        const selected = selection.selected;
        const loc = (id: string): GeoLocation => state.details.get(id)!.location;
        // Cluster on real road travel time (island-aware), not straight-line distance.
        const legFn = await buildLegMinutes(provider, placePoints(state, selected));
        const acc = state.request.accommodation;
        const center =
          typeof acc.lat === "number" && typeof acc.lng === "number"
            ? { name: acc.name, lat: acc.lat, lng: acc.lng }
            : undefined;
        const assignments = clusterByCost({
          ids: selected,
          days: state.request.days,
          cost: (a, b) => legFn(loc(a), loc(b)),
          ...(center ? { centerCost: (id) => legFn(center, loc(id)) } : {}),
        });
        state.assignments = assignments;
        // Return refs + names, never raw place ids (the agent works in refs).
        const refOf = new Map<string, string>();
        for (const [ref, id] of state.refs) if (!refOf.has(id)) refOf.set(id, ref);
        const dayGroups = assignments.map((a) => ({
          day: a.dayIndex,
          places: a.placeIds.map((id) => {
            const name = state.details.get(id)?.name ?? "";
            const ref = refOf.get(id);
            return ref ? { ref, name } : { name };
          }),
        }));
        const content: Record<string, unknown> = { days: dayGroups, selected: selected.length, target };
        if (selection.shortBy > 0) {
          content.note =
            `Only ${selected.length} of ~${target} places — the plan is thin. Search another category, ` +
            `getPlaceDetails the new candidates, then try again.`;
        }
        return { content };
      },
    },
    /**
     * in:  { days: [{ day: 1, refs: ["r5","r2"] }, { day: 2, refs: ["r6"] }] }
     * out: { totalTravelMinutes: 95, days: [{ day, visits, travelMinutes, endsAt }, …], hardViolations: [...], goal: { satisfied, findings } }
     * You choose the day grouping; code orders each day for shortest travel, times it, and validates.
     */
    {
      name: "planDays",
      description:
        "Group the detailed places into days yourself: put same-area / same-theme places on one day (refs from searchPlaces). " +
        "Restaurants/cafés you include become that day's meals (not sightseeing stops). " +
        "Code orders each day for shortest real travel, times it, and returns per-day travel + any violations to fix by regrouping. " +
        "Must-visits are pinned automatically if omitted.",
      inputSchema: planDaysSchema,
      async execute(input, state): Promise<ToolOutcome> {
        const { days } = input as { days: { day: number; refs: string[] }[] };
        // The agent may hand a ref it never detailed (e.g. a restaurant it only
        // searched) — fetch details on demand so nothing is silently dropped.
        for (const id of new Set(days.flatMap((d) => d.refs).map((r) => state.refs.get(r) ?? r))) {
          if (state.details.has(id)) continue;
          try {
            const detail = await provider.getPlaceDetails({ placeId: id });
            state.details.set(detail.placeId, detail);
          } catch {
            /* unknown ref — skip it */
          }
        }
        // Split each day into sightseeing visits and eateries (which become meals).
        const built = days
          .slice()
          .sort((a, b) => a.day - b.day)
          .map((d) => {
            const details = d.refs
              .map((r) => state.details.get(state.refs.get(r) ?? r))
              .filter((x): x is PlaceDetail => x !== undefined);
            return {
              attractions: details.filter((x) => !isRestaurant(x)).map((x) => x.placeId),
              restaurants: details.filter(isRestaurant),
            };
          })
          .filter((b) => b.attractions.length > 0 || b.restaurants.length > 0);
        if (built.length === 0) {
          return { content: { error: "no valid places in your plan; use refs you've detailed" }, isError: true };
        }
        let assignments: DayAssignment[] = built.map((b, i) => ({ dayIndex: i + 1, placeIds: b.attractions }));
        let mealsByDay = new Map<number, PlaceDetail[]>();
        built.forEach((b, i) => {
          if (b.restaurants.length > 0) mealsByDay.set(i + 1, b.restaurants);
        });
        ensureMustVisitsPlaced(assignments, state);

        // Real-travel leg costs over every attraction (+ accommodation) — one matrix
        // call, reused for day-trip carving, ordering, and timing.
        const legFn = await buildLegMinutes(provider, placePoints(state, assignments.flatMap((a) => a.placeIds)));
        const loc = (id: string): GeoLocation | undefined => state.details.get(id)?.location;

        // A far must-visit is invisible to the agent (auto-pinned), so code carves it
        // onto its own day-trip day rather than let it wreck a city day's timing.
        let dayTripDays: ReadonlySet<number> = new Set<number>();
        const center = accommodationGeo(state);
        if (center) {
          const cost = (a: string, b: string): number => {
            const la = loc(a);
            const lb = loc(b);
            return la && lb ? legFn(la, lb) : 0;
          };
          const centerCost = (id: string): number => {
            const l = loc(id);
            return l ? legFn(center, l) : 0;
          };
          const anchorIds = [...mustVisitIds(state.request)].filter(
            (id) => state.details.has(id) && centerCost(id) > DAY_TRIP_MINUTES,
          );
          const carved = carveDayTrips({
            attractionIds: assignments.flatMap((a) => a.placeIds),
            anchorIds,
            days: state.request.days,
            cost,
            centerCost,
          });
          if (carved) {
            assignments = carved.assignments;
            dayTripDays = new Set(carved.dayTripDays);
            mealsByDay = mealsByNearestCityDay(
              built.flatMap((b) => b.restaurants),
              assignments,
              dayTripDays,
              state.details,
              legFn,
            );
          }
        }

        state.assignments = assignments;
        const draft = scheduleItinerary({
          request: state.request,
          assignments,
          details: state.details,
          legMinutes: legFn,
          mustVisitIds: mustVisitIds(state.request),
          mealsByDay,
          dayTripDays,
          options: { respectWindows: true },
        });
        state.draft = draft;
        const result = validate(draft, state.details);
        const hardViolations = result.hardViolations;
        // Feasibility (hardViolations) blocks; the goal assessment never does — it
        // tells the agent how to make a legal plan actually GOOD, so it doesn't just
        // drop places to silence violations.
        const goal = evaluateGoal(draft, state.details, state.nearExhausted);
        const note =
          hardViolations.length > 0
            ? undefined
            : goal.satisfied
              ? "No hard violations and goals met — call finalizeItinerary."
              : "No hard violations, but the plan isn't done yet — close the goal findings (add / move / enrich), then finalize.";
        return {
          content: {
            ...summariseDays(draft),
            hardViolations,
            goal,
            ...(note ? { note } : {}),
          },
          isError: hardViolations.length > 0,
        };
      },
    },
    /**
     * in:  {}
     * out (ok):    { ok: true, totalCost: 660, softWarnings: [{ code: "MEAL_OUT_OF_WINDOW", … }] }   (final)
     * out (retry): { hardViolations: [{ code: "DAY_TOO_TIGHT", message: "…" }] }                    (isError)
     */
    {
      name: "finalizeItinerary",
      description: "Validate the draft and finalize. Returns hard violations to fix, or finalizes on success.",
      inputSchema: noInput,
      execute(_input, state): ToolOutcome {
        const draft = state.draft;
        if (!draft) {
          return { content: { error: "no draft; call planDays first" }, isError: true };
        }
        const result = validate(draft, state.details);
        // finalize enforces only true feasibility (windows, day cap, flight, budget) —
        // NOT DAY_TOO_LIGHT — so the agent can always ship a valid plan.
        if (result.hardViolations.length > 0) {
          return { content: { hardViolations: result.hardViolations }, isError: true };
        }
        state.itinerary = draft;
        return {
          content: { ok: true, totalCost: draft.totalCost, softWarnings: result.softWarnings },
          final: true,
        };
      },
    },
  ];
}

const INSTRUCTION = [
  "You are a travel-planning agent. Your GOAL is a genuinely good trip: each day comfortably full and well-paced,",
  "places grouped by area/theme, the must-sees covered, a variety of experiences, and any day-trip worth the drive.",
  "The hard violations are RED LINES you must not cross — they are NOT the goal. Prefer MOVE, REGROUP, or ADD. But when",
  "a day is OVER-FULL (DAY_TOO_TIGHT) and no other day can absorb the stop, DO drop the lowest-value NON-must-visit from",
  "that day — that's how an over-stuffed plan converges (must-visits are pinned and can NEVER be dropped). Never drop to",
  "fix a thin / under-used day — that's backwards; add there instead.",
  "Work in this order:",
  "(1) searchPlaces to find candidates — use DESCRIPTIVE queries ('top attractions', 'temples', 'night market',",
  "'park'), NOT just the city name; batch several categories in ONE call via `queries: [...]`. Cast a wide net",
  "(maxResults ~12). Each result has a `ref`. Search 'restaurant' once for meal options — restaurants become meals,",
  "not sightseeing stops;",
  "(2) getPlaceDetails for the candidates — pass `refs: [...]` to detail them ALL in one call, not one at a time.",
  "Must-visits are already loaded — do NOT search/fetch them; pinned automatically;",
  "(3) planDays — YOU decide the day-by-day plan: same-district / same-theme places on one day; don't split a themed",
  "zone; put ~1 restaurant on the day that runs through a mealtime. Submit { days: [{ day, refs }] }.",
  "A day-trip day holds a far must-visit on its own day; its long commute is EXPECTED (don't shrink its travel time).",
  "planDays returns two separate things:",
  "• hardViolations — RED LINES, block finalize. Fix by moving/regrouping: CLOSED_HOURS → move that place to a day/slot",
  "where it's open (or, only if it fits nowhere, drop it); DAY_TOO_TIGHT → move a stop to a lighter day, or if every",
  "other day is also full, drop the lowest-value non-must-visit from the over-long day; BUDGET_EXCEEDED → drop the",
  "priciest NON-must-visit and re-plan.",
  "• goal = { satisfied, findings } — how to make a legal plan actually GOOD. Each finding has a `gap` (high/med/low)",
  "and a concrete move. Close the high-gap ones by dimension: FULLNESS/BALANCE → add a candidate you skipped, or move",
  "one from a fuller day (if a day's area is tapped out, searchPlaces for more there); DAY_TRIP → searchPlaces",
  "near=<the anchor's name>, getPlaceDetails, include them (code keeps them on the day-trip day); MEALS → add a",
  "restaurant on that day; DIVERSITY/RATING → swap a stop for an unused different-theme / higher-rated candidate;",
  "COHERENCE → regroup so same-area places share a day. Re-run planDays after each change.",
  "(4) finalizeItinerary ONLY when hardViolations is empty AND goal.satisfied is true (no high-gap findings). Remaining",
  "med/low findings are optional polish — finalize if they're not worth another change, or a day's area truly has no",
  "more to add. Stop when finalize succeeds.",
].join(" ");

export interface ColdStartSeed {
  /** Pre-resolved place details (e.g. must-visits from resolveMustVisits). */
  details?: Map<string, PlaceDetail>;
  /** Pre-discovered candidate summaries (e.g. companions near a far must-visit). */
  places?: Map<string, Place>;
}

export function createColdStartSpec(
  request: TripRequest,
  provider: ToolProvider,
  seed?: ColdStartSeed,
): AgentSpec<PlanningState> {
  // Don't show raw place ids in the prompt — must-visits appear by name only
  // (they're pre-loaded into details), so the model never handles an opaque id.
  const display = { ...request, mustVisit: (request.mustVisit ?? []).map((m) => ({ name: m.name })) };
  const escalation = escalationModel();
  return {
    instruction: INSTRUCTION,
    kickoff: `Plan this trip:\n${JSON.stringify(display, null, 2)}`,
    model: baseModel(),
    ...(escalation ? { escalationModel: escalation } : {}),
    constraints: { maxIterations: 25, maxTokens: 150_000, runtimeMs: 60_000 },
    tools: buildTools(provider),
    initialState: {
      request,
      places: seed?.places ?? new Map(),
      refs: new Map(),
      details: seed?.details ?? new Map(),
      nearExhausted: new Set(),
      assignments: null,
      draft: null,
      itinerary: null,
    },
    validate: validateState,
  };
}
