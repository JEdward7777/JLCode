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
import path from "node:path";
import { newId } from "../util/id.js";
import type { ApprovalPolicy, Mode, ModelConfig } from "../config/types.js";
import type { ChatRequest, LlmDriver, StreamEvent, AssistantResult, ToolCall } from "../llm/types.js";
import { accumulate } from "../llm/stream.js";
import { newConversation, appendEntry, setActiveLeaf as treeSetActiveLeaf, type EntryInput } from "../conversation/tree.js";
import { buildWireMessages } from "../conversation/wire.js";
import type { Conversation, Entry } from "../conversation/types.js";
import type { Sandbox } from "../tools/sandbox.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { Tool, ToolGate } from "../tools/types.js";
import { AllowAllGate } from "../tools/gate.js";
import { ASK_USER } from "../tools/ask-user.js";
import { computeCost } from "./spend.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  AskUserAnswer,
  AskUserQuestion,
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
  /** A static gate (tests). For a live-switchable gate, pass `buildGate`. */
  gate?: ToolGate;
  /** Build a gate from a mode + approval policy, so the session can re-gate
   *  itself when the user switches mode/approval at runtime (D-07/D-08). */
  buildGate?: (mode: Mode, approval: ApprovalPolicy) => ToolGate;
  /** Initial mode/approval (default from the config). Reported + re-gated live. */
  mode?: Mode;
  approval?: ApprovalPolicy;
  maxToolIterations?: number;
  /** Called when the user chooses "remember this root" (D-19) — to persist it. */
  onAddRoot?: (dir: string) => void;
  /** Resume from an existing (loaded) conversation instead of a fresh one. */
  conversation?: Conversation;
  /** Initial whole-tree spend cap in USD (D-33). Breach → no further LLM call. */
  spendCapUsd?: number;
}

const BASE_SYSTEM = "You are JLCode, a helpful coding agent.";

type StepOutcome = "done" | "paused-approval" | "paused-input";

const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;

/** Normalize ask_user tool args into a form spec: the structured `questions`
 *  array when present, else the single-question convenience, else a placeholder. */
function parseAskQuestions(args: Record<string, unknown>): AskUserQuestion[] {
  if (Array.isArray(args.questions)) {
    const out: AskUserQuestion[] = [];
    for (const raw of args.questions) {
      if (!raw || typeof raw !== "object") continue;
      const o = raw as Record<string, unknown>;
      if (typeof o.question !== "string") continue;
      const q: AskUserQuestion = { question: o.question };
      if (typeof o.header === "string") q.header = o.header;
      const opts = strings(o.options);
      if (opts) q.options = opts;
      if (o.multiSelect === true) q.multiSelect = true;
      if (o.allowFreeText === true) q.allowFreeText = true;
      out.push(q);
    }
    if (out.length > 0) return out;
  }
  const single: AskUserQuestion = {
    question: typeof args.question === "string" ? args.question : "(no question provided)",
  };
  const opts = strings(args.options);
  if (opts) single.options = opts;
  return [single];
}

/** Turn an answer payload into the tool-result string the model reads. A bare
 *  string (single-question) passes through verbatim; an array is rendered as a
 *  labeled block so multi-question answers stay unambiguous. */
function formatAnswers(payload: string | AskUserAnswer[]): string {
  if (typeof payload === "string") return payload;
  if (payload.length === 1) return payload[0]!.answer;
  return (
    "The user answered:\n" +
    payload.map((a) => `- ${a.header ? `${a.header} — ` : ""}${a.question}: ${a.answer}`).join("\n")
  );
}

export class Session {
  readonly id: string;
  readonly config: ModelConfig;
  conversation: Conversation;
  status: SessionStatus = "idle";
  /** Live capability mode + approval policy (D-07/D-08), switchable at runtime. */
  mode: Mode;
  approval: ApprovalPolicy;
  /** Whole-tree spend so far, in USD (D-33) — sum over every model call charged
   *  to this conversation; only grows (fork/rewind don't refund). */
  spendUsd = 0;
  /** Optional spend cap (D-33); at/over it, no further LLM call is made. */
  spendCapUsd: number | undefined;
  /** True once a cap breach has blocked the next LLM call, until the cap is
   *  raised. Nothing is killed — the loop just declines to continue (D-33). */
  capReached = false;

  private readonly driver: LlmDriver;
  private readonly systemPrompt: string;
  private readonly maxFailures: number;
  private readonly tools: ToolRegistry | undefined;
  private readonly sandbox: Sandbox | undefined;
  private gate: ToolGate;
  private readonly buildGate: ((mode: Mode, approval: ApprovalPolicy) => ToolGate) | undefined;
  private readonly maxToolIterations: number;
  private readonly onAddRoot: ((dir: string) => void) | undefined;
  private consecutiveFailures = 0;
  private readonly pricing: ModelConfig["pricing"];
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
    this.mode = options.mode ?? options.config.defaultMode;
    this.approval = options.approval ?? options.config.defaultApproval;
    this.buildGate = options.buildGate;
    this.gate = options.buildGate
      ? options.buildGate(this.mode, this.approval)
      : (options.gate ?? new AllowAllGate());
    this.maxToolIterations = options.maxToolIterations ?? 12;
    this.onAddRoot = options.onAddRoot;
    const addendum = options.config.systemPromptAddendum?.trim();
    const base = options.systemPrompt ?? BASE_SYSTEM;
    this.systemPrompt = addendum ? `${base}\n\n${addendum}` : base;
    this.conversation = options.conversation ?? newConversation();
    this.pricing = options.config.pricing;
    this.spendCapUsd = options.spendCapUsd;
    // Whole-tree spend survives resume: recompute from the stored usage of every
    // assistant entry across all branches (D-33), then grow it per new turn.
    this.spendUsd = this.conversation.entries.reduce(
      (sum, e) => (e.type === "assistant" ? sum + computeCost(e.usage, this.pricing) : sum),
      0,
    );
  }

  /** Set / raise / clear the spend cap (D-33). Raising above current spend after
   *  a breach clears the block and resumes the paused loop; nothing is killed. */
  async setSpendCap(capUsd: number | null): Promise<void> {
    this.spendCapUsd = capUsd ?? undefined;
    this.emit({ type: "cap", capUsd });
    if (this.capReached && !this.capBlocked()) {
      this.capReached = false;
      await this.advance(); // resume where the breach paused us
    }
  }

  /** At/over the cap → the next LLM call is declined (D-33). */
  private capBlocked(): boolean {
    return this.spendCapUsd !== undefined && this.spendUsd >= this.spendCapUsd;
  }

  /** Switch capability mode and/or approval policy for this live session and
   *  re-gate future tool calls (D-07/D-08). Persisting the config default is the
   *  caller's concern; the session just re-gates and announces the change. */
  setModeApproval(mode?: Mode, approval?: ApprovalPolicy): void {
    if (mode !== undefined) this.mode = mode;
    if (approval !== undefined) this.approval = approval;
    if (this.buildGate) this.gate = this.buildGate(this.mode, this.approval);
    this.emit({ type: "mode", mode: this.mode, approval: this.approval });
  }

  /** Rewind / switch branches: point the active leaf at an existing entry.
   *  The next `send()` will fork a sibling off it (D-10, D-17). Persisted. */
  setActiveLeaf(entryId: string): void {
    if (!this.conversation.entries.some((e) => e.id === entryId)) {
      throw new Error(`No such entry: ${entryId}`);
    }
    this.conversation = treeSetActiveLeaf(this.conversation, entryId);
    this.emit({ type: "active-leaf", leaf: entryId });
  }

  /** Edit-and-fork: create a sibling of `entryId` (off its parent) with new text
   *  and run a turn — the pencil-edit affordance (D-17). */
  async editFork(entryId: string, text: string): Promise<void> {
    const entry = this.conversation.entries.find((e) => e.id === entryId);
    if (!entry) throw new Error(`No such entry: ${entryId}`);
    // Point at the edited entry's parent so send() appends a sibling; the new
    // entry's own `parent` records the fork, so no active-leaf record is needed.
    this.conversation = { ...this.conversation, activeLeaf: entry.parent };
    await this.send(text);
  }

  /** Append an entry to the tree and emit it for the persistence projection. */
  private pushEntry(input: EntryInput, parent?: string | null): Entry {
    const { conv, entry } = appendEntry(this.conversation, input, parent);
    this.conversation = conv;
    this.emit({ type: "entry", entry });
    return entry;
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
    const entry = this.pushEntry({ type: "user", text });
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
      const runArgs = decision.editedArgs ?? pending.request.args;
      const edited = decision.editedArgs !== undefined;
      // Widen the fence for any out-of-fence paths the user consented to (D-19).
      const escapes = this.fenceEscapes(pending.tool, runArgs);
      if (escapes.length > 0 && this.sandbox) {
        for (const e of escapes) {
          if (decision.addRoot) {
            const dir = typeof decision.addRoot === "string" ? decision.addRoot : path.dirname(e.escapedPath);
            this.sandbox.addRoot(dir);
            this.onAddRoot?.(dir);
          } else {
            this.sandbox.allowOnce(e.escapedPath); // one-shot
          }
        }
      }
      await this.doExecute(pending.call, pending.tool, runArgs, edited);
      this.sandbox?.clearOnce();
    } else {
      this.appendToolResult(pending.call, `denied by user${decision.reason ? `: ${decision.reason}` : ""}`, true);
    }
    this.pendingToolCalls.shift();
    await this.advance();
  }

  /** Provide the answer(s) to a pending ask_user and continue (D-18). A bare
   *  string answers a single-question form verbatim (the tool result is exactly
   *  that text); an array carries per-question answers for a multi-question form. */
  async answer(payload: string | AskUserAnswer[]): Promise<void> {
    const pending = this.pendingQuestion;
    if (!pending) throw new Error("No pending question");
    this.pendingQuestion = undefined;
    this.appendToolResult(pending.call, formatAnswers(payload), false);
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

      // Spend cap (D-33): at/over the cap, decline the next LLM call. Kill
      // nothing; just pause so the user can raise the cap (which resumes us).
      if (this.capBlocked()) {
        this.capReached = true;
        this.emit({ type: "cap-reached", spendUsd: this.spendUsd, capUsd: this.spendCapUsd! });
        this.status = "idle";
        return;
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
    const startedAt = Date.now();
    const toolNames = (req.tools ?? []).map((t) => t.function.name);
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
      this.emit({
        type: "debug",
        record: {
          kind: "llm",
          ms: Date.now() - startedAt,
          model: req.model,
          messages: req.messages.length,
          tools: toolNames,
          error: (err as Error).message,
        },
      });
      if (this.consecutiveFailures >= this.maxFailures) {
        this.status = "halted";
        this.emit({ type: "halted", reason: `${this.consecutiveFailures} consecutive failures` });
      } else {
        this.status = "idle";
      }
      return undefined;
    }

    const result = accumulate(events);
    this.emit({
      type: "debug",
      record: {
        kind: "llm",
        ms: Date.now() - startedAt,
        model: req.model,
        messages: req.messages.length,
        tools: toolNames,
        finishReason: result.finishReason,
        truncated: result.finishReason === "length",
        usage: result.usage,
        textPreview: result.text.slice(0, 200),
        reasoningPreview: result.reasoningText?.slice(0, 200),
      },
    });
    const entry = this.pushEntry({
      type: "assistant",
      text: result.text,
      toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
      reasoning: result.reasoning,
      reasoningText: result.reasoningText,
      finishReason: result.finishReason,
      truncated: result.finishReason === "length",
      usage: result.usage,
    });
    this.consecutiveFailures = 0;
    const turnUsd = computeCost(result.usage, this.pricing);
    this.spendUsd += turnUsd;
    this.emit({ type: "spend", totalUsd: this.spendUsd, turnUsd, usage: result.usage });
    this.emit({
      type: "assistant-end",
      entryId: entry.id,
      finishReason: result.finishReason,
      truncated: result.finishReason === "length",
    });
    return result;
  }

  private appendToolResult(call: ToolCall, content: string, isError: boolean): void {
    this.pushEntry({
      type: "tool",
      toolCallId: call.id,
      name: call.function.name,
      content,
      isError,
    });
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
      const request: AskUserRequest = { id: newId("ask"), questions: parseAskQuestions(args) };
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

    // Soft fence (D-19): out-of-fence paths need explicit consent, so they force
    // a prompt even if the mode/approval gate would otherwise allow.
    const escapes = this.fenceEscapes(tool, args);
    if (decision.kind === "prompt" || escapes.length > 0) {
      const request: ApprovalRequest = {
        id: newId("appr"),
        tool: tool.name,
        kind: tool.kind,
        args,
        reason: escapes.length > 0 ? "access outside the workspace" : "approval required by policy",
        ...(escapes.length > 0
          ? { outOfFence: { paths: escapes.map((e) => e.escapedPath), suggestedRoot: path.dirname(escapes[0]!.escapedPath) } }
          : {}),
      };
      this.pendingApproval = { request, call, tool };
      this.emit({ type: "awaiting-approval", request });
      return "paused-approval";
    }

    await this.doExecute(call, tool, args, false);
    return "done";
  }

  /** Path args of a tool call that fall outside the fence (D-19). */
  private fenceEscapes(tool: Tool, args: Record<string, unknown>): { arg: string; escapedPath: string }[] {
    if (!this.sandbox) return [];
    const escapes: { arg: string; escapedPath: string }[] = [];
    for (const argName of tool.pathArgs ?? []) {
      const value = args[argName];
      if (typeof value === "string") {
        const r = this.sandbox.resolve(value);
        if (!r.ok && r.kind === "escape") escapes.push({ arg: argName, escapedPath: r.escapedPath });
      }
    }
    return escapes;
  }

  private async doExecute(
    call: ToolCall,
    tool: Tool,
    args: Record<string, unknown>,
    edited: boolean,
  ): Promise<void> {
    this.emit({ type: "tool-start", name: tool.name });
    const startedAt = Date.now();
    const res = await tool.execute(args, { sandbox: this.sandbox! });
    const note = edited ? "[note: the user edited the arguments before running]\n" : "";
    this.appendToolResult(call, note + res.content, res.isError ?? false);
    this.emit({
      type: "debug",
      record: {
        kind: "tool",
        ms: Date.now() - startedAt,
        name: tool.name,
        argsPreview: JSON.stringify(args).slice(0, 300),
        contentPreview: res.content.slice(0, 200),
        isError: res.isError ?? false,
      },
    });
  }
}
