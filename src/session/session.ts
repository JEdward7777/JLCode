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
import type { ChatRequest, LlmDriver, StreamEvent, AssistantResult, ToolCall, ToolDef, Usage } from "../llm/types.js";
import { accumulate } from "../llm/stream.js";
import { newConversation, appendEntry, pathToLeaf, setActiveLeaf as treeSetActiveLeaf, type EntryInput } from "../conversation/tree.js";
import { buildWireMessages } from "../conversation/wire.js";
import type { Conversation, Entry } from "../conversation/types.js";
import type { Sandbox } from "../tools/sandbox.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { Tool, ToolGate } from "../tools/types.js";
import { AllowAllGate } from "../tools/gate.js";
import { ASK_USER } from "../tools/ask-user.js";
import { TaskRegistry } from "../tools/task-registry.js";
import type { TaskView } from "../tools/task-registry.js";
import { computeCost } from "./spend.js";
import {
  activeTriggerMode,
  applyCompactorFit,
  buildCompactionInstruction,
  buildCrossModelSummaryInput,
  computeBudget,
  evaluateTrigger,
  isOverWindowError,
  truncateToolOutputsForSummary,
  COMPACTION_MAX_TOKENS,
  type CompactionBudget,
} from "./compaction.js";
import type { CompactionTrigger } from "../config/types.js";
import type { QueuedMessage } from "./types.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  AskUserAnswer,
  AskUserQuestion,
  AskUserRequest,
  CompactionRequest,
  PersistenceFault,
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
  /** Background-task registry (D-34); a fresh one is created if omitted. */
  tasks?: TaskRegistry;
  /** How long a background command may run before the watchdog asks the model
   *  whether to kill it (D-34). Default 30 min; small values drive tests. */
  watchdogMs?: number;
  /** The working model's context window (`context_length`) for the compaction
   *  budget (D-27/D-44). Injected in P6a — tests dial it low to force the
   *  threshold; live `/models` fetch lands later. Falls back to the config's
   *  `compaction.contextLength`. When neither is known, no trigger ever fires. */
  contextWindow?: number;
  /** The compaction model's window, when a *smaller* summarizer is configured
   *  (compactor-fit guard, D-44a). Defaults to the working window. */
  compactorWindow?: number;
}

/** Default watchdog interval — 30 minutes (D-34). */
const WATCHDOG_MS = 30 * 60 * 1000;

const BASE_SYSTEM = "You are JLCode, a helpful coding agent.";

/** The structured yes/no the watchdog asks the model out-of-band (D-34). */
const DECIDE_KILL_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "decide_kill",
    description:
      "Decide whether to kill a long-running background command. kill=true terminates it now; kill=false lets it keep running.",
    parameters: {
      type: "object",
      properties: {
        kill: { type: "boolean", description: "true to terminate the command now" },
        reason: { type: "string", description: "brief rationale" },
      },
      required: ["kill"],
    },
  },
};

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
  /** True once ground-truth usage says the next request would exceed the budget
   *  (D-44). Detection only in P6a — the loop still proceeds (accepting the one
   *  accepted overshoot turn); the actual compaction engine is P6b. */
  needsCompaction = false;
  /** Live compaction trigger mode (D-27), switchable at runtime like mode/approval
   *  (P6c). Resolved from the config at construction; the header selector changes
   *  it and the server persists it as the config default. */
  triggerMode: CompactionTrigger;

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
  private readonly watchdogMs: number;
  /** Injected context window for the compaction budget (D-44); undefined → no
   *  window known → no trigger fires. Falls back to the config override. */
  private readonly contextWindow: number | undefined;
  /** The compaction model's window for the compactor-fit guard (D-44a). */
  private readonly compactorWindow: number | undefined;
  private readonly listeners = new Set<SessionListener>();

  // Resumable-loop state.
  private pendingToolCalls: ToolCall[] = [];
  /** The most-recent assistant entry id — tool debug records this turn attribute
   *  to it for the per-turn journal viewer (D-15). */
  private activeAssistantId: string | undefined;
  private pendingApproval: { request: ApprovalRequest; call: ToolCall; tool: Tool } | undefined;
  private pendingQuestion: { request: AskUserRequest; call: ToolCall } | undefined;
  /** A pre-send compaction decision the loop is paused on (P6c, D-27) — set in
   *  the `cancelable` / `hard` trigger modes. Resolved via resolveCompaction. */
  private pendingCompaction: CompactionRequest | undefined;
  /** A stalled persistence write the session is stopped on (D-46). Raised from
   *  outside the loop by the store's fault listener; cleared by retry/discard. */
  private pendingPersistence: PersistenceFault | undefined;
  // Global stop (D-34): "hard" aborts the in-flight LLM + kills tasks + clears
  // the queue; "soft" lets running work finish but takes no further LLM turn.
  private stopScope: "hard" | "soft" | null = null;
  private abortController: AbortController | undefined;
  /** Set by a turn that hit the over-window hard wall (D-44b) so the loop can
   *  compact-and-retry instead of failing. Cleared once handled. */
  private overWindow = false;
  /** The known-prefix size from the last budget-crossing evaluation (D-44), shown
   *  on the pre-send compaction pause card (P6c). Informational only. */
  private lastPrefixTokens = 0;
  /** Background-command registry (D-34): tracked, killable, watchdog-watched. */
  private readonly tasks: TaskRegistry;
  /** Messages queued mid-turn, applied FIFO at each turn boundary (D-34). */
  private queue: QueuedMessage[] = [];
  /** Per-task watchdog timers (30-min out-of-band kill prompt, D-34). */
  private readonly watchdogTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
    this.contextWindow = options.contextWindow ?? options.config.compaction?.contextLength;
    this.compactorWindow = options.compactorWindow;
    this.triggerMode = activeTriggerMode(options.config.compaction);
    this.watchdogMs = options.watchdogMs ?? WATCHDOG_MS;
    this.tasks = options.tasks ?? new TaskRegistry();
    // Forward task lifecycle to subscribers (UI list) and arm/disarm the
    // per-task watchdog (D-34).
    this.tasks.onEvent((e) => {
      this.emit(e);
      if (e.type === "task-start") this.armWatchdog(e.task.id);
      else if (e.type === "task-end") this.disarmWatchdog(e.task.id);
    });
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

  /** The compaction budget for this session (D-27/D-44), or undefined when no
   *  context window is known (so no trigger can fire). Applies the config buffer
   *  and the compactor-fit guard (D-44a) when a smaller summarizer is configured. */
  compactionBudget(): CompactionBudget | undefined {
    if (this.contextWindow === undefined) return undefined;
    const buffer = this.config.compaction?.bufferTokens;
    const budget = computeBudget(this.contextWindow, buffer);
    // The guard only bites when a *different*, smaller compaction model is set;
    // an identical/absent compactor uses the working window unchanged.
    const compactorId = this.config.compaction?.model;
    const compactorWindow =
      compactorId && compactorId !== this.config.model ? this.compactorWindow : undefined;
    return applyCompactorFit(budget, compactorWindow, buffer);
  }

  /** After a turn, decide from ground-truth usage whether the *next* request would
   *  exceed the budget (D-44). Detection only — P6a announces via `needs-compaction`
   *  and latches `needsCompaction`; the loop still proceeds (the accepted one-turn
   *  overshoot). The compaction engine (summarize + overlay) is P6b. */
  private evaluateCompaction(usage: Usage | undefined): void {
    const budget = this.compactionBudget();
    if (!budget) return;
    const evaln = evaluateTrigger(usage, budget);
    if (!evaln.needsCompaction) return;
    this.needsCompaction = true;
    this.lastPrefixTokens = evaln.prefixTokens;
    this.emit({
      type: "needs-compaction",
      mode: this.triggerMode,
      prefixTokens: evaln.prefixTokens,
      threshold: budget.threshold,
      window: budget.window,
    });
  }

  /** Safe-harbor compaction (P6b, D-28/D-38/D-29): fold the entire active branch
   *  into a single `compaction` overlay entry so the next request replays only
   *  `system + summary`. Provably Fable-safe by construction (zero thinking is
   *  replayed across the cut). Same-model **cache-reuse** path (D-29): the exact
   *  live prefix is resent with an **ephemeral** instruction (`tool_choice:none`,
   *  never persisted), so the provider serves the prefix from prompt cache; only
   *  the short instruction + summary output are billed. The `forced` variant
   *  (D-44b over-window recovery) truncates tool outputs in the summary input so
   *  it fits when the live prefix itself over-windowed — trading the cache hit for
   *  a request that fits (the fuller flattened/cross-model path is P6c). Returns
   *  true once the overlay entry lands; false if there was nothing to compact or
   *  the summary call failed (the caller decides how to proceed). */
  async compact(opts: { forced?: boolean } = {}): Promise<boolean> {
    const prefix = buildWireMessages(this.conversation, { system: this.systemPrompt });
    // Only a system prompt (or nothing) → nothing to summarize.
    if (prefix.every((m) => m.role === "system")) return false;
    const hasPriorSummary = pathToLeaf(this.conversation).some((e) => e.type === "compaction");
    // Cross-model path (D-29, refined): a *different*, cheaper compactor can't
    // reuse the working model's prompt cache and must not receive its signed
    // reasoning, so send flattened structured messages (readable planning kept,
    // opaque reasoning dropped, tool outputs truncated) to the compactor id.
    // Same-model → the cache-reuse path: the exact live prefix (only the forced
    // over-window fallback truncates it so it fits).
    const compactorId = this.config.compaction?.model;
    const crossModel = Boolean(compactorId && compactorId !== this.config.model);
    const model = crossModel ? compactorId! : this.config.model;
    const input = crossModel
      ? buildCrossModelSummaryInput(this.conversation, { system: this.systemPrompt })
      : opts.forced
        ? truncateToolOutputsForSummary(prefix)
        : prefix;
    const req: ChatRequest = {
      model,
      messages: [...input, { role: "user", content: buildCompactionInstruction({ hasPriorSummary }) }],
      tool_choice: "none",
      max_tokens: COMPACTION_MAX_TOKENS,
    };
    const startedAt = Date.now();
    this.abortController = new AbortController();
    const events: StreamEvent[] = [];
    try {
      for await (const ev of this.driver.streamChat(req, { signal: this.abortController.signal })) {
        events.push(ev);
      }
    } catch (err) {
      // A hard stop / over-window on the summary call itself: don't crash the
      // loop or count a failure — the caller falls back (surfaces / retries).
      if (this.stopScope === "hard" || (err as Error).name === "AbortError") return false;
      if (!isOverWindowError(err)) this.emit({ type: "error", message: (err as Error).message });
      return false;
    }
    const result = accumulate(events);
    const summary = result.text.trim();
    if (!summary) return false; // model produced nothing usable — keep the tree intact
    const turnUsd = computeCost(result.usage, this.pricing);
    this.spendUsd += turnUsd;
    this.emit({ type: "spend", totalUsd: this.spendUsd, turnUsd, usage: result.usage });
    this.emit({
      type: "debug",
      record: {
        kind: "llm",
        ms: Date.now() - startedAt,
        model: req.model,
        messages: req.messages.length,
        tools: [],
        finishReason: result.finishReason,
        usage: result.usage,
        textPreview: `[compaction${opts.forced ? " forced" : ""}] ${summary.slice(0, 160)}`,
      },
    });
    const entry = this.pushEntry({ type: "compaction", summary, replayCut: true });
    this.needsCompaction = false;
    this.emit({ type: "compacted", entryId: entry.id, forced: opts.forced ?? false, summaryChars: summary.length });
    return true;
  }

  /** Switch the live compaction trigger mode (P6c, D-27) — the header selector.
   *  Persisting the config default is the caller's concern; the session just
   *  re-resolves + announces (mirrors setModeApproval). */
  setTriggerMode(mode: CompactionTrigger): void {
    this.triggerMode = mode;
    this.emit({ type: "trigger-mode", mode });
  }

  get awaitingCompaction(): CompactionRequest | undefined {
    return this.pendingCompaction;
  }

  /** Raise a pre-send compaction pause (P6c, D-27): `cancelable` offers Compact/
   *  Skip, `hard` offers Compact only. The loop holds here until resolveCompaction. */
  private raiseCompactionPause(mode: "cancelable" | "hard"): void {
    const budget = this.compactionBudget();
    const request: CompactionRequest = {
      id: newId("comp"),
      mode,
      cancelable: mode === "cancelable",
      prefixTokens: this.lastPrefixTokens,
      threshold: budget?.threshold ?? 0,
      window: budget?.window ?? 0,
    };
    this.pendingCompaction = request;
    this.status = "awaiting-compaction";
    this.emit({ type: "awaiting-compaction", request });
  }

  /** Resolve a pending pre-send compaction decision (P6c, D-27) and continue the
   *  held turn. `skip` is honored only in `cancelable` mode (accept the one-turn
   *  overshoot, D-44); `hard` always compacts. */
  async resolveCompaction(skip: boolean): Promise<void> {
    const pending = this.pendingCompaction;
    if (!pending) throw new Error("No pending compaction");
    this.pendingCompaction = undefined;
    if (skip && pending.cancelable) {
      this.needsCompaction = false; // proceed uncompacted this turn (accepted overshoot)
    } else {
      const ok = await this.compact();
      if (this.stopScope) return this.settleStopped();
      if (!ok) this.needsCompaction = false;
    }
    await this.advance();
  }

  /** Compact on demand from the UI (P6c) — the `manual`/`suggest` "Compact now"
   *  button. Only runs from a settled (idle) session; a no-op otherwise (so it
   *  can't race a live turn). compact() clears needsCompaction on success. */
  async compactNow(): Promise<boolean> {
    if (this.status !== "idle") return false;
    return this.compact();
  }

  /** Announce the over-window hard wall (D-44b) before the loop compacts to
   *  recover it. Not a model failure, so it never touches the circuit breaker. */
  private announceOverWindow(): void {
    this.needsCompaction = true;
    const budget = this.compactionBudget();
    this.emit({ type: "error", message: "Request exceeded the model context window; compacting to recover." });
    this.emit({
      type: "needs-compaction",
      mode: this.triggerMode,
      prefixTokens: 0, // no authoritative count for a rejected request
      threshold: budget?.threshold ?? 0,
      window: budget?.window ?? 0,
      forced: true,
    });
  }

  /** Global stop (D-34). "hard" is the big red button: abort the in-flight LLM
   *  request, kill every background task, drop the queue and any pending work.
   *  "soft" is loop-only: leave running commands to finish but take no further
   *  LLM turn. If the loop is running it observes the flag and settles itself. */
  stop(scope: "hard" | "soft"): void {
    this.stopScope = scope;
    if (scope === "hard") {
      this.abortController?.abort();
      this.tasks?.killAll("stop");
      this.queue = [];
      this.pendingToolCalls = [];
      this.pendingApproval = undefined;
      this.pendingQuestion = undefined;
      this.pendingCompaction = undefined;
      this.emit({ type: "queue", queue: [] });
    }
    this.emit({ type: "stopped", scope });
    if (this.status !== "running") this.settleStopped();
    // else: the running advance() loop notices stopScope and settles at a safe point.
  }

  /** Clear the stop flag and settle — called once the loop unwinds. A stalled
   *  persistence write settles into its own pause instead of idle (D-46), so the
   *  session can't quietly accept new work while records are unwritten. */
  private settleStopped(): void {
    this.stopScope = null;
    this.status = this.pendingPersistence ? "awaiting-persistence" : "idle";
  }

  get awaitingPersistence(): PersistenceFault | undefined {
    return this.pendingPersistence;
  }

  /** Raise a persistence fault (D-46): a record could not be written, so stop
   *  everything and wait for the user. Called by the server's store listener,
   *  i.e. **asynchronously, from outside the turn loop** — so it reuses the
   *  hard-stop path to unwind a running turn at its existing safe points, and
   *  `settleStopped` lands on `awaiting-persistence`. Idempotent: a second
   *  failing file while already paused just updates the reported fault. */
  raisePersistenceFault(fault: Omit<PersistenceFault, "id">): void {
    const first = !this.pendingPersistence;
    this.pendingPersistence = { id: this.pendingPersistence?.id ?? newId("persist"), ...fault };
    this.emit({ type: "awaiting-persistence", fault: this.pendingPersistence });
    if (!first) return; // already stopped for this; don't re-abort the unwind
    if (this.status === "running") {
      this.stop("hard"); // abort the in-flight call; the loop settles into the pause
    } else {
      this.status = "awaiting-persistence";
    }
  }

  /** Retry the stalled writes — the disk-full recovery path (D-46). On success
   *  the backlog lands and the session returns to idle; on repeat failure it
   *  stays paused with `retryFailed` set so the banner can say so. `retryWrites`
   *  is injected by the server (it owns the store). */
  async retryPersistence(retryWrites: () => Promise<void>): Promise<boolean> {
    if (!this.pendingPersistence) throw new Error("No pending persistence fault");
    try {
      await retryWrites();
    } catch (err) {
      this.pendingPersistence = { ...this.pendingPersistence, message: (err as Error).message, retryFailed: true };
      this.emit({ type: "awaiting-persistence", fault: this.pendingPersistence });
      return false;
    }
    this.pendingPersistence = undefined;
    this.status = "idle";
    this.emit({ type: "persistence-recovered", discarded: 0 });
    return true;
  }

  /** Give up on the stalled records and carry on, accepting the loss (D-46).
   *  The explicit escape hatch — the conversation on disk will be missing these
   *  entries after a restart, which is why it is never done automatically. */
  discardPersistence(discardWrites: () => number): number {
    if (!this.pendingPersistence) throw new Error("No pending persistence fault");
    const discarded = discardWrites();
    this.pendingPersistence = undefined;
    this.status = "idle";
    this.emit({ type: "persistence-recovered", discarded });
    return discarded;
  }

  /** The background tasks currently running (D-34), for the UI list. */
  get taskList(): TaskView[] {
    return this.tasks.list();
  }

  /** Kill a specific background task from the UI (D-34). */
  killTask(id: string): boolean {
    return this.tasks.kill(id, "user");
  }

  /** The messages queued for the next turn boundary (D-34). */
  get queuedMessages(): QueuedMessage[] {
    return [...this.queue];
  }

  // ---- Watchdog: after 30 min, ask the model (out-of-band) to kill or keep a
  // long-running command (D-34). The Q&A is NOT added to the conversation; a
  // "kill" decision is reflected only via the eventual tool result, so the model
  // learns it killed the task rather than that it completed.

  private armWatchdog(taskId: string): void {
    if (this.watchdogMs <= 0) return; // disabled (0 / negative)
    const timer = setTimeout(() => void this.watchdogCheck(taskId), this.watchdogMs);
    (timer as { unref?: () => void }).unref?.(); // don't hold the process open
    this.watchdogTimers.set(taskId, timer);
  }

  private disarmWatchdog(taskId: string): void {
    const timer = this.watchdogTimers.get(taskId);
    if (timer) clearTimeout(timer);
    this.watchdogTimers.delete(taskId);
  }

  private async watchdogCheck(taskId: string): Promise<void> {
    this.watchdogTimers.delete(taskId);
    const view = this.tasks.get(taskId);
    if (!view || view.status !== "running") return; // ended already
    let kill = false;
    try {
      kill = await this.askWatchdogKill(taskId, view.command);
    } catch {
      kill = false; // on any error, keep it and re-ask later
    }
    if (this.tasks.get(taskId)?.status !== "running") return; // ended meanwhile
    if (kill) this.tasks.kill(taskId, "watchdog");
    else this.armWatchdog(taskId); // re-ask after another interval
  }

  /** One out-of-band model call: given the conversation so far plus the task's
   *  elapsed time and output, decide kill/keep. Counts toward whole-tree spend
   *  (D-33) but never touches the conversation tree. */
  private async askWatchdogKill(taskId: string, command: string): Promise<boolean> {
    const elapsedMin = Math.round(this.tasks.elapsedMs(taskId) / 60000);
    const output = this.tasks.output(taskId);
    const tail = output.length > 4000 ? "…" + output.slice(-4000) : output;
    const messages = buildWireMessages(this.conversation, { system: this.systemPrompt });
    messages.push({
      role: "user",
      content:
        `[watchdog] A background command you started has been running for ~${elapsedMin} min without exiting:\n` +
        `  $ ${command}\n\n` +
        `Output so far:\n${tail || "(no output yet)"}\n\n` +
        `Call decide_kill: kill=true terminates it now, kill=false lets it keep running ` +
        `(you'll be asked again later). This exchange is not added to the conversation.`,
    });
    const req: ChatRequest = { model: this.config.model, messages, tools: [DECIDE_KILL_TOOL] };
    const startedAt = Date.now();
    const events: StreamEvent[] = [];
    for await (const ev of this.driver.streamChat(req)) events.push(ev);
    const result = accumulate(events);
    const turnUsd = computeCost(result.usage, this.pricing);
    this.spendUsd += turnUsd;
    this.emit({ type: "spend", totalUsd: this.spendUsd, turnUsd, usage: result.usage });
    this.emit({
      type: "debug",
      record: {
        kind: "llm",
        ms: Date.now() - startedAt,
        model: req.model,
        messages: req.messages.length,
        tools: ["decide_kill"],
        finishReason: result.finishReason,
        usage: result.usage,
        textPreview: `[watchdog] ${command.slice(0, 60)}`,
      },
    });
    const call = result.toolCalls.find((t) => t.function.name === "decide_kill");
    if (!call) return false; // no decision → keep it running
    try {
      const args = JSON.parse(call.function.arguments || "{}") as { kill?: unknown };
      return args.kill === true;
    } catch {
      return false;
    }
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
    if (this.status === "awaiting-persistence") {
      throw new Error("Session is stopped: a conversation record could not be saved. Retry or discard it first.");
    }
    if (
      this.status === "awaiting-approval" ||
      this.status === "awaiting-input" ||
      this.status === "awaiting-compaction"
    ) {
      throw new Error("Session is waiting for input; resolve it before sending.");
    }
    if (this.status === "running") {
      throw new Error("Session is busy; queue the message instead.");
    }
    this.stopScope = null; // a fresh message clears any prior stop flag
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
      // Global stop observed at a turn boundary (D-34): soft or hard both settle
      // here; a hard stop has already aborted/killed/cleared.
      if (this.stopScope) return this.settleStopped();

      while (this.pendingToolCalls.length > 0) {
        const outcome = await this.tryExecute(this.pendingToolCalls[0]!);
        // A hard stop mid-command (the child was killed) bails immediately.
        if (this.stopScope === "hard") return this.settleStopped();
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

      // A stop requested *during* this iteration's tool run (soft or hard): take
      // no further LLM turn. Running commands were allowed to finish above.
      if (this.stopScope) return this.settleStopped();

      // Spend cap (D-33): at/over the cap, decline the next LLM call. Kill
      // nothing; just pause so the user can raise the cap (which resumes us).
      if (this.capBlocked()) {
        this.capReached = true;
        this.emit({ type: "cap-reached", spendUsd: this.spendUsd, capUsd: this.spendCapUsd! });
        this.status = "idle";
        return;
      }

      // Pre-send compaction (D-44/D-27): once ground-truth usage from a previous
      // turn latched needsCompaction, act *before* the next send per the live
      // trigger mode. `auto` compacts silently; `cancelable`/`hard` pause for a
      // decision; `suggest`/`manual` don't gate the loop (the UI offers a button).
      // The forced over-window path is handled by the turn wrapper below.
      if (this.needsCompaction) {
        if (this.triggerMode === "auto") {
          const ok = await this.compact();
          if (this.stopScope) return this.settleStopped();
          if (!ok) this.needsCompaction = false; // nothing to do / failed — don't spin
        } else if (this.triggerMode === "cancelable" || this.triggerMode === "hard") {
          this.raiseCompactionPause(this.triggerMode);
          return; // paused awaiting-compaction; resolveCompaction resumes the turn
        }
        // suggest / manual: proceed uncompacted — compaction is UI-driven out-of-band.
      }

      const result = await this.assistantTurnWithCompaction();
      if (!result) {
        if (this.stopScope) this.settleStopped(); // aborted by a hard stop
        return; // else error/halt/over-window already handled
      }

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
    this.stopScope = null; // settled normally; a soft stop on the last turn is spent
    this.status = "idle";
    await this.drainQueue();
  }

  // ---- Queued message (D-34): typed mid-turn, applied FIFO at a turn boundary.

  /** Queue a message to apply at the next turn boundary. If the session is idle,
   *  it is sent right away (the boundary is now). Returns the queued id. */
  async enqueue(text: string): Promise<void> {
    this.queue.push({ id: newId("q"), text });
    this.emit({ type: "queue", queue: [...this.queue] });
    if (this.status === "idle") await this.drainQueue();
  }

  /** Replace the pending queue wholesale — the UI's edit/cancel affordance. */
  setQueue(messages: { text: string }[]): void {
    this.queue = messages.map((m) => ({ id: newId("q"), text: m.text }));
    this.emit({ type: "queue", queue: [...this.queue] });
  }

  /** At a settled boundary, apply the next queued message (FIFO), unless stopped
   *  or cap-blocked. */
  private async drainQueue(): Promise<void> {
    if (this.status !== "idle" || this.stopScope || this.capReached) return;
    const next = this.queue.shift();
    if (!next) return;
    this.emit({ type: "queue", queue: [...this.queue] });
    await this.send(next.text);
  }

  /** Run one assistant turn, recovering from the over-window hard wall (D-44b):
   *  if the request is rejected because it exceeds the window, compact (forced,
   *  truncated summary input so it fits) and retry the turn **once**. Still too
   *  big after that → settle idle (the pathological single-turn-exceeds-window
   *  case, recoverable only by the P6c flattened path). Returns the turn's result
   *  or undefined when it did not (or could not) produce one. */
  private async assistantTurnWithCompaction(): Promise<AssistantResult | undefined> {
    const result = await this.oneAssistantTurn();
    if (result || !this.overWindow) return result;
    this.overWindow = false;
    this.announceOverWindow();
    if (this.stopScope) return undefined;
    const compacted = await this.compact({ forced: true });
    if (this.stopScope || !compacted) {
      if (!this.stopScope) this.status = "idle"; // couldn't compact — surfaced, latched
      return undefined;
    }
    const retry = await this.oneAssistantTurn();
    if (!retry && this.overWindow) {
      this.overWindow = false; // still over-window after compaction — give up on this turn
      this.status = "idle";
    }
    return retry;
  }

  private async oneAssistantTurn(): Promise<AssistantResult | undefined> {
    const req = this.buildRequest();
    const events: StreamEvent[] = [];
    const startedAt = Date.now();
    const toolNames = (req.tools ?? []).map((t) => t.function.name);
    this.emit({ type: "assistant-start" });
    this.abortController = new AbortController();
    try {
      for await (const ev of this.driver.streamChat(req, { signal: this.abortController.signal })) {
        events.push(ev);
        if (ev.type === "text") this.emit({ type: "text", delta: ev.delta });
        else if (ev.type === "reasoning") this.emit({ type: "reasoning", delta: ev.delta });
      }
    } catch (err) {
      // A hard stop aborts the request mid-stream (D-34): discard the turn
      // without counting it as a failure — advance() settles the loop.
      if (this.stopScope === "hard" || (err as Error).name === "AbortError") return undefined;
      // Over-window hard-wall fallback (D-44b): a single turn's new content blew
      // the whole buffer, so the provider rejected `prompt > context_length`.
      // Flag it and unwind; `assistantTurnWithCompaction` compacts and retries.
      if (isOverWindowError(err)) {
        this.overWindow = true;
        return undefined;
      }
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
    // Create the entry first so the debug record can carry its id (per-turn
    // journal linkage, D-15); order in the journal is otherwise immaterial.
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
    this.activeAssistantId = entry.id; // tool records this turn attribute here
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
        entryId: entry.id,
      },
    });
    this.consecutiveFailures = 0;
    const turnUsd = computeCost(result.usage, this.pricing);
    this.spendUsd += turnUsd;
    this.emit({ type: "spend", totalUsd: this.spendUsd, turnUsd, usage: result.usage });
    // Ground-truth trigger check (D-44): does the next request's known prefix
    // (this turn's prompt + completion) exceed the budget? Detection only in P6a.
    this.evaluateCompaction(result.usage);
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
    const res = await tool.execute(args, { sandbox: this.sandbox!, tasks: this.tasks });
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
        ...(this.activeAssistantId ? { entryId: this.activeAssistantId } : {}),
      },
    });
  }
}
