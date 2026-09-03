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
  /** Authoritative spend for this call in USD, when the provider reports it
   *  (OpenRouter `usage.cost` with `usage:{include:true}`) — honors cache
   *  discounts natively (D-33). Absent for the fake driver → we fall back to
   *  config pricing. */
  costUsd?: number;
}

/**
 * A piece of a multi-part message body. Only `user` messages ever carry parts
 * (D-78f), and only because they have to: the OpenAI/OpenRouter wire **rejects**
 * image content inside a `role:"tool"` message ("tool message content only
 * supports text content"), so a tool that reads an image answers its
 * `tool_call_id` with text and the bytes ride in a following `user` message.
 * That one fact is what keeps `system`/`assistant`/`tool` content a bare string
 * everywhere — including on disk (D-37) — instead of parts end to end.
 *
 * `image_url.url` is a `data:` URI (`data:image/png;base64,…`); JLCode never
 * sends an http URL, because the model fetching a URL is a different trust story
 * than us handing it bytes we already read through the fence.
 */
export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image_url";
  image_url: { url: string };
}

export type ContentPart = TextPart | ImagePart;

export interface ChatMessage {
  role: Role;
  /** Parts only on `user`, and only for attachments (D-78f). Everything else —
   *  and every text-only user turn — stays a bare string, which is also what
   *  keeps `requestSignature` (D-24) hashing the same bytes it always did. */
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  /** Opaque provider reasoning, replayed byte-for-byte (D-14). */
  reasoning_details?: unknown;
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
  /** Tool-selection control. `"none"` forbids tool calls — used by the compaction
   *  summary request so the model only writes prose (D-29). */
  tool_choice?: "none" | "auto" | "required";
  /** OpenRouter provider routing. Set to pin a conversation to the backend that
   *  minted the reasoning signatures already in its history (D-49/H-02):
   *  `allow_fallbacks:false` makes the pin binding rather than advisory. */
  provider?: { order: string[]; allow_fallbacks: boolean };
}

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "reasoning_details"; value: unknown }
  | { type: "tool_call"; index: number; id?: string; name?: string; argsDelta?: string }
  | { type: "finish"; reason: string }
  | { type: "provider"; name: string }
  | { type: "usage"; usage: Usage };

export interface AssistantResult {
  text: string;
  reasoningText?: string;
  /** Verbatim `reasoning_details` for replay (D-14). */
  reasoning?: unknown;
  toolCalls: ToolCall[];
  finishReason: string;
  /** Which backend OpenRouter actually routed to (its top-level `provider`),
   *  recorded so later turns can pin to it (D-49/H-02). */
  provider?: string;
  usage?: Usage;
}

/** Per-call options a driver may honor. `signal` lets a global Stop abort an
 *  in-flight request mid-stream (D-34); drivers may ignore it. */
export interface StreamOptions {
  signal?: AbortSignal;
}

/** The one thing a session needs from the model — injectable for tests (D-24). */
export interface LlmDriver {
  streamChat(req: ChatRequest, opts?: StreamOptions): AsyncGenerator<StreamEvent, void, unknown>;
}
