/**
 * Warm-start editing use case (Phase 3): build the `AgentSpec` for modifying an
 * existing itinerary from a natural-language instruction. The loop is seeded with
 * the current itinerary as JSON (not the prior transcript). The agent translates
 * intent into structured edit operations via the `applyEdits` tool.
 *
 * Conflict policy (Q3): the user's wish overrides soft preferences, but an edit
 * that breaks a *hard* constraint is rejected — the agent reports it and offers
 * an alternative rather than committing an impossible plan. Model tiering: a
 * cheap model for routine edits, a one-shot escalation when no progress is made.
 */

import { z } from "zod";

import type { AgentSpec, ToolDef, ToolOutcome } from "../agent/AgentSpec";
import type { ToolProvider } from "../ports/ToolProvider";
import type {
  GeoLocation,
  Itinerary,
  Place,
  PlaceDetail,
  PlaceType,
  ValidationResult,
} from "../../domain/itinerary";
import { applyEdits, type EditOp } from "../../domain/applyEdits";
import { editOpsSchema } from "../editing/editOps";
import { validate } from "../../domain/validate";
import { estimateTravelMinutes } from "../../domain/travel";

export interface WarmEditState {
  itinerary: Itinerary; // current; only valid edits are committed here
  details: Map<string, PlaceDetail>; // existing places + any newly resolved
  places: Map<string, Place>; // search results for add-by-name
  finalized: boolean;
}

const legMinutes = (a: GeoLocation, b: GeoLocation): number => estimateTravelMinutes(a, b, "transit");

const applyEditsSchema = z.object({ operations: editOpsSchema });
const searchSchema = z.object({
  query: z.string(),
  type: z.enum(["attraction", "restaurant"]).optional(),
  maxResults: z.number().int().positive().optional(),
});
const detailsSchema = z.object({ placeId: z.string() });
const noInput = z.object({}).passthrough();

function buildWarmTools(provider: ToolProvider): ToolDef<WarmEditState>[] {
  return [
    {
      name: "searchPlaces",
      description: "Search for a place to add (by name/keyword) near the accommodation.",
      inputSchema: searchSchema,
      async execute(input, state): Promise<ToolOutcome> {
        const { query, type, maxResults } = input as { query: string; type?: PlaceType; maxResults?: number };
        const results = await provider.searchPlaces({
          query,
          center: state.itinerary.request.accommodation,
          ...(type ? { type } : {}),
          ...(maxResults ? { maxResults } : {}),
        });
        for (const p of results) state.places.set(p.placeId, p);
        return { content: results };
      },
    },
    {
      name: "getPlaceDetails",
      description: "Fetch full details for a place (needed before adding it to a day).",
      inputSchema: detailsSchema,
      async execute(input, state): Promise<ToolOutcome> {
        const { placeId } = input as { placeId: string };
        const detail = await provider.getPlaceDetails({ placeId });
        state.details.set(detail.placeId, detail);
        return { content: detail };
      },
    },
    {
      name: "applyEdits",
      description:
        "Apply structured edit operations (move/add/remove/setDuration/pin) to the itinerary. " +
        "Rejects an edit that would break a hard constraint, returning the violations to report.",
      inputSchema: applyEditsSchema,
      execute(input, state): ToolOutcome {
        const { operations } = input as { operations: EditOp[] };
        const result = applyEdits(state.itinerary, operations, { details: state.details, legMinutes });

        if (result.errors.length > 0) {
          return { content: { error: "invalid edit", details: result.errors }, isError: true };
        }
        if (result.validation.hardViolations.length > 0) {
          // Don't commit an impossible plan — surface the conflict for an alternative.
          return {
            content: {
              rejected: true,
              reason: "edit breaks a hard constraint",
              hardViolations: result.validation.hardViolations,
            },
            isError: true,
          };
        }
        state.itinerary = result.itinerary; // commit
        return {
          content: { ok: true, totalCost: result.itinerary.totalCost, softWarnings: result.validation.softWarnings },
        };
      },
    },
    {
      name: "finishEditing",
      description: "Finalize after a successful edit. Returns the validated itinerary.",
      inputSchema: noInput,
      execute(_input, state): ToolOutcome {
        const result = validate(state.itinerary, state.details);
        if (result.hardViolations.length > 0) {
          return { content: { error: "itinerary has hard violations", hardViolations: result.hardViolations }, isError: true };
        }
        state.finalized = true;
        return {
          content: { ok: true, totalCost: state.itinerary.totalCost, softWarnings: result.softWarnings },
          final: true,
        };
      },
    },
  ];
}

const WARM_INSTRUCTION = [
  "You are editing an existing travel itinerary based on the user's request.",
  "The current itinerary (with item ids) is given. Translate the request into edit operations",
  "and call applyEdits with an `operations` array:",
  "move {itemId, toDay, atTime?} — move an item to another day/time;",
  "setDuration {itemId, minutes} — change a visit's length;",
  "remove {itemId} — drop an item;",
  "add {placeId, day} — add a place (to add one the user names but isn't in the plan, searchPlaces then getPlaceDetails first);",
  "pin {itemId} — mark an item as must-keep.",
  "The user's wish overrides soft preferences. But if applyEdits reports the edit was rejected because it",
  "breaks a hard constraint (closed opening hours, flight buffer, a day running too long, or dropping a",
  "must-visit), DO NOT keep trying variations to force it — report the conflict and propose the closest",
  "workable alternative (a different day or a shorter duration). Soft warnings are informational: mention",
  "them but keep the user's edit. Once an edit is applied successfully, call finishEditing.",
].join(" ");

/** Pre-fetch details for every place already in the itinerary (needed to re-layout edited days). */
export async function resolveItineraryDetails(
  itinerary: Itinerary,
  provider: ToolProvider,
): Promise<Map<string, PlaceDetail>> {
  const ids = new Set<string>();
  for (const day of itinerary.days) {
    for (const item of day.items) {
      if (item.kind === "visit" && item.placeId) ids.add(item.placeId);
    }
  }
  const details = new Map<string, PlaceDetail>();
  for (const id of ids) {
    const detail = await provider.getPlaceDetails({ placeId: id });
    details.set(detail.placeId, detail);
  }
  return details;
}

export function createWarmEditSpec(
  itinerary: Itinerary,
  userRequest: string,
  provider: ToolProvider,
  details: Map<string, PlaceDetail> = new Map(),
): AgentSpec<WarmEditState> {
  const validateState = (state: WarmEditState): ValidationResult => validate(state.itinerary, state.details);
  return {
    instruction: WARM_INSTRUCTION,
    kickoff: `Current itinerary:\n${JSON.stringify(itinerary, null, 2)}\n\nUser request: ${userRequest}`,
    model: "gpt-4o-mini", // cheap model for routine edits
    escalationModel: "gpt-4o", // one-shot escalation when no progress is made
    constraints: { maxIterations: 12, maxTokens: 100_000, runtimeMs: 45_000 },
    tools: buildWarmTools(provider),
    initialState: { itinerary, details, places: new Map(), finalized: false },
    validate: validateState,
  };
}
