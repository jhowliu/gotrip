/**
 * M0 demo: run the cold-start agent against the mock provider + scripted model,
 * then print the itinerary as JSON and readable text. No network, no API key.
 *
 *   pnpm dev
 */

import type { TripRequest } from "../domain/itinerary";
import { runAgent } from "../application/agent/runAgent";
import { createColdStartSpec } from "../application/planning/coldStart";
import { formatItineraryJson, formatItineraryText } from "../application/formatting/format";
import { createMockToolProvider } from "../infrastructure/tools/mock/mockToolProvider";
import { createScriptedColdStartModel } from "../infrastructure/llm/scriptedModelClient";
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
  const model = createScriptedColdStartModel(request);

  const result = await runAgent(spec, model);

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
