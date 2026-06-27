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
  TravelMode,
  TripRequest,
  ValidationResult,
} from "../../domain/itinerary";
import { clusterByDay, type ClusterPlace } from "../../domain/clusterByDay";
import { scheduleItinerary } from "../../domain/schedule";
import { rebalanceForBudget } from "../../domain/rebalance";
import { budgetCeiling, trimToBudget } from "../../domain/budget";
import { validate } from "../../domain/validate";
import { estimateCost } from "../../domain/estimateCost";
import { estimateTravelMinutes } from "../../domain/travel";

export interface PlanningState {
  request: TripRequest;
  places: Map<string, Place>;
  details: Map<string, PlaceDetail>;
  assignments: DayAssignment[] | null;
  draft: Itinerary | null;
  itinerary: Itinerary | null;
}

const legMinutes = (a: GeoLocation, b: GeoLocation): number => estimateTravelMinutes(a, b, "transit");

function mustVisitIds(request: TripRequest): Set<string> {
  return new Set(
    (request.mustVisit ?? [])
      .map((m) => m.placeId)
      .filter((id): id is string => typeof id === "string"),
  );
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
const detailsSchema = z.object({ placeId: z.string() });
const travelSchema = z.object({
  fromPlaceId: z.string(),
  toPlaceId: z.string(),
  mode: z.enum(["transit", "walking", "driving"]).optional(),
});
const costSchema = z.object({
  items: z.array(z.object({ label: z.string(), amount: z.number() })),
});
const assembleSchema = z.object({ respectWindows: z.boolean().optional() }).passthrough();
const noInput = z.object({}).passthrough();

function buildTools(provider: ToolProvider): ToolDef<PlanningState>[] {
  return [
    {
      name: "searchPlaces",
      description: "Search for candidate places near the accommodation. Returns lightweight summaries.",
      inputSchema: searchSchema,
      async execute(input, state): Promise<ToolOutcome> {
        const { query, type, maxResults } = input as { query: string; type?: PlaceType; maxResults?: number };
        const results = await provider.searchPlaces({
          query,
          center: state.request.accommodation,
          ...(type ? { type } : {}),
          ...(maxResults ? { maxResults } : {}),
        });
        for (const p of results) state.places.set(p.placeId, p);
        return { content: results };
      },
    },
    {
      name: "getPlaceDetails",
      description: "Fetch full details (coords, opening window, visit minutes, ticket price) for a place.",
      inputSchema: detailsSchema,
      async execute(input, state): Promise<ToolOutcome> {
        const { placeId } = input as { placeId: string };
        const detail = await provider.getPlaceDetails({ placeId });
        state.details.set(detail.placeId, detail);
        return { content: detail };
      },
    },
    {
      name: "getTravelTime",
      description: "Travel time between two already-detailed places.",
      inputSchema: travelSchema,
      async execute(input, state): Promise<ToolOutcome> {
        const { fromPlaceId, toPlaceId, mode } = input as {
          fromPlaceId: string;
          toPlaceId: string;
          mode?: TravelMode;
        };
        const from = state.details.get(fromPlaceId);
        const to = state.details.get(toPlaceId);
        if (!from || !to) {
          return { content: { error: "unknown place id; fetch details first" }, isError: true };
        }
        const travel = await provider.getTravelTime({
          origin: from.location,
          destination: to.location,
          ...(mode ? { mode } : {}),
        });
        return { content: travel };
      },
    },
    {
      name: "estimateCost",
      description: "Sum a list of cost items.",
      inputSchema: costSchema,
      execute(input): ToolOutcome {
        const { items } = input as { items: { label: string; amount: number }[] };
        return { content: estimateCost(items) };
      },
    },
    {
      name: "clusterByDay",
      description: "Cluster all detailed places across the requested number of days (coordinate distance only).",
      inputSchema: noInput,
      execute(_input, state): ToolOutcome {
        const places: ClusterPlace[] = [...state.details.values()].map((d) => ({
          placeId: d.placeId,
          lat: d.location.lat,
          lng: d.location.lng,
        }));
        const acc = state.request.accommodation;
        const center =
          typeof acc.lat === "number" && typeof acc.lng === "number"
            ? { name: acc.name, lat: acc.lat, lng: acc.lng }
            : undefined;
        const assignments = clusterByDay({
          places,
          days: state.request.days,
          ...(center ? { center } : {}),
        });
        state.assignments = assignments;
        return { content: assignments };
      },
    },
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
    {
      name: "trimToBudget",
      description:
        "Drop the most-expensive non-must-visit places until the plan fits the budget. Use when finalize reports BUDGET_EXCEEDED.",
      inputSchema: noInput,
      execute(_input, state): ToolOutcome {
        if (!state.assignments) {
          return { content: { error: "no day assignments; call clusterByDay first" }, isError: true };
        }
        const ceiling = budgetCeiling(state.request.budgetLevel, state.request.days);
        if (ceiling === null) {
          return { content: { error: "no budget level set" }, isError: true };
        }
        state.assignments = trimToBudget({
          assignments: state.assignments,
          details: state.details,
          ceiling,
          pinnedIds: mustVisitIds(state.request),
        });
        return { content: state.assignments };
      },
    },
    {
      name: "assembleItinerary",
      description:
        "Lay out a draft itinerary (visits, transit, meals) from the day assignments, honouring opening hours.",
      inputSchema: assembleSchema,
      execute(input, state): ToolOutcome {
        if (!state.assignments) {
          return { content: { error: "no day assignments; call clusterByDay first" }, isError: true };
        }
        const { respectWindows } = input as { respectWindows?: boolean };
        const draft = scheduleItinerary({
          request: state.request,
          assignments: state.assignments,
          details: state.details,
          legMinutes,
          mustVisitIds: mustVisitIds(state.request),
          ...(respectWindows !== undefined ? { options: { respectWindows } } : {}),
        });
        state.draft = draft;
        return { content: { days: draft.days.length, totalCost: draft.totalCost } };
      },
    },
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
  "(1) searchPlaces to find candidate attractions near the accommodation;",
  "(2) getPlaceDetails for the places you'll use — including every must-visit (use its placeId);",
  "(3) clusterByDay to spread the detailed places across the requested number of days;",
  "(4) assembleItinerary to lay out a draft (visits, transit, meals) — it honours opening hours;",
  "(5) finalizeItinerary to validate and finish.",
  "If finalize reports hard violations, fix and retry:",
  "DAY_TOO_TIGHT or FLIGHT_BUFFER → rebalanceDays, then assembleItinerary, then finalize;",
  "BUDGET_EXCEEDED → trimToBudget, then assembleItinerary, then finalize.",
  "These tools operate on the data you've already gathered. Stop once finalizeItinerary succeeds.",
].join(" ");

export function createColdStartSpec(
  request: TripRequest,
  provider: ToolProvider,
): AgentSpec<PlanningState> {
  return {
    instruction: INSTRUCTION,
    kickoff: `Plan this trip:\n${JSON.stringify(request, null, 2)}`,
    model: "gpt-4o-mini",
    constraints: { maxIterations: 25, maxTokens: 150_000, runtimeMs: 60_000 },
    tools: buildTools(provider),
    initialState: {
      request,
      places: new Map(),
      details: new Map(),
      assignments: null,
      draft: null,
      itinerary: null,
    },
    validate: validateState,
  };
}
