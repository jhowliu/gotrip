# PRD: Travel-planning agent — conversational itinerary core

> Published as [jhowliu/gotrip#1](https://github.com/jhowliu/gotrip/issues/1) with label `ready-for-agent`.
> Source of truth for rationale: `DESIGN.md`. Sliced implementation tasks: issues #2–#7.

## Problem Statement

When planning a multi-day trip, a purely conversational LLM names places that have closed down, misremembers opening hours, estimates travel by "feel" rather than actually computing it, and produces output that can't be saved, modified, or verified. The traveler needs a planning tool that queries real data, actually computes travel times and budgets, self-corrects when it finds a day that is too rushed / over budget / scheduled during closed hours / unable to make the departure flight, and lets them refine the plan in natural language while it stays coherent as a whole.

(Project meta-goal: to practice agent-development skill end to end — tool use + multi-step judgment + self-correction — with trip planning merely as the carrier.)

## Solution

A ReAct agent. The user supplies a few anchors (days, destination, accommodation, must-visits, flights, budget, pace). The agent pins the hard anchors, searches for candidates, verifies travel times and opening hours, clusters and schedules places across days, checks against budget, and gates the result through a deterministic Validator — re-planning itself whenever a hard constraint is violated — then finalizes. Once finished, it enters a conversational phase: the user modifies the plan in natural language, the agent applies the change through structured edit operations, re-validates, and keeps the plan coherent — stopping to report and offer alternatives when an instruction collides with a physical constraint. The entire Phase 3 experience is built first on mock data; real APIs, the database, and the drag-and-drop UI are the outer shell added last.

## User Stories

1. As a traveler, I want to give only a few anchors (days, destination, accommodation), so that I don't have to fill a long form.
2. As a traveler, I want my accommodation treated as each day's start/end anchor, so that the plan radiates from where I'm staying.
3. As a traveler, I want to name must-visit places, so that they are guaranteed to appear regardless of distance.
4. As a traveler, I want to optionally pick a must-visit from an autocomplete (carrying its exact id), so that there is no ambiguity about which location I meant.
5. As a traveler, I want a must-visit given only by name to still be resolved, so that I can plan by typing without precise data.
6. As a traveler, I want to be told clearly when a named must-visit can't be found, so that a hard requirement is never silently dropped.
7. As a traveler, I want to be asked to confirm when a name matches several places, so that the right one is pinned.
8. As a traveler, I want my arrival flight respected, so that day one starts after I actually land.
9. As a traveler, I want the last day to end before my departure flight with airport buffer, so that I don't miss it.
10. As a traveler, I want a budget level honored, so that total cost stays within a hard ceiling.
11. As a traveler, I want a pace preference honored, so that "relaxed" days are less packed than "packed" days.
12. As a traveler, I want candidate attractions and restaurants found near my stay, so that I get relevant options.
13. As a traveler, I want places near a distant must-visit searched appropriately, so that out-there anchors still get good same-day companions.
14. As a traveler, I want real opening hours respected, so that nothing is scheduled when a place is closed.
15. As a traveler, I want real travel times between stops, so that the day is physically doable.
16. As a traveler, I want each stop to have a sensible visit duration, so that the day isn't unrealistically tight or empty.
17. As a traveler, I want travel shown as its own time block with a small buffer, so that the schedule absorbs normal transit variance.
18. As a traveler, I want lunch and dinner placed within sensible windows, so that meals land at meal times.
19. As a traveler, I want each day to keep some slack rather than be filled minute-to-minute, so that the plan is livable.
20. As a traveler, I want the agent to detect when a day is too rushed and rearrange, so that I don't get an impossible plan.
21. As a traveler, I want the agent to detect when the plan is over budget and adjust, so that I stay within my limit.
22. As a traveler, I want the agent to rearrange when something is scheduled in closed hours, so that the plan is valid.
23. As a traveler, when no fully valid plan is possible within limits, I want a best-effort partial plan plus a clear explanation of what couldn't be satisfied and an invitation to relax a constraint, so that I'm never given a fake-valid plan or a crash.
24. As a traveler, I want to modify the finished itinerary in natural language, so that I can refine it conversationally.
25. As a traveler, I want to move an item to another day or time, so that I can reshape the plan.
26. As a traveler, I want to add a place, remove an item, change a stay duration, or pin something, so that I have full editing control by conversation.
27. As a traveler, I want my instruction to override soft preferences, so that the plan follows my intent.
28. As a traveler, when my instruction collides with a physical constraint, I want the agent to stop and offer the closest workable alternative, so that I decide the trade-off.
29. As a traveler, I want edits to only recompute what's affected, so that changes are fast and the rest is untouched.
30. As a traveler, I want soft issues surfaced as informational warnings rather than endless re-optimization, so that I stay in control of refinements.
31. As a traveler, I want to resume a session later and continue editing the same itinerary, so that my work persists.
32. As a traveler, I want the final plan as readable text and structured data, so that I can read it and later put it on a map.
33. As a developer, I want the agent runtime to be a reusable spec (instruction, model, constraints, tools, validate), so that the skill transfers to other "fetch + multi-step + judge" problems.
34. As a developer, I want tools injected behind one interface, so that I can run the whole agent on fixtures with zero API cost.
35. As a developer, I want adversarial fixtures that each trip one constraint, so that self-correction is actually exercised and regression-tested.
36. As a developer, I want a realistic fixture recorded from real API responses, so that I have a smoke test and learn the real response shape before wiring real APIs.
37. As a developer, I want the loop bounded (max LLM turns, token ceiling, runtime, per-tool caps, no-progress detection), so that it can't run away or rack up cost.
38. As a developer, I want validation at the tool boundary and as a finalize gate, so that the agent self-corrects early and can never finalize an invalid plan.
39. As a developer, I want cheaper models for simple edit turns and a stronger model only when stuck, so that cost matches difficulty.
40. As a developer, I want persistence hidden behind a repository interface, so that swapping JSON files for SQLite never touches agent logic.
41. As a traveler (future), I want to drag-and-drop items directly, so that I can edit without typing — using the same edit operations under the hood.

## Implementation Decisions

**Architecture (B: fat agent + thin tools).** The LLM is the planning subject; deterministic code and APIs supply facts and gate results. Algorithms are advisory tools, not a fixed pipeline.

**Agent runtime — generic, reusable.** `runAgent` executes a hand-written ReAct loop over an `AgentSpec<TState>` carrying `instruction`, `model`, `constraints` (maxIterations, maxTokens, runtimeMs), `tools` (read/mutate a shared `TState`), `initialState`, and an injected `validate(state) → ValidationResult`. The runtime owns loop mechanics and is domain-agnostic; here `TState = Itinerary`. Uses Claude native tool use; tool calls may batch per turn (**iterations count LLM turns, not tool calls**).

**Two run modes, routed in code (not by the LLM):** cold-start (no existing itinerary → full planning from `TripRequest`) vs warm-start (existing itinerary → short edit loop seeded with current `Itinerary` JSON + new instruction; transcript not replayed).

**Two validation layers + two exits.** Tool-boundary checks reject illegal operations inline with readable errors (agent self-corrects via normal ReAct); a finalize gate blocks completion while `hardViolations` is non-empty and feeds violations back. Exits: clean (validate passes) or budget-exhausted (partial result + named unmet hard constraints + invitation to relax). Never emit a fake-valid plan; never crash.

**Reviewer = deterministic Validator** (not a second LLM). An LLM critic is reserved for purely subjective quality later and must not drive re-planning.

**Validator (no scoring).** `ValidationResult = { hardViolations, softWarnings }`; each `Violation` has `code`, optional `dayIndex`/`itemId`, human-readable `message`, and `source` of `"user_instruction" | "constraint"`. Stop rule: hard constraints pass → finalize. Hard constraints: must-visits present, day count = `days`, no scheduling in closed hours, last day ends before departure with airport buffer, total cost ≤ hard ceiling. Soft constraints are generation guidance + post-hoc warnings, never an objective function. User instruction overrides soft; on collision with a physical hard constraint the agent reports + offers alternatives.

**Data model.** `Itinerary { request, days[], totalCost? }`; `ItineraryDay { dayIndex, items[] }`; `ItineraryItem { itemId (stable), kind: visit|meal|transit, placeId?, name, startTime, durationMinutes, mode?, mealWindow?, pinned?, estimatedCost? }`. Single time source: store `startTime + durationMinutes`, derive `endTime`. Transit is a first-class item. Day validity: each item's `startTime ≥ previous item's endTime`.

**Input model.** `TripRequest` per `DESIGN.md`, except `mustVisit: MustVisit[]` where `MustVisit = { name, placeId?, location? }`. Soft preferences stay out of the form (handled conversationally).

**Tools & search ranges.** Four tools (`searchPlaces`, `getPlaceDetails`, `getTravelTime`, `estimateCost`) chained by `placeId`. Three search scopes: (1) must-visit name resolution = city-wide text search (`"{name} {destination}"`, accommodation as bias only, no small radius); (2) companion search around a pinned far must-visit ≈ 1.5–2.5km; (3) general exploration around accommodation ≈ 3–5km. Must-visit resolution priority: `placeId` → `location` → name text-search (ambiguous → confirm; not found → actionable error, never silent drop).

**Grouping & timing.** `clusterByDay` produces a draft using free haversine distance (no travel API); `getTravelTime` is called only to verify same-day adjacent legs. Intra-day ordering by the LLM (small N). Transit time = estimate + per-leg buffer (no timetable modeling); flight-catching legs use a conservative buffer and are hard. Visit duration = `estimatedVisitMinutes` → category-default table → 60-min fallback; no per-item padding — slack lives at the day level via a pace-driven fill ratio (relaxed ≈70%, packed ≈90%). Meals: lunch + dinner by default (breakfast skipped, configurable) within `mealWindow`; meal timing is soft.

**Editing.** Mutations go through structured `applyEdits({ operations })` with ops `move | add | remove | setDuration | pin`, each validated; returns `{ itinerary, validation }`. Edits recompute only affected legs. Same operations back the future drag-and-drop UI; direct edits are literal (no silent auto-rearrange).

**Cost/guardrail bounds (starting values, tuned after measurement).** Per-cold-start caps: `searchPlaces ≤ 6` (maxResults ≤ 10), `getPlaceDetails ≤ 20` (triage from cheap search summaries first), `getTravelTime ≤ 30`. Cold/warm: maxIterations 25/8, token ~150k/~40k, runtime 60s/20s; `applyEdits ≤ 10` warm. Hitting a per-tool cap returns a readable error (agent finishes with existing candidates), not failure. No-progress detection via `progressSignal = (itinerary hash, fetched-data count, recent tool-call set)`: stuck if unchanged 3 turns, or same `(tool,args)` repeated 3×, or identical `hardViolations` returned 3× after re-plan.

**Model tiering.** Sonnet 4.6 default (cold-start); Haiku 4.5 for simple warm-start edits; Opus 4.8 only as a one-shot escalation when the no-progress detector trips, before graceful exit.

**Persistence.** `TripRepository` interface (`load`, `save`, later `listTopTrips`); `FileSessionStore` (per-session JSON) first. Upgrade to SQLite only when top-trips listing/search, undo history, or multi-session is needed — then as hybrid storage: queryable metadata columns + full `Itinerary` as a JSON blob (no normalizing the tree). Agent logic never knows the storage layer exists.

## Testing Decisions

**What makes a good test here:** assert on external behavior and invariants, not internals. For the agent loop the LLM is non-deterministic, so assert properties — itinerary is hard-valid, must-visits present, day count correct, last day clears departure buffer, or graceful-exit-with-explanation when a fixture is unsatisfiable — never exact wording or step sequence. Pure functions get exact, deterministic assertions.

**Seams (1 integration + 3 pure-function + 1 substitution):**
- **`runAgent` (primary integration seam)** — driven end-to-end with injected mock tool providers + the adversarial/realistic fixtures. Each adversarial fixture (narrow opening hours, far-apart must-visits, flight-buffer squeeze, missing `estimatedVisitMinutes`) is a regression case asserting detect-and-resolve (or graceful exit). Realistic fixture = smoke test.
- **`validate`** — fixture itineraries → expected violation codes and `source`.
- **`clusterByDay`** — place sets → expected day groupings (pinned respected, far points separated).
- **`applyEdits`** — (itinerary, ops) → expected mutated itinerary + validation, incl. illegal-op rejection and "only affected legs recomputed."
- **Tool interface (substitution seam)** — real providers swapped for fixture providers so the suite runs at zero API cost; realistic fixture recorded once and replayed.

**Not tested directly:** internal loop mechanics, model-call plumbing, history formatting.

**Prior art:** none yet (greenfield). The fixture-injection-at-the-tool-interface pattern is established by this PRD as the project convention.

## Out of Scope

- **Real API integration (M4)** — Google Places/Routes wiring, geocoding, rate-limit/error handling; same Tool interface, deferred until agent logic is proven on mock.
- **Database & productization (M5)** — SQLite/`listTopTrips`, drag-and-drop UI, map rendering.
- **Real-time data / live transit** — weather/ticket alerts at most, later; explicitly no bus-headway or timetable engine.
- **LLM-as-judge subjective scoring** and any soft-constraint optimization loop / numeric `softScore`.
- **Soft preferences in the initial form** — handled conversationally post-plan.
- **Multi-user accounts, sharing, auth.**

## Further Notes

- Build order: M0 skeleton loop → M1 self-correction with adversarial fixtures (≈80% of the learning) → M2 edit ops + file persistence + two-mode routing → M3 conversational modification (Phase 3 endpoint, still mock) → M4 real APIs → M5 DB/UI. Deliberate inversion vs. the original plan: real APIs move from "early" to "second-to-last," because agent intelligence depends on data *shape*, not data *reality*.
- Guardrail numbers are starting points; measure turn/token distributions on real runs and tune.
- Keep the runtime abstraction at exactly the level justified by one real consumer (travel) + the reusable-skill meta-goal; resist generic DAG/multi-validator machinery until a second consumer exists.
- Full design rationale: `DESIGN.md`.
