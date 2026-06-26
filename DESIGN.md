# Travel-Planning Agent — Design Decisions

> This document is the **finalized decisions** after a round of grilling on the original design draft.
> The real deliverable is **agent-development skill**; trip planning is just the carrier.

---

## Core design principles

1. **The model figures things out, code guards, data comes from real APIs.**
2. **Hard constraints are checked in code, not begged for in the prompt.**
3. **Tools output clean structured JSON, chained by `placeId`.**
4. **Extract anything single-purpose and independently testable into a module; keep the prompt thin.**
5. **Prove the agent's capability (including Phase 3) on mock data first; real APIs / DB / UI are the outer shell added last.**
6. **Slack lives at the "day" level, not per item; hard violations are split out and reported, soft constraints are warnings only (no scoring).**

---

## 1. Scope & endpoint

- **Endpoint = Phase 3 (conversational modification).**
- **The entire Phase 3 is built on pure mock first** — the agent's intelligence doesn't depend on the data being real, only on the data being **well-shaped**.
- The original Phase 4 (real-time data / timetables) is **cut**; if done at all, only "weather / ticket alerts", and as a distant optional extension.

---

## 2. System architecture (B: fat agent + thin tools)

| Role | Who does it |
|---|---|
| Planning subject (decides which places, what order, how to re-plan) | **LLM** |
| Inter-day clustering draft, travel-time calc, cost aggregation | deterministic code / API |
| Gatekeeping (hard-constraint validation) | **deterministic Validator** |
| Data | real APIs (fixtures during the mock phase) |

> Algorithms are "advisory tools," not "decision-making pipelines." The fixed pipeline in the flowchart → becomes "capabilities the agent can choose to call."

---

## 3. Data model

### 3.1 Input `TripRequest` (`mustVisit` upgraded)

```typescript
type TripRequest = {
  days: number;
  destination: string;
  accommodation: Location;          // no coords → geocode at cold-start step 0
  mustVisit?: MustVisit[];          // ★ upgraded from string[]
  arrival?: FlightInfo;
  departure?: FlightInfo;
  budgetLevel?: "economy" | "moderate" | "luxury";
  pace?: "relaxed" | "packed";
};

type MustVisit = {
  name: string;        // required, human-readable
  placeId?: string;    // optional: carried when picked from autocomplete → zero ambiguity, saves an API call
  location?: Location; // optional: carried when an address/coords is available
};

type Location = { name: string; lat?: number; lng?: number };
type FlightInfo = { airport: string; datetime: string };
```

### 3.2 Output `Itinerary` (the system's protagonist, mutated repeatedly)

```typescript
type Itinerary = {
  request: TripRequest;        // anchors embedded here; re-queried when editing
  days: ItineraryDay[];
  totalCost?: number;
};

type ItineraryDay = {
  dayIndex: number;            // 1-based
  items: ItineraryItem[];      // ordered by startTime
};

type ItineraryItem = {
  itemId: string;              // ★ stable id; conversational edits refer to it (never array index)
  kind: "visit" | "meal" | "transit";   // transit is a first-class item
  placeId?: string;
  name: string;                // transit holds e.g. "take the train, ~25 min"
  startTime: string;           // store start only; endTime = start + duration, computed
  durationMinutes: number;
  mode?: string;               // transit-only
  mealWindow?: [string, string];  // meal-only, e.g. ["11:30","13:30"]
  pinned?: boolean;            // must-visit / user-fixed; re-plan must not move it
  estimatedCost?: number;
};
```

**Single source of time truth:** store only `startTime + durationMinutes`, never `endTime` (avoids the two fields drifting).
**Day validity** = each item's `startTime ≥ the previous item's endTime`.

---

## 4. Tools layer

Four tools (`searchPlaces` / `getPlaceDetails` / `getTravelTime` / `estimateCost`) chained by `placeId`, outputting clean JSON. Detailed signatures are in the original draft; below are the **decision revisions**.

### 4.1 Three search scopes (important)

| Scenario | Scope | Mechanism |
|---|---|---|
| **① must-visit name resolution** | **city-wide, no small radius** | Text Search: `"{name} {destination}"`, accommodation used only as a ranking bias for ambiguity |
| **② companion search around a far must-visit** | ~1.5–2.5km | centered on the pinned must-visit's coords |
| **③ general exploration around accommodation** | ~3–5km (default 5000) | nearby search centered on accommodation |

> A must-visit is a hard constraint; distance doesn't affect "whether we should find it." Framing it with an accommodation radius = bug. Flow: **resolve city-wide → pin at real coords → build that day's plan around it.**

### 4.2 must-visit resolution priority

1. has `placeId` → use directly, no search.
2. has `location` → nearby search to locate.
3. name only → Text Search; **ambiguous** → pick best and confirm in dialog; **not found** → return an actionable error, **never silently drop a hard constraint**.

> The name-only path must be kept (Phase 0 hand-written fixtures and early demos rely on it).

### 4.3 Cost caps (per cold-start session; hitting a cap returns a readable error, not a crash)

| Tool | Cap | Key point |
|---|---|---|
| `searchPlaces` | ≤ 6, maxResults ≤ 10 | |
| `getPlaceDetails` | ≤ 20 | **the key cost-saver ↓** |
| `getTravelTime` | ≤ 30 | only verifies same-day adjacent legs, not N² |

**The most important cost-saving rule — triage:** `searchPlaces` returns lightweight `Place[]` (with rating/priceLevel); `getPlaceDetails` is the expensive per-place call. So the agent must **first filter the top candidates from the cheap search summaries, and only pay for details on those** — don't blindly fetch details for every search result. "Needed count × 1.5 candidates" is enough to choose from.

`getTravelTime` can be capped at ≤30 because §4.1 already decided `clusterByDay` uses haversine (free) for the draft, and `getTravelTime` is **only called point-wise to verify same-day adjacent legs**.

---

## 5. Skills layer (independently testable)

- **`clusterByDay`** — inter-day assignment. Use **coordinate haversine (free, no travel API)** for the draft; only call `getTravelTime` to verify the "adjacent points that end up on the same day."
- **Intra-day ordering** — done by the **LLM** (3–5 points per day, small combinatorial space, requires weighing opening hours / meal windows / pace — semantic judgment).
- **Validator** — see §8. The reliability core; deterministic and independently testable.
- **`estimateCost` / formatter** — aggregate costs against budget; `Itinerary → text / json / map`.

### Time estimation

- **Transit** = `getTravelTime` estimate + **a small per-leg buffer** (scaled by pace); **no timetable/headway modeling**. Flight-catching legs use a **conservative large buffer** and are hard constraints.
- **Visit duration** = `estimatedVisitMinutes` → category-default table → 60-min fallback. **No per-item padding.**
- **Slack lives at the "day" level**: pace controls the day's fill ratio (relaxed ~70% / packed ~90%), the rest left as slack. Visit durations can be changed by the user only **through conversation** (re-validate that day after).

### Meals

- Default **lunch + dinner per day** (breakfast assumed at the accommodation, skipped by default, configurable).
- Placed within `mealWindow` (lunch 11:30–13:30 / dinner 18:00–20:00); restaurant candidates come from that day's cluster.
- **Meal timing is a soft constraint** (a missing/out-of-window meal is only a soft warning).

---

## 6. Agent Runtime (generic, reusable → serves the meta-goal)

### 6.1 `AgentSpec<TState>`

```typescript
interface AgentSpec<TState> {
  instruction: string;
  model: ModelId;
  constraints: { maxIterations: number; maxTokens: number; runtimeMs: number };
  tools: ToolDef<TState>[];                       // tools read/mutate shared state, each does its own legality checks
  initialState: TState;
  validate: (state: TState) => ValidationResult;  // injected "finalize gate"; the runtime doesn't know its contents
}
```

Travel = `TState = Itinerary`. To switch domains, swap state + validate; the runtime doesn't change.

### 6.2 Hand-written self-loop (~40 lines, generic)

```typescript
let state = spec.initialState;
while (withinBudget(spec.constraints)) {
  const resp = await callModel(spec.model, spec.instruction, history); // Claude native tool use
  if (resp.toolUse) {
    const result = executeTool(resp.tool, state);  // can reject + return a readable error → agent retries naturally
    appendToolResult(history, result);
    continue;
  }
  if (resp.wantsFinalize) {
    const v = spec.validate(state);
    if (v.hardViolations.length === 0) return { state, status: "ok" };
    appendFeedback(history, v.hardViolations);     // feed back → agent self-corrects
    continue;
  }
}
return { state, status: "budget_exhausted", validation: spec.validate(state) };  // graceful exit
```

- **Two validation layers**: tool-boundary checks (per operation, fix early and burn fewer tokens) + finalize gate (only finalize a fully-valid itinerary).
- **Two exits**: clean (validate passes) / budget-exhausted (return partial result + named unmet hard constraints + an invitation to relax; **never emit a fake-valid plan, never crash**).
- **Don't spin up a separate reviewer node for hard constraints** (the planner self-corrects them in the loop); a standalone reviewer is only for cross-model handoff or purely subjective LLM critique (and must not drive re-planning).

### 6.3 Two modes (routed in code, not by the LLM)

| | Cold-start: initial planning | Warm-start: conversational edit |
|---|---|---|
| Trigger | `load()` returns null | returns an existing Itinerary |
| Starting context | TripRequest | current Itinerary JSON + new instruction (**transcript not replayed**) |
| Loop | long | short (most data already cached) |

### 6.4 Model tiering (`AgentSpec.model` makes tiering free — tier from day one)

- **Sonnet 4.6** — cold-start planning (default workhorse).
- **Haiku 4.5** — simple warm-start edits.
- **Opus 4.8** — one-shot escalation only when stuck, before deciding to exit gracefully.

---

## 7. Guardrails (numbers are starting values to "measure then tune")

> **iterations = LLM turns, not tool calls.** Encourage the agent to batch tool calls; total tool volume is bounded independently by the per-tool caps in §4.3.

| Constraint | Cold-start | Warm-start |
|---|---|---|
| maxIterations (LLM turns) | 25 | 8 |
| token cap / session | ~150k | ~40k |
| runtime cap | 60s | 20s |
| per-tool cap | §4.3 | applyEdits ≤ 10 |
| cross-node total budget | session-level sum counted separately | |

**No-progress detection** (maintain `progressSignal = (itinerary hash, fetched-data count, recent tool-call set)`); any trigger → graceful exit:

1. `progressSignal` unchanged for **3** consecutive turns.
2. the same `(tool, args)` repeated **3** times in a row.
3. `validate()` returns the **identical hardViolations 3 times** after re-planning (means it can't fix that constraint).

---

## 8. Validator design (no scoring)

```typescript
type ValidationResult = {
  hardViolations: Violation[];   // non-empty = invalid, must fix, blocks finalize
  softWarnings: Violation[];     // named warnings, informational only, don't block / don't drive the loop
};
type Violation = {
  code: string;                  // "CLOSED_HOURS" / "MUST_VISIT_MISSING" / "FLIGHT_BUFFER"...
  dayIndex?: number;
  itemId?: string;
  message: string;               // plain language, a hint for the agent to self-correct
  source: "user_instruction" | "constraint";   // for the §9 grading
};
```

- **Stop rule:** all hard constraints pass → finalize. **No softScore, no threshold, no endless micro-tuning.**
- Soft constraints = "generation guidance (in the prompt: keep daily travel < 2h, meals in their windows) + post-hoc warnings (listed as reminders)"; **not an objective function**. Whether to fix is the human's call (conversation).
- **Hard constraints**: must-visits present, day count = `days`, nothing scheduled in closed hours, last day ends before the departure flight with airport buffer, total cost ≤ hard ceiling.
- **User instruction vs physical hard constraint conflict**: the instruction overrides soft constraints; on collision with a physical hard constraint → **stop, report, and offer the closest workable alternative**, let the user decide (`source` marks the origin).

---

## 9. Conversational modification (Phase 3)

- **State**: Itinerary JSON = durable memory; the transcript is ephemeral.
- **Edit mechanism = structured edit operations** (not re-emitting the whole thing):

```typescript
applyEdits(input: {
  operations: (
    | { op: "move"; itemId: string; toDay: number; atTime?: string }
    | { op: "add"; placeId: string; day: number }
    | { op: "remove"; itemId: string }
    | { op: "setDuration"; itemId: string; minutes: number }
    | { op: "pin"; itemId: string }
  )[];
}): { itinerary: Itinerary; validation: ValidationResult };
```

- After editing → re-validate + **recompute only affected legs**, not the whole plan.
- **Direct manipulation (drag-and-drop UI) = the same operations, the same Validator**; the only difference is "who produces the op + how conflicts are handled." **Direct edits are literal — no silent auto-rearranging**; to re-optimize, the user must say so. The UI is built last.

---

## 10. Persistence

- **JSON files first** (`FileSessionStore`), behind a repository interface; **the agent doesn't know a storage layer exists**.

```typescript
interface TripRepository {
  load(sessionId: string): Promise<Itinerary | null>;
  save(sessionId: string, itinerary: Itinerary): Promise<void>;
  listTopTrips?(): Promise<TripSummary[]>;   // added later
}
```

- **Trigger to upgrade to SQLite**: top trips / list-search / undo history / multi-session.
- **Hybrid storage**: metadata as columns (destination, view_count, created_at…) for query/ranking; **store the whole Itinerary as a JSON blob, no normalization**. Postgres only when deployed for multi-user concurrency.

---

## 11. Mock strategy (do both)

| | Realistic fixture | Adversarial fixture |
|---|---|---|
| Purpose | demo / smoke test / does it look plausible | **validate re-planning logic + regression tests** |
| Proves | looks reasonable | actually correct |

- Adversarial fixtures are **deliberately spiky**, each corresponding to one constraint (narrow opening hours, far-apart must-visits, flight-buffer squeeze, missing `estimatedVisitMinutes`), written as assertions.
- Realistic fixtures are built by **"record real API responses once → save as JSON → replay,"** which also captures the real API shape and paves the way for M4.
- **Don't be fooled by a pretty demo**: realistic data proves "looks good," only adversarial data proves "correct."

---

## 12. Implementation roadmap

> Biggest re-sequencing: **real APIs move from the original Phase 1 (early) to M4 (second-to-last).** M0–M3 prove all of Phase 3 on mock.

| Milestone | Goal | Acceptance |
|---|---|---|
| **M0 skeleton loop** | `AgentSpec` + `runAgent` + 3 minimal guardrails; mock four tools + `clusterByDay`; Validator checks only day count / must-visits | given a TripRequest → emit an itinerary, watch the loop run to completion |
| **M1 self-correction ★80% of the learning** | adversarial fixtures + full Validator + feed-violations-back + tool-boundary checks + no-progress detection + remaining guardrails | the agent detects rushed/closed/over-buffer and re-plans, still all mock |
| **M2 edit ops + persistence** | `applyEdits` + `FileSessionStore` + cold/warm two-mode routing | programmatically load → apply edit → re-validate → save |
| **M3 conversational modification (endpoint)** | warm-start mode + conflict handling + must-visit confirmation + model tiering | "move the temple to day-2 morning" works and stays coherent — **Phase 3 proven on pure mock** |
| **M4 real APIs** | real Google Places/Routes behind the same interface; bridge with the fixtures recorded in M0; geocode | real Tokyo data produces an itinerary (mostly engineering) |
| **M5 productization (optional)** | SQLite + top trips + drag-and-drop UI + map | feels like a real app (front-end work, not agent learning) |

---

## Appendix: decision shorthand

- Endpoint Phase 3; architecture B; real APIs deferred to M4.
- transit is a first-class item; `startTime + durationMinutes`; slack lives at the "day" level.
- mustVisit: `MustVisit[]`, city-wide text-search resolution, never silently drop when not found.
- modifications go through structured edit ops; the drag-and-drop UI shares the same ops.
- Validator has no scoring: hard constraints block finalize, soft constraints are warnings only.
- generic `AgentSpec<TState>` runtime, self-loop, two exits; reviewer = deterministic Validator.
- persistence JSON → SQLite (hybrid storage), behind the repository.
- mock = adversarial (tests correctness) + realistic (tests good-looking).
