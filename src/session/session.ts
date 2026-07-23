/**
 * A Session (D-36): one live agent loop bound to a conversation and a model
 * config. It fully owns its state — the anti-entropy invariant.
 *
 * Phase 2 gave the text-only loop. Phase 3a adds the **tool-execution loop**:
 * when the model calls tools, they run through a gate + the sandbox, results are
 * fed back, and the loop continues until the model yields a final answer.
 * Truncation detection (D-30) and the consecutive-failure circuit breaker (D-32)
 * still apply. The mode/approval gate and editable approvals land in 3b.
 */
import { newId } from "../util/id.js";
import type { ModelConfig } from "../config/types.js";
import type { ChatRequest, LlmDriver, StreamEvent, AssistantResult, ToolCall } from "../llm/types.js";
import { accumulate } from "../llm/stream.js";
import { newConversation, appendEntry } from "../conversation/tree.js";
import { buildWireMessages } from "../conversation/wire.js";
import type { Conversation } from "../conversation/types.js";
import type { Sandbox } from "../tools/sandbox.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolGate } from "../tools/types.js";
import { AllowAllGate } from "../tools/gate.js";
import type { SessionEvent, SessionListener, SessionStatus } from "./types.js";

export interface SessionOptions {
  id?: string;
  config: ModelConfig;
  driver: LlmDriver;
  systemPrompt?: string;
  maxConsecutiveFailures?: number;
  /** Tool support (Phase 3). A registry requires a sandbox. */
  tools?: ToolRegistry;
  sandbox?: Sandbox;
  gate?: ToolGate;
  /** Cap on model↔tool round-trips per user message (runaway guard). */
  maxToolIterations?: number;
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
  private readonly tools: ToolRegistry | undefined;
  private readonly sandbox: Sandbox | undefined;
  private readonly gate: ToolGate;
  private readonly maxToolIterations: number;
  private consecutiveFailures = 0;
  private readonly listeners = new Set<SessionListener>();

  constructor(options: SessionOptions) {
    if (options.tools && !options.sandbox) throw new Error("A tool registry requires a sandbox");
    this.id = options.id ?? newId("sess");
    this.config = options.config;
    this.driver = options.driver;
    this.maxFailures = options.maxConsecutiveFailures ?? 3;
    this.tools = options.tools;
    this.sandbox = options.sandbox;
    this.gate = options.gate ?? new AllowAllGate();
    this.maxToolIterations = options.maxToolIterations ?? 12;
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
        return undefined;
    }
  }

  buildRequest(): ChatRequest {
    const req: ChatRequest = {
      model: this.config.model,
      messages: buildWireMessages(this.conversation, { system: this.systemPrompt }),
    };
    if (this.tools) req.tools = this.tools.defs();
    const s = this.config.sampling;
    if (s?.temperature !== undefined) req.temperature = s.temperature;
    if (s?.topP !== undefined) req.top_p = s.topP;
    if (s?.maxTokens !== undefined) req.max_tokens = s.maxTokens;
    const reasoning = this.reasoningParam();
    if (reasoning) req.reasoning = reasoning;
    return req;
  }

  async send(text: string): Promise<void> {
    if (this.status === "halted") throw new Error("Session is halted (too many consecutive failures).");
    const { conv, entry } = appendEntry(this.conversation, { type: "user", text });
    this.conversation = conv;
    this.emit({ type: "user", entryId: entry.id, text });
    await this.runLoop();
  }

  /** Drive model↔tool round-trips until the model yields a final answer. */
  private async runLoop(): Promise<void> {
    this.status = "running";
    for (let i = 0; i < this.maxToolIterations; i++) {
      const result = await this.oneAssistantTurn();
      if (!result) return; // error/halt already handled and emitted

      if (result.finishReason === "length") {
        // Truncated: any tool-call args are incomplete — do not execute (D-30).
        this.emit({
          type: "truncation",
          message: 'Output hit the max_tokens limit and was cut off. Send "continue" or raise max_tokens.',
        });
        break;
      }
      if (!this.tools || result.toolCalls.length === 0) break; // final answer

      for (const call of result.toolCalls) await this.executeToolCall(call);
      // loop: the model now sees the tool results
    }
    // Reaching here means no error/halt path returned early → back to idle.
    this.status = "idle";
  }

  /** Stream one assistant turn, append it, handle errors. Returns the result or
   *  undefined when an error/halt was handled. */
  private async oneAssistantTurn(): Promise<AssistantResult | undefined> {
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
      return undefined;
    }

    const result = accumulate(events);
    const { conv, entry } = appendEntry(this.conversation, {
      type: "assistant",
      text: result.text,
      toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
      reasoning: result.reasoning,
      reasoningText: result.reasoningText,
      finishReason: result.finishReason,
      truncated: result.finishReason === "length",
      usage: result.usage,
    });
    this.conversation = conv;
    this.consecutiveFailures = 0; // a completed turn resets
    this.emit({
      type: "assistant-end",
      entryId: entry.id,
      finishReason: result.finishReason,
      truncated: result.finishReason === "length",
    });
    return result;
  }

  private appendToolResult(call: ToolCall, content: string, isError: boolean): void {
    const { conv } = appendEntry(this.conversation, {
      type: "tool",
      toolCallId: call.id,
      name: call.function.name,
      content,
      isError,
    });
    this.conversation = conv;
    this.emit({ type: "tool-end", name: call.function.name, isError });
  }

  private async executeToolCall(call: ToolCall): Promise<void> {
    const tool = this.tools?.get(call.function.name);
    if (!tool || !this.sandbox) {
      this.appendToolResult(call, `unknown tool: ${call.function.name}`, true);
      return;
    }

    let args: Record<string, unknown>;
    try {
      args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
    } catch {
      // Truncated/invalid tool-call JSON — never execute (D-30/D-31).
      this.appendToolResult(call, "invalid or truncated tool arguments; not executed", true);
      return;
    }

    const decision = this.gate.check(tool, args);
    if (decision.kind === "deny") {
      this.appendToolResult(call, `denied: ${decision.reason}`, true);
      return;
    }
    if (decision.kind === "prompt") {
      // Interactive approval lands in Phase 3b; treat as not-yet-available here.
      this.appendToolResult(call, "approval required but the approval flow is not wired (Phase 3b)", true);
      return;
    }

    this.emit({ type: "tool-start", name: tool.name });
    const res = await tool.execute(args, { sandbox: this.sandbox });
    this.appendToolResult(call, res.content, res.isError ?? false);
  }
}
