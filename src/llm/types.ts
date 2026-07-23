/**
 * OpenAI-compatible chat types as OpenRouter exposes them, plus the streaming
 * event shape our thin client emits. `reasoning_details` is carried **opaquely**
 * and round-tripped verbatim (D-14) — we never interpret it.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
}

export interface ChatMessage {
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  /** Opaque provider reasoning, replayed byte-for-byte (D-14). */
  reasoning_details?: unknown;
  /** Prompt-cache breakpoint marker (D-26); mapped to the provider field on send. */
  cache_control?: { type: "ephemeral" };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  /** OpenRouter reasoning control (effort or on/off). */
  reasoning?: Record<string, unknown>;
}

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "reasoning_details"; value: unknown }
  | { type: "tool_call"; index: number; id?: string; name?: string; argsDelta?: string }
  | { type: "finish"; reason: string }
  | { type: "usage"; usage: Usage };

export interface AssistantResult {
  text: string;
  reasoningText?: string;
  /** Verbatim `reasoning_details` for replay (D-14). */
  reasoning?: unknown;
  toolCalls: ToolCall[];
  finishReason: string;
  usage?: Usage;
}

/** The one thing a session needs from the model — injectable for tests (D-24). */
export interface LlmDriver {
  streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, unknown>;
}
