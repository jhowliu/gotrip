import { describe, expect, it } from "vitest";
import OpenAI from "openai";
import {
  fromOpenAIMessage,
  mapUsage,
  toOpenAIMessages,
  toOpenAITools,
} from "../src/infrastructure/llm/openaiModelClient";
import type { HistoryItem, ModelToolSpec } from "../src/application/ports/ModelClient";

describe("OpenAIModelClient translation (pure)", () => {
  it("maps neutral history to OpenAI messages", () => {
    const history: HistoryItem[] = [
      { role: "user", content: "plan it" },
      {
        role: "assistant",
        turn: { kind: "tool_use", calls: [{ id: "c1", name: "searchPlaces", input: { query: "x" } }] },
      },
      { role: "tool_result", callId: "c1", content: "[]", isError: false },
    ];

    const messages = toOpenAIMessages("be helpful", history);

    expect(messages[0]).toEqual({ role: "system", content: "be helpful" });
    expect(messages[1]).toEqual({ role: "user", content: "plan it" });

    const assistant = messages[2] as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;
    expect(assistant.role).toBe("assistant");
    expect(assistant.tool_calls?.[0]).toMatchObject({
      id: "c1",
      type: "function",
      function: { name: "searchPlaces", arguments: JSON.stringify({ query: "x" }) },
    });

    expect(messages[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "[]" });
  });

  it("maps tool specs to OpenAI function tools", () => {
    const specs: ModelToolSpec[] = [
      { name: "searchPlaces", description: "search", inputSchema: { type: "object" } },
    ];
    const tools = toOpenAITools(specs);
    expect(tools[0]).toEqual({
      type: "function",
      function: { name: "searchPlaces", description: "search", parameters: { type: "object" } },
    });
  });

  it("turns an OpenAI tool-call response into a tool_use turn", () => {
    const message = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c9",
          type: "function",
          function: { name: "clusterByDay", arguments: "{}" },
        },
      ],
    } as unknown as OpenAI.Chat.Completions.ChatCompletionMessage;

    const turn = fromOpenAIMessage(message);
    expect(turn.kind).toBe("tool_use");
    if (turn.kind === "tool_use") {
      expect(turn.calls).toEqual([{ id: "c9", name: "clusterByDay", input: {} }]);
    }
  });

  it("turns a plain OpenAI message into a message turn", () => {
    const message = {
      role: "assistant",
      content: "done",
    } as unknown as OpenAI.Chat.Completions.ChatCompletionMessage;

    const turn = fromOpenAIMessage(message);
    expect(turn).toEqual({ kind: "message", text: "done" });
  });

  it("maps OpenAI usage to neutral TokenUsage", () => {
    expect(mapUsage({ prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 })).toEqual({
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 150,
    });
    expect(mapUsage(null)).toBeUndefined();
    expect(mapUsage(undefined)).toBeUndefined();
  });
});
