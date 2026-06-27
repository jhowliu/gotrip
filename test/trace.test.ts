import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TraceEvent, Tracer } from "../src/application/agent/trace";
import type { TripRequest } from "../src/domain/itinerary";
import { runAgent } from "../src/application/agent/runAgent";
import { createColdStartSpec } from "../src/application/planning/coldStart";
import { createMockToolProvider } from "../src/infrastructure/tools/mock/mockToolProvider";
import { createScriptedColdStartModel } from "../src/infrastructure/llm/scriptedModelClient";
import { createFileTracer } from "../src/infrastructure/observability/fileTracer";
import { TOKYO_ACCOMMODATION, TOKYO_PLACES } from "../src/infrastructure/tools/mock/fixtures";

const request: TripRequest = {
  days: 2,
  destination: "Tokyo",
  accommodation: TOKYO_ACCOMMODATION,
  mustVisit: [{ name: "teamLab Planets", placeId: "p_teamlab" }],
  pace: "relaxed",
};

describe("agent tracing", () => {
  it("emits tool_call / tool_result / finish events with input and output", async () => {
    const events: TraceEvent[] = [];
    const tracer: Tracer = (e) => events.push(e);
    const provider = createMockToolProvider(TOKYO_PLACES);

    await runAgent(createColdStartSpec(request, provider), createScriptedColdStartModel(request), tracer);

    const calls = events.filter((e) => e.type === "tool_call");
    const results = events.filter((e) => e.type === "tool_result");
    expect(calls.some((e) => e.type === "tool_call" && e.name === "searchPlaces")).toBe(true);
    expect(results.some((e) => e.type === "tool_result" && e.final)).toBe(true);

    // tool_call carries the requested input, tool_result the output
    const detailsCall = calls.find((e) => e.type === "tool_call" && e.name === "getPlaceDetails");
    expect(detailsCall && "input" in detailsCall).toBe(true);
    const firstResult = results[0]!;
    expect(firstResult.type === "tool_result" && "output" in firstResult).toBe(true);

    const finish = events.find((e) => e.type === "finish");
    expect(finish).toMatchObject({ type: "finish", status: "ok" });
  });

  it("file tracer writes timestamped NDJSON lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gotrip-trace-"));
    const file = join(dir, "trace.ndjson");
    const tracer = createFileTracer(file);
    const provider = createMockToolProvider(TOKYO_PLACES);

    await runAgent(createColdStartSpec(request, provider), createScriptedColdStartModel(request), tracer);

    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(3);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed.some((p) => p["type"] === "tool_call")).toBe(true);
    expect(parsed.every((p) => typeof p["ts"] === "string")).toBe(true);
  });
});
