/**
 * The ModelClient port. The agent runtime depends on this interface, never on
 * `@anthropic-ai/sdk` directly — so `runAgent` is testable with a stub model,
 * SDK drift is isolated, and model/provider swaps stay out of the core.
 *
 * Implementations: ScriptedModelClient (M0, deterministic) and
 * AnthropicModelClient (M1, real Claude tool use).
 */

import type { ModelId } from "../agent/AgentSpec";

export interface ModelToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON schema the model sees
}

export interface ModelToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type ModelTurn =
  | { kind: "tool_use"; text?: string; calls: ModelToolCall[] }
  | { kind: "message"; text: string }; // ended without tool calls

export type HistoryItem =
  | { role: "user"; content: string }
  | { role: "assistant"; turn: ModelTurn }
  | { role: "tool_result"; callId: string; content: string; isError: boolean };

export interface ModelRequest {
  model: ModelId;
  instruction: string;
  tools: ModelToolSpec[];
  history: HistoryItem[];
}

export interface ModelClient {
  next(req: ModelRequest): Promise<ModelTurn>;
}
