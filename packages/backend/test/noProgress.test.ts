import { describe, expect, it } from "vitest";
import { runAgent } from "../src/application/agent/runAgent";
import type { AgentSpec } from "../src/application/agent/AgentSpec";
import type { ModelClient } from "../src/application/ports/ModelClient";

interface EmptyState {
  value: number;
}

function emptySpec(): AgentSpec<EmptyState> {
  return {
    instruction: "",
    kickoff: "",
    model: "gpt-4o-mini",
    constraints: { maxIterations: 30 },
    tools: [],
    initialState: { value: 0 },
    validate: () => ({ hardViolations: [], softWarnings: [] }),
  };
}

describe("runAgent guardrails", () => {
  it("halts (no progress) when the model repeats the identical turn", async () => {
    const stuck: ModelClient = {
      async next() {
        return { kind: "tool_use", calls: [{ id: "x", name: "noop", input: { q: 1 } }] };
      },
    };
    const result = await runAgent(emptySpec(), stuck);
    expect(result.status).toBe("stopped");
    expect(result.iterations).toBeLessThan(30); // halted early, not at maxIterations
  });

  it("respects the runtime ceiling", async () => {
    const spec = emptySpec();
    spec.constraints.runtimeMs = 0; // already exceeded on the first check
    const everChanging: ModelClient = (() => {
      let n = 0;
      return {
        async next() {
          n += 1;
          return { kind: "tool_use", calls: [{ id: `c${n}`, name: "noop", input: { n } }] };
        },
      };
    })();
    const result = await runAgent(spec, everChanging);
    expect(result.status).toBe("budget_exhausted");
  });
});
