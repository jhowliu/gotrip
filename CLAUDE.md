# gotrip

A travel-planning ReAct agent — the real deliverable is reusable agent-development skill (tool use + multi-step judgment + self-correction), with trip planning as the carrier.

- **Design & rationale:** `DESIGN.md`
- **Product requirements:** `PRD.md`

## Tech stack

- **Language / runtime:** TypeScript (strict) on Node.js LTS.
- **LLM:** `@anthropic-ai/sdk` with a **hand-written** tool-use loop (not the SDK tool runner — we own the loop to see every step). Stream long cold-start turns. Model tiering: `claude-sonnet-4-6` for cold-start planning (with `thinking: { type: "adaptive" }`), `claude-haiku-4-5` for simple warm-start edits, `claude-opus-4-8` as a one-shot escalation when the no-progress detector trips.
- **Validation / schemas:** Zod — runtime validation + inferred types from one source; used for `TripRequest` input, tool-parameter boundary checks (the "tool-layer guard"), and generating tool `input_schema`.
- **Testing:** Vitest. Adversarial JSON fixtures are the regression suite; pure domain functions get exact unit tests.
- **Persistence:** JSON files first (`FileSessionStore`), then `better-sqlite3` (hybrid storage: queryable metadata columns + `Itinerary` JSON blob). Behind the `TripRepository` port.
- **Real APIs (M4):** Google Places / Routes via `fetch`, behind the tool-provider port.
- **HTTP / UI (M5, deferred):** Hono (API) + React (drag-and-drop). Never in the core layers.
- **Tooling:** pnpm, tsx, ESLint, Prettier.

## Architecture — Clean Architecture (dependency rule: dependencies point inward)

The domain knows nothing about Anthropic, Google, SQLite, or the agent loop.

| Layer (inner → outer) | Contents | Depends on |
|---|---|---|
| **Domain / Entities** | `Itinerary` / `ItineraryItem` / `TripRequest` / `ValidationResult` types + pure logic: `validate()`, `clusterByDay()`, `applyEdits()`, timing/buffer rules, category-default table. Zero I/O. | nothing |
| **Application / Use Cases** | `runAgent` (generic runtime), `AgentSpec`, cold/warm planning flows | domain + ports |
| **Interface Adapters / Ports** | `ToolProvider`, `TripRepository`, `ModelClient` interfaces — the test seams | owned by application |
| **Infrastructure** | Anthropic SDK client, Google providers, `FileSessionStore` / `SqliteTripRepository`, CLI/HTTP/UI | implements the ports |

**Key disciplines**

- The Anthropic SDK sits behind a `ModelClient` port — never `import "@anthropic-ai/sdk"` in domain/application. This lets `runAgent` be tested with a stubbed model, isolates SDK drift, and keeps model/provider swaps out of the core.
- Mock and real tool providers both implement `ToolProvider`; the inner layers don't change between M0–M3 (mock) and M4 (Google). This is what makes "mock-first" work.
- `AgentSpec.validate` injection and `ToolDef<TState>` are the dependency-inversion seams.

### Folder layout

```
src/
  domain/            # zero external deps, pure
    itinerary.ts validate.ts clusterByDay.ts applyEdits.ts timing.ts
  application/
    agent/      AgentSpec.ts runAgent.ts
    planning/   coldStart.ts warmEdit.ts
    ports/      ToolProvider.ts TripRepository.ts ModelClient.ts   # seams
  infrastructure/
    llm/         anthropicModelClient.ts
    tools/       mock/ google/
    persistence/ fileSessionStore.ts sqliteTripRepository.ts
  interface/    cli.ts
test/ fixtures/ realistic/ adversarial/
```

M0–M3 run on `infrastructure/tools/mock/`; M4 adds `google/`; M5 swaps in `sqliteTripRepository` + adds `interface/` HTTP/UI — the inner three layers never change.

## Development conventions

- Use the `typescript-best-practices` skill when writing or reviewing TypeScript in this repo — invoke it before non-trivial implementation work (idiomatic types, strictness, module boundaries, error handling).

## Agent skills

### Issue tracker

Issues and PRDs live as GitHub issues in `jhowliu/gotrip` (via the `gh` CLI); external PRs are **not** a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles map to identically-named labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
