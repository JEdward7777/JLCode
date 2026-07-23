/**
 * A Session (D-36): one live agent loop bound to a conversation and a model
 * config. It fully owns its state — the anti-entropy invariant. Phase 2 is a
 * text-only walking skeleton: send → stream → append. Tool execution arrives
 * in Phase 3. Includes truncation detection (D-30) and the consecutive-failure
 * circuit breaker (D-32).
 */
import { newId } from "../util/id.js";
import type { ModelConfig } from "../config/types.js";
import type { ChatRequest, LlmDriver, StreamEvent } from "../llm/types.js";
import { accumulate } from "../llm/stream.js";
import { newConversation, appendEntry } from "../conversation/tree.js";
import { buildWireMessages } from "../conversation/wire.js";
import type { Conversation } from "../conversation/types.js";
import type { SessionEvent, SessionListener, SessionStatus } from "./types.js";

export interface SessionOptions {
  id?: string;
  config: ModelConfig;
  driver: LlmDriver;
  systemPrompt?: string;
  maxConsecutiveFailures?: number;
}

const BASE_SYSTEM = "You are JLCode, a helpful coding agent.";

export class Session {
  readonly id: string;
  readonly config: ModelConfig;
  conversation: Conversation;
  status: SessionStatus = "idle";

  private readonly driver: LlmDriver;
  private readonly systemPrompt: string;
  private readonly maxFailures: number;
  private consecutiveFailures = 0;
  private readonly listeners = new Set<SessionListener>();

  constructor(options: SessionOptions) {
    this.id = options.id ?? newId("sess");
    this.config = options.config;
    this.driver = options.driver;
    this.maxFailures = options.maxConsecutiveFailures ?? 3;
    const addendum = options.config.systemPromptAddendum?.trim();
    const base = options.systemPrompt ?? BASE_SYSTEM;
    this.systemPrompt = addendum ? `${base}\n\n${addendum}` : base;
    this.conversation = newConversation();
  }

  onEvent(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: SessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private reasoningParam(): Record<string, unknown> | undefined {
    switch (this.config.reasoningEffort) {
      case "low":
      case "medium":
      case "high":
        return { effort: this.config.reasoningEffort };
      case "none":
        return { enabled: false };
      default:
        return undefined; // adaptive / unset → provider default
    }
  }

  buildRequest(): ChatRequest {
    const req: ChatRequest = {
      model: this.config.model,
      messages: buildWireMessages(this.conversation, { system: this.systemPrompt }),
    };
    const s = this.config.sampling;
    if (s?.temperature !== undefined) req.temperature = s.temperature;
    if (s?.topP !== undefined) req.top_p = s.topP;
    if (s?.maxTokens !== undefined) req.max_tokens = s.maxTokens;
    const reasoning = this.reasoningParam();
    if (reasoning) req.reasoning = reasoning;
    return req;
  }

  /** Send a user message and run one assistant turn. */
  async send(text: string): Promise<void> {
    if (this.status === "halted") throw new Error("Session is halted (too many consecutive failures).");
    const { conv, entry } = appendEntry(this.conversation, { type: "user", text });
    this.conversation = conv;
    this.emit({ type: "user", entryId: entry.id, text });
    await this.runTurn();
  }

  private async runTurn(): Promise<void> {
    this.status = "running";
    const req = this.buildRequest();
    const events: StreamEvent[] = [];
    this.emit({ type: "assistant-start" });

    try {
      for await (const ev of this.driver.streamChat(req)) {
        events.push(ev);
        if (ev.type === "text") this.emit({ type: "text", delta: ev.delta });
        else if (ev.type === "reasoning") this.emit({ type: "reasoning", delta: ev.delta });
      }
    } catch (err) {
      this.consecutiveFailures++;
      this.emit({ type: "error", message: (err as Error).message });
      if (this.consecutiveFailures >= this.maxFailures) {
        this.status = "halted";
        this.emit({ type: "halted", reason: `${this.consecutiveFailures} consecutive failures` });
      } else {
        this.status = "idle";
      }
      return;
    }

    const result = accumulate(events);
    const truncated = result.finishReason === "length";
    const { conv, entry } = appendEntry(this.conversation, {
      type: "assistant",
      text: result.text,
      toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
      reasoning: result.reasoning,
      reasoningText: result.reasoningText,
      finishReason: result.finishReason,
      truncated,
      usage: result.usage,
    });
    this.conversation = conv;
    this.consecutiveFailures = 0; // a completed turn (even truncated) resets

    this.emit({ type: "assistant-end", entryId: entry.id, finishReason: result.finishReason, truncated });
    if (truncated) {
      // D-30: detected and surfaced, never silent. Recovery in P2 is manual
      // ("continue"); re-express-as-text continuation lands with tool support.
      this.emit({
        type: "truncation",
        message: 'Output hit the max_tokens limit and was cut off. Send "continue" or raise max_tokens.',
      });
    }
    this.status = "idle";
  }
}
