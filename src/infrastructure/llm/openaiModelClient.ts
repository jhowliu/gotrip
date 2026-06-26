/**
 * OpenAIModelClient — a real LLM behind the ModelClient port, using OpenAI
 * chat-completions function calling. We use OpenAI's *model* API only; the agent
 * loop stays ours (runAgent). The OpenAI Agents SDK — which would own the loop —
 * is deliberately not used (it contradicts the "own the loop" meta-goal).
 *
 * domain / application / runAgent / tools are untouched: this just translates our
 * provider-neutral types ↔ OpenAI's function-calling shapes.
 */

import OpenAI from "openai";

import type {
  HistoryItem,
  ModelClient,
  ModelRequest,
  ModelToolSpec,
  ModelTurn,
} from "../../application/ports/ModelClient";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;
type ChatResponseMessage = OpenAI.Chat.Completions.ChatCompletionMessage;

/** Our neutral history → OpenAI messages. (pure) */
export function toOpenAIMessages(instruction: string, history: HistoryItem[]): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: instruction }];

  for (const entry of history) {
    if (entry.role === "user") {
      messages.push({ role: "user", content: entry.content });
    } else if (entry.role === "tool_result") {
      messages.push({ role: "tool", tool_call_id: entry.callId, content: entry.content });
    } else {
      // assistant turn
      const turn = entry.turn;
      if (turn.kind === "tool_use") {
        messages.push({
          role: "assistant",
          content: turn.text ?? null,
          tool_calls: turn.calls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
          })),
        });
      } else {
        messages.push({ role: "assistant", content: turn.text });
      }
    }
  }

  return messages;
}

/** Our tool specs → OpenAI function tools. (pure) */
export function toOpenAITools(tools: ModelToolSpec[]): ChatTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

function safeParseArgs(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** OpenAI response message → our neutral ModelTurn. (pure) */
export function fromOpenAIMessage(message: ChatResponseMessage): ModelTurn {
  const toolCalls = (message.tool_calls ?? []).filter((tc) => tc.type === "function");
  if (toolCalls.length > 0) {
    const turn: ModelTurn = {
      kind: "tool_use",
      calls: toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        input: safeParseArgs(tc.function.arguments),
      })),
    };
    if (message.content) turn.text = message.content;
    return turn;
  }
  return { kind: "message", text: message.content ?? "" };
}

export interface OpenAIModelClientOptions {
  apiKey?: string; // defaults to OPENAI_API_KEY
  baseURL?: string;
}

export function createOpenAIModelClient(options: OpenAIModelClientOptions = {}): ModelClient {
  const client = new OpenAI({
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
  });

  return {
    async next(req: ModelRequest): Promise<ModelTurn> {
      const response = await client.chat.completions.create({
        model: req.model,
        messages: toOpenAIMessages(req.instruction, req.history),
        tools: toOpenAITools(req.tools),
        tool_choice: "auto",
      });

      const message = response.choices[0]?.message;
      if (!message) return { kind: "message", text: "" };
      return fromOpenAIMessage(message);
    },
  };
}
