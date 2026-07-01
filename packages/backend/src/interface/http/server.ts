/**
 * M5 HTTP layer — a thin Hono adapter over the existing use cases. The inner
 * layers are untouched: routes just call cold-start planning, deterministic
 * applyEdits (drag-and-drop), and the warm-edit agent (chat), all behind the
 * same ports M0–M3 used. API-only; the React app (packages/web) is the UI.
 *
 *   npm run serve   # http://localhost:8787  (chat needs OPENAI_API_KEY)
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";

import type { ModelClient } from "../../application/ports/ModelClient";
import type { EditOp } from "../../domain/applyEdits";
import type { GeoLocation, TripRequest } from "../../domain/itinerary";
import { runAgent } from "../../application/agent/runAgent";
import { prepareColdStart } from "../../application/planning/planTrip";
import { createWarmEditSpec, resolveItineraryDetails } from "../../application/planning/warmEdit";
import { editOpsSchema } from "../../application/editing/editOps";
import { applyEdits } from "../../domain/applyEdits";
import { estimateTravelMinutes } from "../../domain/travel";
import { validate } from "../../domain/validate";
import { createFileSessionStore } from "../../infrastructure/persistence/fileSessionStore";
import { createFileTracer } from "../../infrastructure/observability/fileTracer";
import { createProvider } from "../../infrastructure/tools/createProvider";
import { createScriptedColdStartModel } from "../../infrastructure/llm/scriptedModelClient";
import { createOpenAIModelClient } from "../../infrastructure/llm/openaiModelClient";
import { TAIPEI_ACCOMMODATION } from "../../infrastructure/tools/mock/fixtures";

const legMinutes = (a: GeoLocation, b: GeoLocation): number => estimateTravelMinutes(a, b, "transit");
const store = createFileSessionStore("data/sessions");
const { provider, source: providerSource } = createProvider();
const hasOpenAI = (): boolean => Boolean(process.env.OPENAI_API_KEY);

const locationSchema = z.object({ name: z.string(), lat: z.number().optional(), lng: z.number().optional() });
const tripRequestSchema = z
  .object({
    days: z.number().int().positive().max(14),
    destination: z.string().min(1),
    accommodation: locationSchema,
    mustVisit: z.array(z.object({ name: z.string(), placeId: z.string().optional() })).optional(),
    budget: z.object({ min: z.number().optional(), max: z.number() }).optional(),
    pace: z.enum(["relaxed", "default", "packed"]).optional(),
  })
  .passthrough();

const app = new Hono();
app.use("/api/*", cors());

app.get("/", (c) => c.json({ app: "gotrip api", ui: "run the web app: npm run web (vite dev on :5173)" }));

app.get("/api/config", (c) => c.json({ chatEnabled: hasOpenAI(), provider: providerSource }));

app.get("/api/places", async (c) => {
  const places = await provider.searchPlaces({ query: c.req.query("q") ?? "", center: TAIPEI_ACCOMMODATION });
  return c.json({ places });
});

app.get("/api/route", async (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (!from || !to) return c.json({ error: "from and to place ids required" }, 400);
  const detail = async (id: string) => {
    try {
      return await provider.getPlaceDetails({ placeId: id });
    } catch {
      return null;
    }
  };
  const [a, b] = await Promise.all([detail(from), detail(to)]);
  if (!a || !b) return c.json({ error: "unknown place id" }, 404);
  const route = await provider.getTransitRoute({ origin: a.location, destination: b.location, mode: "transit" });
  return c.json({ route }); // TransitRoute | null (null in mock / uncovered regions)
});

app.get("/api/sessions/:id", async (c) => {
  const itinerary = await store.load(c.req.param("id"));
  if (!itinerary) return c.json({ error: "not found" }, 404);
  const validation = validate(itinerary, await resolveItineraryDetails(itinerary, provider));
  return c.json({ itinerary, validation });
});

app.post("/api/sessions/:id/plan", async (c) => {
  const parsed = tripRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid trip request", issues: parsed.error.issues }, 400);
  const request = parsed.data as TripRequest;
  const logPath = `logs/plan-${Date.now()}.ndjson`;
  const tracer = createFileTracer(logPath, { console: true });
  console.log(`\n=== plan: ${request.destination}, ${request.days}d → ${logPath} ===`);
  const prepared = await prepareColdStart(request, provider);
  const model: ModelClient = hasOpenAI() ? createOpenAIModelClient({ tracer }) : createScriptedColdStartModel(prepared.request);
  const result = await runAgent(prepared.spec, model, tracer);
  const itinerary = result.state.itinerary;
  if (!itinerary) {
    return c.json({ error: "planning produced no itinerary", validation: result.validation, resolveErrors: prepared.resolveErrors, trace: logPath }, 422);
  }
  await store.save(c.req.param("id"), itinerary);
  return c.json({ itinerary, validation: result.validation, status: result.status, resolveErrors: prepared.resolveErrors, trace: logPath });
});

app.post("/api/sessions/:id/ops", async (c) => {
  const id = c.req.param("id");
  const itinerary = await store.load(id);
  if (!itinerary) return c.json({ error: "not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { operations?: unknown };
  const parsed = editOpsSchema.safeParse(body.operations);
  if (!parsed.success) return c.json({ error: "invalid operations", issues: parsed.error.issues }, 400);
  const details = await resolveItineraryDetails(itinerary, provider);
  const result = applyEdits(itinerary, parsed.data as EditOp[], { details, legMinutes });
  if (result.changed) await store.save(id, result.itinerary);
  return c.json({ itinerary: result.itinerary, validation: result.validation, errors: result.errors, changed: result.changed });
});

app.post("/api/sessions/:id/chat", async (c) => {
  if (!hasOpenAI()) return c.json({ error: "chat needs OPENAI_API_KEY on the server" }, 400);
  const id = c.req.param("id");
  const itinerary = await store.load(id);
  if (!itinerary) return c.json({ error: "not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { instruction?: unknown };
  const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
  if (!instruction) return c.json({ error: "instruction required" }, 400);
  const details = await resolveItineraryDetails(itinerary, provider);
  const logPath = `logs/chat-${Date.now()}.ndjson`;
  const tracer = createFileTracer(logPath, { console: true });
  console.log(`\n=== chat: "${instruction}" → ${logPath} ===`);
  const spec = createWarmEditSpec(itinerary, instruction, provider, details);
  const result = await runAgent(spec, createOpenAIModelClient({ tracer }), tracer);
  if (result.state.finalized) await store.save(id, result.state.itinerary);
  return c.json({
    itinerary: result.state.itinerary,
    validation: result.validation,
    status: result.status,
    finalized: result.state.finalized,
    trace: logPath,
  });
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`gotrip web → http://localhost:${info.port}  (chat ${hasOpenAI() ? "enabled" : "disabled — set OPENAI_API_KEY"})`);
});
