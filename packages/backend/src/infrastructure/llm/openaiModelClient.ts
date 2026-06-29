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
import type { TokenUsage, Tracer } from "../../application/agent/trace";

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

/** OpenAI usage → our neutral TokenUsage. (pure) */
export function mapUsage(
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null | undefined,
): TokenUsage | undefined {
  if (!usage) return undefined;
  const mapped: TokenUsage = {};
  if (typeof usage.prompt_tokens === "number") mapped.promptTokens = usage.prompt_tokens;
  if (typeof usage.completion_tokens === "number") mapped.completionTokens = usage.completion_tokens;
  if (typeof usage.total_tokens === "number") mapped.totalTokens = usage.total_tokens;
  return mapped;
}

export interface OpenAIModelClientOptions {
  apiKey?: string; // defaults to OPENAI_API_KEY
  baseURL?: string;
  /** Logs the OpenAI request, response, and token usage to the trace. */
  tracer?: Tracer;
}

export function createOpenAIModelClient(options: OpenAIModelClientOptions = {}): ModelClient {
  const client = new OpenAI({
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
  });
  const trace = options.tracer;

  return {
    async next(req: ModelRequest): Promise<ModelTurn> {
      const messages = toOpenAIMessages(req.instruction, req.history);
      const tools = toOpenAITools(req.tools);
      trace?.({ type: "model_request", model: req.model, messages, tools });

      let response;
      try {
        response = await client.chat.completions.create({
          model: req.model,
          messages,
          tools,
          tool_choice: "auto",
        });
      } catch (err) {
        trace?.({ type: "model_error", model: req.model, message: err instanceof Error ? err.message : String(err) });
        throw err;
      }

      const message = response.choices[0]?.message;
      trace?.({
        type: "model_response",
        model: response.model,
        output: message ?? null,
        ...(mapUsage(response.usage) ? { usage: mapUsage(response.usage) } : {}),
      });

      if (!message) return { kind: "message", text: "" };
      return fromOpenAIMessage(message);
    },
  };
}
