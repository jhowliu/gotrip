/**
 * M0/M1 demo: run the cold-start agent against the mock provider, then print the
 * itinerary as JSON and readable text.
 *
 *   pnpm dev                                  # scripted model, zero config
 *   tsx --env-file=.env src/interface/cli.ts  # real OpenAI model (needs OPENAI_API_KEY)
 */

import type { ModelClient } from "../application/ports/ModelClient";
import type { PlaceDetail, TripRequest } from "../domain/itinerary";
import { runAgent } from "../application/agent/runAgent";
import { createColdStartSpec } from "../application/planning/coldStart";
import { formatItineraryJson, formatItineraryText } from "../application/formatting/format";
import { createMockToolProvider } from "../infrastructure/tools/mock/mockToolProvider";
import { createScriptedColdStartModel } from "../infrastructure/llm/scriptedModelClient";
import { createOpenAIModelClient } from "../infrastructure/llm/openaiModelClient";
import { createFileTracer } from "../infrastructure/observability/fileTracer";
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
      label: "budget — over the economy ceiling (BUDGET_EXCEEDED → trim)",
      request: {
        days: 1,
        destination: "Tokyo",
        accommodation: ADVERSARIAL_ACCOMMODATION,
        budgetLevel: "economy",
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

  const arg = process.argv.slice(2).find((a): a is ScenarioName => a in scenarios);
  const { label, request, places } = scenarios[arg ?? "tokyo"];

  const provider = createMockToolProvider(places);
  const spec = createColdStartSpec(request, provider);
  console.log(`scenario: ${label}`);

  const logPath = `logs/run-${Date.now()}.ndjson`;
  const tracer = createFileTracer(logPath, { console: true });

  let model: ModelClient;
  if (process.env.OPENAI_API_KEY) {
    if (process.env.OPENAI_MODEL) spec.model = process.env.OPENAI_MODEL;
    model = createOpenAIModelClient({ tracer });
    console.log(`model: OpenAI (${spec.model})`);
  } else {
    model = createScriptedColdStartModel(request);
    console.log("model: scripted (no OPENAI_API_KEY set)");
  }
  console.log(`trace: ${logPath}`);

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

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
