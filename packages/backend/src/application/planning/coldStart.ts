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
  Pace,
  Place,
  PlaceDetail,
  PlaceType,
  TripRequest,
  ValidationResult,
  Violation,
} from "../../domain/itinerary";
import { clusterByCost, haversineMeters } from "../../domain/clusterByDay";
import { selectPlaces } from "../../domain/selectPlaces";
import { paceDayEndCap, perDayVisitTarget, toMinutes } from "../../domain/timing";
import { scheduleItinerary, summariseDays } from "../../domain/schedule";
import { rebalanceForBudget } from "../../domain/rebalance";
import { resolveBudget, trimToBudget } from "../../domain/budget";
import { validate } from "../../domain/validate";
import { estimateCost } from "../../domain/estimateCost";
import { estimateTravelMinutes } from "../../domain/travel";
import { baseModel, escalationModel } from "./models";

export interface PlanningState {
  request: TripRequest;
  places: Map<string, Place>;
  /** Model-facing handle → real placeId. The agent never sees raw place ids. */
  refs: Map<string, string>;
  details: Map<string, PlaceDetail>;
  assignments: DayAssignment[] | null;
  draft: Itinerary | null;
  itinerary: Itinerary | null;
}

/** Coarse geometric estimate — used for day-balancing and as the matrix fallback. */
const legMinutes = (a: GeoLocation, b: GeoLocation): number => estimateTravelMinutes(a, b, "transit");

/** Accommodation (if geocoded) + the given places' coordinates, for a matrix. */
function placePoints(state: PlanningState, placeIds: string[]): GeoLocation[] {
  const points: GeoLocation[] = [];
  const acc = state.request.accommodation;
  if (typeof acc.lat === "number" && typeof acc.lng === "number") {
    points.push({ name: acc.name, lat: acc.lat, lng: acc.lng });
  }
  for (const id of placeIds) {
    const loc = state.details.get(id)?.location;
    if (loc) points.push(loc);
  }
  return points;
}

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

/**
 * A day that wraps up hours before its pace cap is half-empty (the classic
 * "ends at 11am" plan) — the mirror of DAY_TOO_TIGHT. Flag it so the agent fills
 * it (add places, or move one from a fuller day) instead of shipping a hollow day.
 * Reported only by planDays; finalize does NOT block on it, so the agent can
 * always ship a feasible plan when an area genuinely has no more to add.
 */
const DAY_LIGHT_SLACK_MINUTES = 180; // should run to within ~3h of the pace cap
function dayTooLightViolations(itinerary: Itinerary, pace?: Pace): Violation[] {
  const floor = toMinutes(paceDayEndCap(pace)) - DAY_LIGHT_SLACK_MINUTES;
  return summariseDays(itinerary)
    .days.filter((d) => d.visits > 0 && toMinutes(d.endsAt) < floor)
    .map((d) => ({
      code: "DAY_TOO_LIGHT",
      message: `day ${d.day} ends at ${d.endsAt} — too light. ADD more places to it (candidates you haven't used, or search that area) or MOVE one from a fuller day. Do not drop places to fix this.`,
      dayIndex: d.day,
      source: "constraint" as const,
    }));
}

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

const searchSchema = z.object({
  query: z.string(),
  type: z.enum(["attraction", "restaurant"]).optional(),
  maxResults: z.number().int().positive().optional(),
});
const detailsSchema = z.object({ ref: z.string() });
const costSchema = z.object({
  items: z.array(z.object({ label: z.string(), amount: z.number() })),
});
const assembleSchema = z.object({ respectWindows: z.boolean().optional() }).passthrough();
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
        "Places already surfaced are omitted; an empty result means nothing new for this query (search a different category).",
      inputSchema: searchSchema,
      async execute(input, state): Promise<ToolOutcome> {
        const { query, type, maxResults } = input as { query: string; type?: PlaceType; maxResults?: number };
        // Over-fetch relative to how many we'll keep: curation drops duplicates, so
        // searching only the keep-target would come up short and force a re-search.
        const keepTarget = Math.max(1, state.request.days) * perDayVisitTarget(state.request.pace);
        const effectiveMax = Math.max(maxResults ?? 0, 12, keepTarget * 2);
        const results = await provider.searchPlaces({
          query: `${query} in ${state.request.destination}`, // keep results in-region
          center: state.request.accommodation,
          maxResults: effectiveMax,
          ...(type ? { type } : {}),
        });
        // Skip places already surfaced (searched, detailed, or seeded) so a repeat
        // search returns only genuinely new candidates instead of re-listing dupes.
        const known = new Set<string>([...state.places.keys(), ...state.details.keys()]);
        const summaries = results
          .filter((p) => !known.has(p.placeId))
          .map((p) => {
            const ref = `r${state.refs.size + 1}`;
            state.refs.set(ref, p.placeId);
            state.places.set(p.placeId, p);
            return {
              ref,
              name: p.name,
              category: p.category,
              ...(typeof p.rating === "number" ? { rating: p.rating } : {}),
              ...(typeof p.priceLevel === "number" ? { priceLevel: p.priceLevel } : {}),
              ...(p.shortAddress ? { shortAddress: p.shortAddress } : {}),
            };
          });
        return { content: summaries };
      },
    },
    /**
     * in:  { ref: "r1" }
     * out: { ref: "r1", name: "…", category: "museum", openWindow?: ["09:00","17:00"], ticketPrice?: 600, rating?: 4.5 }
     */
    {
      name: "getPlaceDetails",
      description: "Fetch full details (coords, opening window, visit minutes, ticket price) for a place by its `ref` from searchPlaces.",
      inputSchema: detailsSchema,
      async execute(input, state): Promise<ToolOutcome> {
        const { ref } = input as { ref: string };
        const placeId = state.refs.get(ref) ?? ref; // refs map to ids; tolerate a real id too
        const detail = await provider.getPlaceDetails({ placeId });
        state.details.set(detail.placeId, detail);
        return {
          content: {
            ref,
            name: detail.name,
            category: detail.category,
            ...(detail.openWindow ? { openWindow: detail.openWindow } : {}),
            ...(typeof detail.ticketPrice === "number" ? { ticketPrice: detail.ticketPrice } : {}),
            ...(typeof detail.rating === "number" ? { rating: detail.rating } : {}),
          },
        };
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
     * out: { totalTravelMinutes: 95, days: [{ day, visits, travelMinutes, endsAt }, …], hardViolations: [...], softWarnings: [...] }
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
        const assignments: DayAssignment[] = built.map((b, i) => ({ dayIndex: i + 1, placeIds: b.attractions }));
        const mealsByDay = new Map<number, PlaceDetail[]>();
        built.forEach((b, i) => {
          if (b.restaurants.length > 0) mealsByDay.set(i + 1, b.restaurants);
        });
        ensureMustVisitsPlaced(assignments, state);
        state.assignments = assignments;
        const draft = scheduleItinerary({
          request: state.request,
          assignments,
          details: state.details,
          legMinutes: await buildLegMinutes(provider, placePoints(state, assignments.flatMap((a) => a.placeIds))),
          mustVisitIds: mustVisitIds(state.request),
          mealsByDay,
          options: { respectWindows: true },
        });
        state.draft = draft;
        const result = validate(draft, state.details);
        const hardViolations = [...result.hardViolations, ...dayTooLightViolations(draft, state.request.pace)];
        return {
          content: {
            ...summariseDays(draft),
            hardViolations,
            softWarnings: result.softWarnings,
            ...(hardViolations.length === 0 ? { note: "Valid — call finalizeItinerary." } : {}),
          },
          isError: hardViolations.length > 0,
        };
      },
    },
    /**
     * in:  {}    out: [{ dayIndex, placeIds: […] }, …]   (re-balanced; use for DAY_TOO_TIGHT)
     */
    {
      name: "rebalanceDays",
      description: "Re-balance the day assignments so no day exceeds its time budget. Use when finalize reports DAY_TOO_TIGHT.",
      inputSchema: noInput,
      execute(_input, state): ToolOutcome {
        if (!state.assignments) {
          return { content: { error: "no day assignments; call clusterByDay first" }, isError: true };
        }
        state.assignments = rebalanceForBudget({
          assignments: state.assignments,
          details: state.details,
          legMinutes,
          ...(state.request.pace ? { pace: state.request.pace } : {}),
        });
        return { content: state.assignments };
      },
    },
    /**
     * in:  {}    out: [{ dayIndex, placeIds: […] }, …]   (pricey non-must-visits dropped; use for BUDGET_EXCEEDED)
     */
    {
      name: "trimToBudget",
      description:
        "Drop the most-expensive non-must-visit places until the plan fits the budget. Use when finalize reports BUDGET_EXCEEDED.",
      inputSchema: noInput,
      execute(_input, state): ToolOutcome {
        if (!state.assignments) {
          return { content: { error: "no day assignments; call clusterByDay first" }, isError: true };
        }
        const band = resolveBudget(state.request);
        if (!band) {
          return { content: { error: "no budget set" }, isError: true };
        }
        state.assignments = trimToBudget({
          assignments: state.assignments,
          details: state.details,
          ceiling: band.maxTotal,
          pinnedIds: mustVisitIds(state.request),
        });
        return { content: state.assignments };
      },
    },
    /**
     * in:  { respectWindows?: true }
     * out: { days: 2, totalCost: 660 }    (the full draft is kept in state)
     */
    {
      name: "assembleItinerary",
      description:
        "Lay out a draft itinerary (visits, transit, meals) from the day assignments, honouring opening hours. Takes no arguments — it operates on the data you've gathered.",
      inputSchema: assembleSchema,
      async execute(input, state): Promise<ToolOutcome> {
        if (!state.assignments) {
          return { content: { error: "no day assignments; call clusterByDay first" }, isError: true };
        }
        const { respectWindows } = input as { respectWindows?: boolean };
        const draft = scheduleItinerary({
          request: state.request,
          assignments: state.assignments,
          details: state.details,
          legMinutes: await buildLegMinutes(provider, placePoints(state, state.assignments.flatMap((a) => a.placeIds))),
          mustVisitIds: mustVisitIds(state.request),
          ...(respectWindows !== undefined ? { options: { respectWindows } } : {}),
        });
        state.draft = draft;
        return { content: { days: draft.days.length, totalCost: draft.totalCost } };
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
          return { content: { error: "no draft; call assembleItinerary first" }, isError: true };
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
  "You are a travel-planning agent. Plan a trip by calling tools in this order:",
  "(1) searchPlaces to find candidate attractions — use DESCRIPTIVE queries ('top attractions', 'temples',",
  "'night market', 'park'), NOT just the city name; cast a wide net (maxResults ~12). Each result has a `ref`.",
  "You may also search 'restaurant' once for meal options — restaurants become meals, not sightseeing stops;",
  "(2) getPlaceDetails(ref) for the candidates, passing a `ref` from searchPlaces.",
  "Must-visits are already loaded in your data — do NOT search for or fetch them; they're pinned automatically;",
  "(3) planDays — YOU decide the day-by-day plan: group places into days by AREA and THEME. Put places in the",
  "same district / part of town together, keep a natural cluster on one day (e.g. the temple/lake area, or the",
  "harbour/old-town area), and don't split a themed zone across days. Aim to FILL both days (roughly balanced).",
  "Put ~1 restaurant on each day, on the day that actually runs through a mealtime. Submit { days: [{ day, refs }] }.",
  "(You may call clusterByDay first for a rough distance-based suggestion, then improve the grouping.)",
  "planDays returns each day's travel time + any violations. Fix by REGROUPING and calling planDays again —",
  "prefer MOVING or ADDING places over dropping them:",
  "CLOSED_HOURS → move that place to a day/slot where it's open (or drop it if it can't fit any day);",
  "DAY_TOO_TIGHT → move a place to the lighter day;",
  "DAY_TOO_LIGHT → the day is too empty: ADD more places to it (candidates you didn't use, or search that",
  "area) or move one from a fuller day — don't leave it half-empty. If that area truly has no more places, finalize anyway;",
  "(4) finalizeItinerary once planDays reports no hard violations. Stop when it succeeds.",
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
      assignments: null,
      draft: null,
      itinerary: null,
    },
    validate: validateState,
  };
}
