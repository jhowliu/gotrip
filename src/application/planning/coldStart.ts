/**
 * Cold-start planning use case: build the `AgentSpec` for planning a trip from
 * scratch. The tools wrap the `ToolProvider` (real data) + pure domain skills
 * (clusterByDay, assemble, validate, estimateCost) and accumulate into a shared
 * planning state. Hard-constraint validation lives in `validate`; the
 * finalizeItinerary tool is the success exit.
 */

import { z } from "zod";

import type { AgentSpec, ToolDef, ToolOutcome } from "../agent/AgentSpec";
import type { ToolProvider } from "../ports/ToolProvider";
import type {
  DayAssignment,
  Itinerary,
  Place,
  PlaceDetail,
  PlaceType,
  TravelMode,
  TripRequest,
  ValidationResult,
} from "../../domain/itinerary";
import { clusterByDay, type ClusterPlace } from "../../domain/clusterByDay";
import { assembleItinerary } from "../../domain/assemble";
import { validate } from "../../domain/validate";
import { estimateCost } from "../../domain/estimateCost";

export interface PlanningState {
  request: TripRequest;
  places: Map<string, Place>;
  details: Map<string, PlaceDetail>;
  assignments: DayAssignment[] | null;
  draft: Itinerary | null;
  itinerary: Itinerary | null;
}

function mustVisitIds(request: TripRequest): Set<string> {
  return new Set(
    (request.mustVisit ?? [])
      .map((m) => m.placeId)
      .filter((id): id is string => typeof id === "string"),
  );
}

/** Validate the best itinerary we have; an incomplete plan is a hard violation. */
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
  return validate(itinerary);
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
      description: "Fetch full details (coords, opening hours, visit minutes, ticket price) for a place.",
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
      name: "assembleItinerary",
      description: "Lay out a draft itinerary from the day assignments and place details.",
      inputSchema: noInput,
      execute(_input, state): ToolOutcome {
        if (!state.assignments) {
          return { content: { error: "no day assignments; call clusterByDay first" }, isError: true };
        }
        const draft = assembleItinerary({
          request: state.request,
          assignments: state.assignments,
          details: state.details,
          mustVisitIds: mustVisitIds(state.request),
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
        const result = validate(draft);
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
  "(4) assembleItinerary to lay out a draft;",
  "(5) finalizeItinerary to validate and finish.",
  "clusterByDay, assembleItinerary and finalizeItinerary take no arguments — they operate on",
  "the data you've already gathered. Hard constraints (day count, must-visits scheduled) are",
  "checked at finalize; if it reports violations, fix them and retry. Stop once finalizeItinerary",
  "succeeds.",
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
