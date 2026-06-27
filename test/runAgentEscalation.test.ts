import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentSpec } from "../src/application/agent/AgentSpec";
import type { ModelClient } from "../src/application/ports/ModelClient";
import type { TraceEvent } from "../src/application/agent/trace";
import { runAgent } from "../src/application/agent/runAgent";

interface MiniState {
  done: boolean;
}

function makeSpec(withEscalation: boolean): AgentSpec<MiniState> {
  return {
    instruction: "noop until escalated",
    kickoff: "go",
    model: "cheap",
    ...(withEscalation ? { escalationModel: "strong" } : {}),
    constraints: { maxIterations: 20 },
    tools: [
      {
        name: "noop",
        description: "does nothing (stalls)",
        inputSchema: z.object({}).passthrough(),
        execute: () => ({ content: { progressed: false } }),
      },
      {
        name: "finish",
        description: "finish",
        inputSchema: z.object({}).passthrough(),
        execute: (_input, state: MiniState) => {
          state.done = true;
          return { content: { ok: true }, final: true };
        },
      },
    ],
    initialState: { done: false },
    validate: () => ({ hardViolations: [], softWarnings: [] }),
  };
}

/** Stalls (repeats noop) on the cheap model; finishes once handed the strong model. */
function stallThenFinish(strongId: string): ModelClient {
  let n = 0;
  return {
    async next(req) {
      const id = `c${(n += 1)}`;
      if (req.model === strongId) return { kind: "tool_use", calls: [{ id, name: "finish", input: {} }] };
      return { kind: "tool_use", calls: [{ id, name: "noop", input: {} }] };
    },
  };
}

describe("runAgent one-shot escalation", () => {
  it("escalates to the stronger model when no progress is made, and it resolves the run", async () => {
    const events: TraceEvent[] = [];
    const result = await runAgent(makeSpec(true), stallThenFinish("strong"), (e) => events.push(e));

    expect(result.status).toBe("ok");
    expect(result.state.done).toBe(true);
    expect(events.some((e) => e.type === "escalation" && e.to === "strong")).toBe(true);
  });

  it("without an escalation model, a stall stops the run", async () => {
    const result = await runAgent(makeSpec(false), stallThenFinish("strong"));
    expect(result.status).toBe("stopped");
    expect(result.state.done).toBe(false);
  });
});
