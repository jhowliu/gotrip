/**
 * M0–M3 demo: run the cold-start agent against the mock provider, then print the
 * itinerary as JSON and readable text. The `edit` scenario additionally saves the
 * plan and runs a natural-language edit through the warm-start agent (Phase 3).
 *
 *   pnpm dev                                  # scripted model, zero config
 *   pnpm dev -- edit                          # cold-start → save → NL edit → save
 *   tsx --env-file=.env src/interface/cli.ts  # real OpenAI model (needs OPENAI_API_KEY)
 */

import type { ModelClient } from "../application/ports/ModelClient";
import type { EditOp } from "../domain/applyEdits";
import type { PlaceDetail, TripRequest } from "../domain/itinerary";
import { runAgent } from "../application/agent/runAgent";
import { createColdStartSpec } from "../application/planning/coldStart";
import { createWarmEditSpec, resolveItineraryDetails } from "../application/planning/warmEdit";
import { formatItineraryJson, formatItineraryText } from "../application/formatting/format";
import { createMockToolProvider } from "../infrastructure/tools/mock/mockToolProvider";
import { createScriptedColdStartModel } from "../infrastructure/llm/scriptedModelClient";
import { createScriptedWarmModel } from "../infrastructure/llm/scriptedWarmModel";
import { createOpenAIModelClient } from "../infrastructure/llm/openaiModelClient";
import { createFileSessionStore } from "../infrastructure/persistence/fileSessionStore";
import { createFileTracer } from "../infrastructure/observability/fileTracer";
import type { Tracer } from "../application/agent/trace";
import {
  ADVERSARIAL_ACCOMMODATION,
  ADVERSARIAL_NARROW_WINDOW,
  ADVERSARIAL_OVER_BUDGET,
  TOKYO_ACCOMMODATION,
  TOKYO_PLACES,
} from "../infrastructure/tools/mock/fixtures";

async function main(): Promise<void> {
  // Pick a scenario via `... -- <name>`. Each adversarial one trips a different
  // hard constraint so you can watch the agent (real or scripted) self-correct.
  type ScenarioName = "tokyo" | "adversarial" | "budget" | "flights";
  interface Scenario {
    label: string;
    request: TripRequest;
    places: PlaceDetail[];
  }
  const scenarios: Record<ScenarioName, Scenario> = {
    tokyo: {
      label: "tokyo (happy path)",
      request: {
        days: 2,
        destination: "Tokyo",
        accommodation: TOKYO_ACCOMMODATION,
        mustVisit: [{ name: "teamLab Planets", placeId: "p_teamlab" }],
        pace: "relaxed",
      },
      places: TOKYO_PLACES,
    },
    adversarial: {
      label: "adversarial — narrow opening window (CLOSED_HOURS)",
      request: {
        days: 1,
        destination: "Tokyo",
        accommodation: ADVERSARIAL_ACCOMMODATION,
        mustVisit: [{ name: "Sunrise Museum", placeId: "a_sunrise" }],
        pace: "relaxed",
      },
      places: ADVERSARIAL_NARROW_WINDOW,
    },
    budget: {
      label: "budget — over a 3000–5000/day band (BUDGET_EXCEEDED → trim)",
      request: {
        days: 1,
        destination: "Tokyo",
        accommodation: ADVERSARIAL_ACCOMMODATION,
        budget: { min: 3000, max: 5000 },
        mustVisit: [{ name: "Free Shrine", placeId: "b_shrine" }],
        pace: "relaxed",
      },
      places: ADVERSARIAL_OVER_BUDGET,
    },
    flights: {
      label: "flights — impossible departure (FLIGHT_BUFFER → graceful exit)",
      request: {
        days: 2,
        destination: "Tokyo",
        accommodation: TOKYO_ACCOMMODATION,
        departure: { airport: "NRT", datetime: "2026-07-03T11:00" },
        mustVisit: [{ name: "teamLab Planets", placeId: "p_teamlab" }],
        pace: "relaxed",
      },
      places: TOKYO_PLACES,
    },
  };

  const argv = process.argv.slice(2);
  const useOpenAI = Boolean(process.env.OPENAI_API_KEY);
  const logPath = `logs/run-${Date.now()}.ndjson`;
  const tracer = createFileTracer(logPath, { console: true });
  console.log(`trace: ${logPath}`);

  if (argv.includes("edit")) {
    await runEditDemo(useOpenAI, tracer);
    return;
  }

  const arg = argv.find((a): a is ScenarioName => a in scenarios);
  const { label, request, places } = scenarios[arg ?? "tokyo"];

  const provider = createMockToolProvider(places);
  const spec = createColdStartSpec(request, provider);
  console.log(`scenario: ${label}`);

  let model: ModelClient;
  if (useOpenAI) {
    if (process.env.OPENAI_MODEL) spec.model = process.env.OPENAI_MODEL;
    model = createOpenAIModelClient({ tracer });
    console.log(`model: OpenAI (${spec.model})`);
  } else {
    model = createScriptedColdStartModel(request);
    console.log("model: scripted (no OPENAI_API_KEY set)");
  }

  const result = await runAgent(spec, model, tracer);

  console.log("");
  console.log(`status: ${result.status} (${result.iterations} iterations)`);
  console.log(`hard violations: ${result.validation.hardViolations.length}`);
  console.log("");

  const itinerary = result.state.itinerary;
  if (!itinerary) {
    console.log("No itinerary produced.");
    console.log(JSON.stringify(result.validation, null, 2));
    return;
  }

  console.log("=== Itinerary (text) ===");
  console.log(formatItineraryText(itinerary));
  console.log("");
  console.log("=== Itinerary (JSON) ===");
  console.log(formatItineraryJson(itinerary));
}

/** Phase 3 demo: cold-start a plan, persist it, then run one natural-language edit. */
async function runEditDemo(useOpenAI: boolean, tracer: Tracer): Promise<void> {
  const provider = createMockToolProvider(TOKYO_PLACES);
  const request: TripRequest = {
    days: 2,
    destination: "Tokyo",
    accommodation: TOKYO_ACCOMMODATION,
    mustVisit: [{ name: "teamLab Planets", placeId: "p_teamlab" }],
    pace: "relaxed",
  };
  console.log(`model: ${useOpenAI ? "OpenAI" : "scripted"}`);

  // 1) Cold-start a base itinerary.
  const baseSpec = createColdStartSpec(request, provider);
  const baseModel: ModelClient = useOpenAI
    ? createOpenAIModelClient({ tracer })
    : createScriptedColdStartModel(request);
  const base = (await runAgent(baseSpec, baseModel, tracer)).state.itinerary;
  if (!base) {
    console.log("cold start produced no itinerary; aborting.");
    return;
  }

  // 2) Persist it, then reload (proving round-trip).
  const store = createFileSessionStore("data/sessions");
  await store.save("demo", base);
  const loaded = await store.load("demo");
  if (!loaded) return;
  console.log("\n=== base itinerary (saved to data/sessions/demo.json) ===");
  console.log(formatItineraryText(loaded));

  // 3) Warm-edit it from a natural-language instruction. Target the last visit of
  //    day 1 so the demo works regardless of which places the planner picked.
  const day1Visits = (loaded.days[0]?.items ?? []).filter((i) => i.kind === "visit");
  const target = day1Visits[day1Visits.length - 1];
  if (!target) {
    console.log("day 1 has no visit to move; aborting edit.");
    return;
  }
  const instruction = `Move ${target.name} to the morning of day 1.`;
  console.log(`\nuser: "${instruction}"`);

  const details = await resolveItineraryDetails(loaded, provider);
  const warmModel: ModelClient = useOpenAI
    ? createOpenAIModelClient({ tracer })
    : createScriptedWarmModel([{ op: "move", itemId: target.itemId, toDay: 1, atTime: "09:00" }] as EditOp[]);

  const editResult = await runAgent(createWarmEditSpec(loaded, instruction, provider, details), warmModel, tracer);
  console.log(`\nedit status: ${editResult.status} — hard violations: ${editResult.validation.hardViolations.length}`);

  if (editResult.state.finalized) {
    await store.save("demo", editResult.state.itinerary);
    console.log("=== edited itinerary (saved) ===");
    console.log(formatItineraryText(editResult.state.itinerary));
  } else {
    console.log("edit not applied — the agent reported a conflict instead of forcing an impossible plan.");
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
