/**
 * A Session (D-36): one live agent loop bound to a conversation and a model
 * config. It fully owns its state — the anti-entropy invariant.
 *
 * The loop is a resumable state machine so it can **pause** for approvals
 * (D-08/D-16) and for ask_user (D-18), then **resume**: `send()` runs until the
 * session settles (idle/halted) or needs the user (awaiting-approval /
 * awaiting-input); `approve()` and `answer()` continue it. Truncation (D-30) and
 * the consecutive-failure circuit breaker (D-32) still apply.
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
import type { Tool, ToolGate } from "../tools/types.js";
import { AllowAllGate } from "../tools/gate.js";
import { ASK_USER } from "../tools/ask-user.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  AskUserRequest,
  SessionEvent,
  SessionListener,
  SessionStatus,
} from "./types.js";

export interface SessionOptions {
  id?: string;
  config: ModelConfig;
  driver: LlmDriver;
  systemPrompt?: string;
  maxConsecutiveFailures?: number;
  tools?: ToolRegistry;
  sandbox?: Sandbox;
  gate?: ToolGate;
  maxToolIterations?: number;
}

const BASE_SYSTEM = "You are JLCode, a helpful coding agent.";

type StepOutcome = "done" | "paused-approval" | "paused-input";

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

  // Resumable-loop state.
  private pendingToolCalls: ToolCall[] = [];
  private pendingApproval: { request: ApprovalRequest; call: ToolCall; tool: Tool } | undefined;
  private pendingQuestion: { request: AskUserRequest; call: ToolCall } | undefined;

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

  get awaitingApproval(): ApprovalRequest | undefined {
    return this.pendingApproval?.request;
  }
  get awaitingInput(): AskUserRequest | undefined {
    return this.pendingQuestion?.request;
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

  /** Send a user message and run until the session settles or needs the user. */
  async send(text: string): Promise<void> {
    if (this.status === "halted") throw new Error("Session is halted (too many consecutive failures).");
    if (this.status === "awaiting-approval" || this.status === "awaiting-input") {
      throw new Error("Session is waiting for input; resolve it before sending.");
    }
    const { conv, entry } = appendEntry(this.conversation, { type: "user", text });
    this.conversation = conv;
    this.emit({ type: "user", entryId: entry.id, text });
    this.pendingToolCalls = [];
    await this.advance();
  }

  /** Resolve a pending approval (approve / deny / edit-then-approve) and continue. */
  async approve(decision: ApprovalDecision): Promise<void> {
    const pending = this.pendingApproval;
    if (!pending) throw new Error("No pending approval");
    this.pendingApproval = undefined;
    if (decision.approve) {
      const edited = decision.editedArgs !== undefined;
      await this.doExecute(pending.call, pending.tool, decision.editedArgs ?? pending.request.args, edited);
    } else {
      this.appendToolResult(pending.call, `denied by user${decision.reason ? `: ${decision.reason}` : ""}`, true);
    }
    this.pendingToolCalls.shift();
    await this.advance();
  }

  /** Provide the answer to a pending ask_user and continue. */
  async answer(text: string): Promise<void> {
    const pending = this.pendingQuestion;
    if (!pending) throw new Error("No pending question");
    this.pendingQuestion = undefined;
    this.appendToolResult(pending.call, text, false);
    this.pendingToolCalls.shift();
    await this.advance();
  }

  private async advance(): Promise<void> {
    this.status = "running";
    for (let iter = 0; iter < this.maxToolIterations; iter++) {
      while (this.pendingToolCalls.length > 0) {
        const outcome = await this.tryExecute(this.pendingToolCalls[0]!);
        if (outcome === "paused-approval") {
          this.status = "awaiting-approval";
          return;
        }
        if (outcome === "paused-input") {
          this.status = "awaiting-input";
          return;
        }
        this.pendingToolCalls.shift(); // "done" → dequeue
      }

      const result = await this.oneAssistantTurn();
      if (!result) return; // error/halt already handled

      if (result.finishReason === "length") {
        this.emit({
          type: "truncation",
          message: 'Output hit the max_tokens limit and was cut off. Send "continue" or raise max_tokens.',
        });
        break;
      }
      if (!this.tools || result.toolCalls.length === 0) break; // final answer
      this.pendingToolCalls = [...result.toolCalls];
    }
    this.status = "idle";
  }

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
    this.consecutiveFailures = 0;
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

  /** Attempt to process the front tool call; may pause for approval/input. */
  private async tryExecute(call: ToolCall): Promise<StepOutcome> {
    let args: Record<string, unknown>;
    try {
      args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
    } catch {
      this.appendToolResult(call, "invalid or truncated tool arguments; not executed", true);
      return "done";
    }

    // ask_user is intercepted — it pauses for the user's answer (D-18).
    if (call.function.name === ASK_USER) {
      const question = typeof args.question === "string" ? args.question : "(no question provided)";
      const options = Array.isArray(args.options)
        ? args.options.filter((o): o is string => typeof o === "string")
        : undefined;
      const request: AskUserRequest = { id: newId("ask"), question, ...(options ? { options } : {}) };
      this.pendingQuestion = { request, call };
      this.emit({ type: "awaiting-input", question: request });
      return "paused-input";
    }

    const tool = this.tools?.get(call.function.name);
    if (!tool || !this.sandbox) {
      this.appendToolResult(call, `unknown tool: ${call.function.name}`, true);
      return "done";
    }

    const decision = this.gate.check(tool, args);
    if (decision.kind === "deny") {
      this.appendToolResult(call, `denied: ${decision.reason}`, true);
      return "done";
    }
    if (decision.kind === "prompt") {
      const request: ApprovalRequest = {
        id: newId("appr"),
        tool: tool.name,
        kind: tool.kind,
        args,
        reason: "approval required by policy",
      };
      this.pendingApproval = { request, call, tool };
      this.emit({ type: "awaiting-approval", request });
      return "paused-approval";
    }

    await this.doExecute(call, tool, args, false);
    return "done";
  }

  private async doExecute(
    call: ToolCall,
    tool: Tool,
    args: Record<string, unknown>,
    edited: boolean,
  ): Promise<void> {
    this.emit({ type: "tool-start", name: tool.name });
    const res = await tool.execute(args, { sandbox: this.sandbox! });
    const note = edited ? "[note: the user edited the arguments before running]\n" : "";
    this.appendToolResult(call, note + res.content, res.isError ?? false);
  }
}
