/**
 * M0/M1 demo: run the cold-start agent against the mock provider, then print the
 * itinerary as JSON and readable text.
 *
 *   pnpm dev                                  # scripted model, zero config
 *   tsx --env-file=.env src/interface/cli.ts  # real OpenAI model (needs OPENAI_API_KEY)
 */

import type { ModelClient } from "../application/ports/ModelClient";
import type { TripRequest } from "../domain/itinerary";
import { runAgent } from "../application/agent/runAgent";
import { createColdStartSpec } from "../application/planning/coldStart";
import { formatItineraryJson, formatItineraryText } from "../application/formatting/format";
import { createMockToolProvider } from "../infrastructure/tools/mock/mockToolProvider";
import { createScriptedColdStartModel } from "../infrastructure/llm/scriptedModelClient";
import { createOpenAIModelClient } from "../infrastructure/llm/openaiModelClient";
import { createFileTracer } from "../infrastructure/observability/fileTracer";
import { TOKYO_ACCOMMODATION, TOKYO_PLACES } from "../infrastructure/tools/mock/fixtures";

async function main(): Promise<void> {
  const request: TripRequest = {
    days: 2,
    destination: "Tokyo",
    accommodation: TOKYO_ACCOMMODATION,
    mustVisit: [{ name: "teamLab Planets", placeId: "p_teamlab" }],
    pace: "relaxed",
  };

  const provider = createMockToolProvider(TOKYO_PLACES);
  const spec = createColdStartSpec(request, provider);

  let model: ModelClient;
  if (process.env.OPENAI_API_KEY) {
    if (process.env.OPENAI_MODEL) spec.model = process.env.OPENAI_MODEL;
    model = createOpenAIModelClient();
    console.log(`model: OpenAI (${spec.model})`);
  } else {
    model = createScriptedColdStartModel(request);
    console.log("model: scripted (no OPENAI_API_KEY set)");
  }

  const logPath = `logs/run-${Date.now()}.ndjson`;
  const tracer = createFileTracer(logPath, { console: true });

  const result = await runAgent(spec, model, tracer);

  console.log("");
  console.log(`trace: ${logPath}`);
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
