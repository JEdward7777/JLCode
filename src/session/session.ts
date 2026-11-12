/**
 * A Session (D-36): one live agent loop bound to a conversation and a model
 * config. It fully owns its state — the anti-entropy invariant.
 *
 * The loop is a resumable state machine so it can **pause** for approvals
 * (D-08/D-16) and for a question (`ask`, D-18), then **resume**: `send()` runs until the
 * session settles (idle/halted) or needs the user (awaiting-approval /
 * awaiting-input); `approve()` and `answer()` continue it. Truncation (D-30) and
 * the consecutive-failure circuit breaker (D-32) still apply.
 */
import path from "node:path";
import { newId } from "../util/id.js";
import type { ApprovalPolicy, Mode, ModelConfig } from "../config/types.js";
import { DEFAULT_TOOL_ROUNDS, DEFAULT_WATCHDOG_MINUTES, configuredRouting, toolRoundsOff, turnTimestampsEnabled } from "../config/operations.js";
import type { ChatMessage, ChatRequest, LlmDriver, StreamEvent, AssistantResult, ToolCall, ToolDef, Usage, ProviderRouting } from "../llm/types.js";
import { accumulate } from "../llm/stream.js";
import { isRateLimitError, isTransientError, retryDelayMs } from "../llm/errors.js";
import type { WindowSource } from "../llm/models.js";
import {
  newConversation,
  appendEntry,
  governingSwitch,
  pathToLeaf,
  setActiveLeaf as treeSetActiveLeaf,
  unansweredToolCalls,
  restStateOf,
  type EntryInput,
  type RestState,
} from "../conversation/tree.js";
import { buildWireMessages, endsWithUnansweredToolCall, pinnedProvider } from "../conversation/wire.js";
import type { Attachment, Conversation, Entry, InboundMeta, ModelSwitchEntry, SharedFile } from "../conversation/types.js";
import type { Sandbox } from "../tools/sandbox.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { AgentAccess, Tool, ToolGate, ToolPreview } from "../tools/types.js";
import { AllowAllGate } from "../tools/gate.js";
import { isAskTool } from "../tools/ask-user.js";
import { TODO_GUIDANCE, TODO_READ } from "../tools/todo-tools.js";
import {
  planTodoSnapshot,
  planTodoWrite,
  renderTodoDiff,
  renderTodoList,
  todoCensus,
  todosOn,
  todoTip,
  type TodoAccess,
  type TodoItem,
  type TodoOp,
  type TodoWriteInput,
  type TodoWriteResult,
} from "../conversation/todos.js";
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
  knownPrefixTokens,
  isOverWindowError,
  truncateToolOutputsForSummary,
  COMPACTION_MAX_TOKENS,
  type CompactionBudget,
} from "./compaction.js";
import { buildTitleInstruction, driftedEnough, sanitizeTitle, TITLE_MAX_TOKENS, type TitleMark } from "./title.js";
import type { CompactionTrigger } from "../config/types.js";
import {
  ModelConfigMissingError,
  type AgentInfo,
  type InboundMessage,
  type PendingModelSwitch,
  type QueuedMessage,
  type SubtreeSummary,
} from "./types.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  AskUserAnswer,
  AskUserQuestion,
  AskUserRequest,
  CompactionRequest,
  StallRequest,
  LearnAnswers,
  LearnRequest,
  PersistenceFault,
  SessionEvent,
  SessionListener,
  SessionStatus,
} from "./types.js";

/**
 * The parts a live config switch replaces on a running session (X-40, D-82a).
 *
 * Everything here is **derived** from the new config by the session factory —
 * the same factory that built the session in the first place — rather than
 * recomputed by the Session. That is deliberate: the window, the image
 * capability and the tool descriptions all come from the model catalog, which
 * the Session has never had and must not grow a second, drifting copy of.
 */
export interface SessionRetarget {
  config: ModelConfig;
  driver: LlmDriver;
  /** Rebuilt because `read_file`'s description states whether this model can be
   *  handed a picture, and `run_command`'s states the watchdog interval — a
   *  description that disagrees with the behaviour is the X-33 defect. */
  tools?: ToolRegistry;
  watchdogMs: number;
  maxToolIterations: number;
  contextWindow?: number;
  contextWindowSource?: WindowSource;
  compactorWindow?: number;
  acceptsImages: boolean;
}

/**
 * What a session asks of the agent tree it belongs to (X-56, D-88/D-89). The
 * coordinator (`src/session/agents.ts`) implements it; a session that has never
 * been attached to one runs exactly as before P9c.
 */
export interface AgentHost {
  spawn(session: Session, task: string, model?: string, mode?: Mode): Promise<string>;
  send(session: Session, to: string, text: string): string;
  listModels(session: Session): string;
  /** `list_agents`, `close_agent`, `wake_agents` (P9f). */
  listAgents(session: Session, showClosed: boolean): string;
  closeChild(session: Session, name: string): string;
  wakeAgents(session: Session): string;
  /** `set_agent_mode` (P9f2, X-58): change a direct child's mode. */
  setAgentMode(session: Session, name: string, mode: Mode): string;
  /** A parent's mode change held for a batch landed on this session (P9f2):
   *  the host caps the agents below it to the mode now in force. */
  modeLanded?(session: Session): void;
  /** May this session open an **agent-started** turn now, under the tree's
   *  concurrency cap (D-89)? False → it waits `queued`, and the host starts it
   *  (`startQueued`) when a slot frees, FIFO. */
  admit(session: Session): boolean;
  /** Whole-tree spend (D-33): what the cap is measured against. */
  treeSpendUsd(session: Session): number;
  /** This session's descendants, for the parent's "waiting for you" flag. */
  subtree(session: Session): SubtreeSummary;
  /** Hand the question this session just paused on — addressed to its parent
   *  agent (P9d, X-56 Q16) — to that parent, as a message it answers by
   *  replying. Called once the session is `awaiting-input`. */
  askParent?(session: Session, request: AskUserRequest): void;
  /** Is the tool-round pause switched off for this session (P9d, D-89)? By its
   *  **root's** config, read live, or by a "don't ask again" recorded on it or
   *  on any agent above it. */
  roundsOff?(session: Session): boolean;
}

export interface SessionOptions {
  id?: string;
  config: ModelConfig;
  driver: LlmDriver;
  systemPrompt?: string;
  /** The workspace's own agent instructions, already read and rendered (X-15).
   *  A **string, read by the caller**, not a directory this session reads for
   *  itself: the read must happen exactly once — the system message is the
   *  cached prefix (D-26), and re-rendering it per turn is the defect D-58 fixed
   *  at 12.3x. `createSessionFactory` is the caller that supplies it. */
  projectInstructions?: string;
  maxConsecutiveFailures?: number;
  /** How many times a *transient* provider failure is re-sent automatically
   *  before the user is asked to decide (D-57). 0 disables auto-retry. */
  maxAutoRetries?: number;
  /** Backoff between automatic attempts. Injectable so tests don't sleep. */
  autoRetryDelay?: (err: unknown, attempt: number) => number;
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
  /** Model turns one user message may take before the loop pauses to ask
   *  whether it is still making progress (D-79). Doubles on every Continue. */
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
   *  whether to kill it (D-34). Default 30 min; small values drive tests; `0`
   *  disables it. Set from `commands.watchdogMinutes` by the factory (X-33),
   *  which hands the same number to `run_command`'s description. */
  watchdogMs?: number;
  /** The working model's context window (`context_length`) for the compaction
   *  budget (D-27/D-44). Injected in P6a — tests dial it low to force the
   *  threshold; live `/models` fetch lands later. Falls back to the config's
   *  `compaction.contextLength`. When neither is known, no trigger ever fires. */
  contextWindow?: number;
  /** Where `contextWindow` came from (D-44c). Carried so the browser can say
   *  which window it is measuring against instead of implying we looked it up —
   *  a silently wrong window is exactly how H-06 hid for a month. */
  contextWindowSource?: WindowSource;
  /** The compaction model's window, when a *smaller* summarizer is configured
   *  (compactor-fit guard, D-44a). Defaults to the working window. */
  compactorWindow?: number;
  /** Auto-title this conversation after the first exchange (X-09). **Off unless
   *  asked for**: it costs one extra model call, and only an embedder that has
   *  somewhere to keep and show a label (the server + browser rail) benefits —
   *  a headless session would pay for a string nobody reads. */
  autoTitle?: boolean;
  /** Re-title the thread as it drifts (X-17). Defaults **off** (D-81): a
   *  re-title is a full billed call against a prefix that is only ever bigger
   *  than the first one, and it usually answers with the name the thread already
   *  has. A stale label is a one-click rename (X-12b); set true to buy drift
   *  re-titling back. Only means anything when `autoTitle` is on. */
  autoRetitle?: boolean;
  /** Whether this session's model can be handed a picture (P8b/P8e), resolved
   *  once by the factory from the catalog plus the config override. The Session
   *  never asks the question itself; it only carries the answer down to the
   *  tools that cannot be told at construction — the bridged MCP ones, which are
   *  built once for the whole instance. */
  acceptsImages?: boolean;
  /** Look a model config up by id in the **live** config store (X-56, D-87).
   *  A thread governed by a `model-switch` entry resolves its config through
   *  this on every request, so later edits to that config (effort, provider, a
   *  rotated key) reach it; `undefined` means the config was deleted, and the
   *  thread refuses to send. Absent → this session cannot switch models. */
  lookupConfig?: (id: string) => ModelConfig | undefined;
  /** Derive everything a config switch replaces — the same derivation the
   *  factory built this session with (D-82b), so a per-thread switch cannot
   *  leave the window or the tool descriptions behind (H-06). Required with
   *  `lookupConfig`. */
  deriveRetarget?: (config: ModelConfig) => SessionRetarget;
  /** What the folder binding (or `serve --config` pin) resolves to **now** —
   *  the config a branch with no switch runs under (D-82a). Read at the top of
   *  every user turn the session opens for itself (a drained queue, a retry off
   *  a switched branch), so a branch never inherits a sibling branch's switch. */
  bindingConfig?: () => ModelConfig | undefined;
}

/** Default watchdog interval — 30 minutes (D-34), stated once in the config
 *  layer so the timer and the number `run_command` advertises cannot drift. */
const WATCHDOG_MS = DEFAULT_WATCHDOG_MINUTES * 60 * 1000;

const BASE_SYSTEM = "You are JLCode, a helpful coding agent.";

/** Sentence-case a fragment (the todo census, when it opens a summary line). */
function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

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
      if (o.required === true) q.required = true;
      out.push(q);
    }
    if (out.length > 0) return out;
  }
  const single: AskUserQuestion = {
    question: typeof args.question === "string" ? args.question : "(no question provided)",
  };
  const opts = strings(args.options);
  if (opts) single.options = opts;
  if (args.required === true) single.required = true;
  return [single];
}

/** Said once per result that carries a decline, because the model's default
 *  reading of a blank is "they meant the obvious one" and that is exactly the
 *  failure this exists to prevent (D-72). */
const DECLINE_NOTE =
  "A declined question is information, not an absence of it: the user chose none of the offered options. " +
  "Do not substitute the closest one. Continue with what you have and say which assumption you are making, " +
  "or ask a different question.";

const quote = (s: string): string => `"${s}"`;

/** The result a call gets when a Stop ends its turn before it ran (H-10). */
const STOPPED_CALL = "stopped by the user — this call was not run";
/** …and when the conversation simply moved on past it: a rewind onto a call,
 *  a `length` cut-off mid-call, a log written before this rule. */
const SKIPPED_CALL = "not run — the conversation continued";

/** Nothing was said here — an explicit decline, or a blank that amounts to one. */
export function isBlankAnswer(a: AskUserAnswer): boolean {
  return a.declined === true || (!(a.chosen?.length ?? 0) && !(a.typed?.trim() ?? "") && !a.answer.trim());
}

/** One answer, rendered so its *shape* survives — picked / typed / declined. */
function describeAnswer(a: AskUserAnswer, hadOptions: boolean): string {
  if (isBlankAnswer(a)) return "declined — the user did not answer this";
  const chosen = a.chosen ?? [];
  const typed = a.typed?.trim() ?? "";
  if (chosen.length > 0 && typed) return `chose ${chosen.map(quote).join(", ")}, and also typed: ${typed}`;
  if (chosen.length > 0) return `chose ${chosen.map(quote).join(", ")}`;
  if (typed && hadOptions) return `picked none of the offered options and typed: ${typed}`;
  return typed || a.answer;
}

/** Turn an answer payload into the tool-result string the model reads. A bare
 *  string (single-question) passes through verbatim; an array is rendered as a
 *  labeled block so multi-question answers stay unambiguous.
 *
 *  The one-question form still returns the answer verbatim when it is a plain
 *  one — that is D-18's contract and what a plain-text frontend produces. It
 *  does *not* when the answer's shape is itself the message: a decline, or text
 *  typed in the face of offered options. Both of those read as an ordinary
 *  answer once flattened, which is the bug (D-72). */
function formatAnswers(payload: string | AskUserAnswer[], questions: AskUserQuestion[] = []): string {
  if (typeof payload === "string") return payload;
  const hadOptions = (i: number): boolean => (questions[i]?.options?.length ?? 0) > 0;
  // A blank counts as a decline whether or not the frontend said so: an empty
  // string handed to the model reads as an answer, which is the bug.
  const declines = payload.filter(isBlankAnswer).length;

  if (payload.length === 1) {
    const only = payload[0]!;
    const plain = !isBlankAnswer(only) && !((only.typed?.trim() ?? "") && hadOptions(0));
    if (plain) return only.answer;
  }

  const head =
    declines === payload.length
      ? payload.length > 1
        ? "The user declined to answer any of these questions:"
        : "The user declined to answer:"
      : "The user answered:";
  const lines = payload.map(
    (a, i) => `- ${a.header ? `${a.header} — ` : ""}${a.question}: ${describeAnswer(a, hadOptions(i))}`,
  );
  return [head, ...lines, ...(declines > 0 ? ["", DECLINE_NOTE] : [])].join("\n");
}

/** Events after which a session's rest state may read differently (P9f). */
const REST_MOVERS: ReadonlySet<SessionEvent["type"]> = new Set(["status", "queue", "entry", "active-leaf"]);

/** What a Wake did with one session (P9f): started it, parked it for a slot
 *  under the width cap, or left it — asleep on its own reply, not at rest, or
 *  held by something only a person clears (the cap, the breaker, a missing
 *  model, a Stop in flight). */
export type WakeOutcome = "woken" | "queued" | "quiescent" | "busy" | "blocked";

export class Session {
  readonly id: string;
  /** The config this session runs under. **Not readonly since X-40**: the server
   *  re-resolves it at the top of each user turn, so a `jlcode config model`
   *  switch reaches an open thread at the next message (D-82a). Everything
   *  derived from it is replaced together in {@link adoptConfig} — a half-applied
   *  switch (new model, old window) is the H-06 shape with a new face. */
  config: ModelConfig;
  conversation: Conversation;
  /** Backing field for {@link status}. */
  private currentStatus: SessionStatus = "idle";
  /** Where this session sits in an agent tree (D-88), once it is in one. */
  agentInfo: AgentInfo | undefined;
  /** The tree this session belongs to (D-88); see {@link AgentHost}. */
  private agentHost: AgentHost | undefined;
  /** A `spawn_agent` call succeeded in the batch being run: the turn ends when
   *  the batch drains, unless something new was said meanwhile (X-56 Q5 — the
   *  parent ends its turn and idles, as if waiting on the user). */
  private yieldTurn = false;
  /** The current turn was ended by a Stop — the outcome a parent is told. */
  private stoppedTurn = false;
  /** A suspended turn is ready to go on but its tree is at its concurrency cap
   *  (D-89): it waits `queued`, and `startQueued` resumes the parked turn rather
   *  than opening a new one. `cap`: a raise released a turn parked on the spend
   *  cap. `answer`: the parent agent answered the question it was paused on
   *  (P9d) — a resume an agent caused, so it waits for a slot like any
   *  agent-started turn. */
  private queuedResume: false | "cap" | "answer" | "wake" = false;
  /** Whether a person opened the current turn — the human, rather than an
   *  agent's message or notice. Decides who an `ask` with no `to` goes to (P9d,
   *  X-56 Q16): the person for a human-started turn, else the parent agent. */
  private turnByHuman = true;
  /** The pause a persistence fault covered (D-46) — a card, the round budget —
   *  restored when the fault clears, so the card stays up instead of reading
   *  `idle` with a decision still pending under it. */
  private statusBeforeFault: SessionStatus | undefined;

  /** Where the loop stands. Every change is announced (`status` event): the
   *  agent coordinator counts a tree's running agents by it (D-89), and it is
   *  what a sub-agent's rail dot will be drawn from (P9e). */
  get status(): SessionStatus {
    return this.currentStatus;
  }
  set status(next: SessionStatus) {
    if (next === this.currentStatus) return;
    this.currentStatus = next;
    // A turn under way (or waiting for a slot) is no longer at rest.
    if (next === "running" || next === "queued") this.restedAs = null;
    this.emit({ type: "status", status: next });
  }

  /** How the last turn came to rest (`settled`), until the next one starts —
   *  what tells a sub-agent's "finished" dot from a plain "idle" one in the
   *  rail (P9e, X-56 Q18). Null while a turn is under way, and on a session
   *  that has not settled since it was loaded. */
  restedAs: "finished" | "failed" | "stopped" | null = null;

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
  /** True when the last turn ended somewhere a Retry can act on (D-57): the
   *  request failed (or the breaker tripped) and the branch was left exactly as
   *  that request found it — a user message with no answer under it. Re-running
   *  the loop rebuilds the identical prefix, so retrying costs nothing but the
   *  call. Cleared the moment a turn succeeds or a new message is sent. */
  retryable = false;
  /** True once ground-truth usage says the next request would exceed the budget
   *  (D-44). Detection only in P6a — the loop still proceeds (accepting the one
   *  accepted overshoot turn); the actual compaction engine is P6b. */
  needsCompaction = false;
  /** Live compaction trigger mode (D-27), switchable at runtime like mode/approval
   *  (P6c). Resolved from the config at construction; the header selector changes
   *  it and the server persists it as the config default. */
  triggerMode: CompactionTrigger;

  private driver: LlmDriver;
  /** Everything ahead of the config's addendum in the system prompt — the base
   *  prompt, the todo guidance and the **workspace's** instructions — composed
   *  once and never again (X-15c/d). Held separately so a config switch can swap
   *  the addendum without re-reading the workspace file, which must stay a
   *  once-per-session read. */
  private readonly promptPrefix: string;
  /** The config's addendum, the one half of the prompt a switch can change. */
  private promptAddendum: string | undefined;
  /** Stamp each user turn with the time it was sent (X-25). Read from the config
   *  once; every replay this session builds goes through {@link wire} so the
   *  live prefix, the compaction input and the ephemeral title/watchdog asks are
   *  byte-identical — which is what keeps the prompt cache warm (D-29/D-58). */
  private stamps: boolean;
  private readonly maxFailures: number;
  private tools: ToolRegistry | undefined;
  private readonly sandbox: Sandbox | undefined;
  private gate: ToolGate;
  private readonly buildGate: ((mode: Mode, approval: ApprovalPolicy) => ToolGate) | undefined;
  private maxToolIterations: number;
  private readonly onAddRoot: ((dir: string) => void) | undefined;
  private consecutiveFailures = 0;
  private pricing: ModelConfig["pricing"];
  /** Public for the same reason `contextWindowSource` is: it is a setting that
   *  travels from config through a factory, and the H-06 class of defect is a
   *  factory that quietly stops carrying one. Readable = assertable (X-33). */
  watchdogMs: number;
  /** Injected context window for the compaction budget (D-44); undefined → no
   *  window known → no trigger fires. Falls back to the config override. */
  private contextWindow: number | undefined;
  /** Provenance of `contextWindow`, for display (D-44c). */
  contextWindowSource: WindowSource | undefined;
  /** The compaction model's window for the compactor-fit guard (D-44a). */
  private compactorWindow: number | undefined;
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
  /** The "still working?" pause the tool-round budget raises (D-79). Resolved
   *  via continueRun, which doubles the budget and resumes the same turn. */
  private pendingStall: StallRequest | undefined;
  /** Model turns taken on the **current user message** (D-79). Reset by `send`
   *  and by nothing else: an approval, an ask_user answer or a compaction
   *  decision resumes the same turn, so the count has to survive them — the old
   *  per-`runLoop` counter is exactly why the budget was unpredictable. */
  private toolRounds = 0;
  /** The live budget `toolRounds` is measured against. Starts at
   *  `maxToolIterations` each user message and doubles on every Continue. */
  private iterationBudget: number;
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
  /** A Retry that arrived while a request was in flight (D-57): abandon the
   *  attempt and send the identical prefix again. Deliberately *not* a stop —
   *  nothing is killed, no failure is counted, the turn just gets another go. */
  private restartRequested = false;
  /** True while an LLM request is actually streaming. What makes a mid-flight
   *  Retry meaningful: with no request in flight there is nothing to abandon. */
  private streaming = false;
  private readonly maxAutoRetries: number;
  private readonly autoRetryDelay: (err: unknown, attempt: number) => number;
  /** The known-prefix size from the last budget-crossing evaluation (D-44), shown
   *  on the pre-send compaction pause card (P6c). Informational only. */
  private lastPrefixTokens = 0;
  /** Where the branch stood when the current title was chosen — or when a title
   *  call was last *spent* (X-17). `null` means neither has happened, which is
   *  X-09's "not named yet". Set before the call, so a failed attempt backs off
   *  on the same schedule instead of retrying every turn. */
  private titleMark: TitleMark | null = null;
  /** Whether to auto-title at all (X-09) — opt-in, since it costs a call. */
  private readonly autoTitle: boolean;
  /** Whether to re-title as the thread drifts (X-17). On by default *when
   *  auto-titling is on at all*; the opt-out keeps the opening name and the one
   *  call it cost. */
  private readonly autoRetitle: boolean;
  /** Handed to every tool call's context (P8e) — see `SessionOptions`. */
  private acceptsImages: boolean;
  /** Background-command registry (D-34): tracked, killable, watchdog-watched. */
  private readonly tasks: TaskRegistry;
  /** Messages queued mid-turn, applied FIFO at each turn boundary (D-34). */
  private queue: QueuedMessage[] = [];
  /** A remark carried in on an approval decision (D-51), waiting for the tool
   *  batch to drain. It cannot land the moment it arrives: tool results must
   *  follow their assistant message unbroken, so a user message wedged between
   *  two of them would be malformed on the wire. */
  private pendingNote?: string;
  /** A mode a parent agent set while a batch was in flight (P9f2, X-58),
   *  applied at the next point between batches — never mid-batch: the calls
   *  already issued run under the mode they were issued under. */
  private pendingMode?: Mode;
  /** The note telling the model its parent changed its mode (P9f2): a user
   *  entry it reads before its next model call. Lands where a queued message
   *  would — at the next tool-loop pass, or ahead of the next turn's opening
   *  message — so it is never said over an unanswered call (H-10). Newest wins. */
  private modeNote?: InboundMessage;
  /** Per-task watchdog timers (30-min out-of-band kill prompt, D-34). */
  private readonly watchdogTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** The tip this turn appends to, pinned when the turn opens and advanced by
   *  each entry the turn appends (H-05). `undefined` means no turn is in flight,
   *  so appends follow `activeLeaf` — the reader's pointer. While a turn *is* in
   *  flight the pointer is free to move (branch arrows are passive, SPEC §27) and
   *  the turn keeps building where it began, instead of re-parenting its reply
   *  onto whatever branch the user wandered to. */
  private turnLeaf: string | null | undefined;
  /** Which turn owns `turnLeaf` (and the settle work after it). Bumped wherever
   *  a turn **opens** — `send`, `retry` — and captured by the `advance` /
   *  `runLoop` that runs it. Status reads `idle` while a finished turn awaits
   *  its settle-time title ask, so a new turn can open in that window; the old
   *  turn's tail must then do nothing — not release the new turn's pin, not
   *  resync, not land a pick, not drain — or it strands a suspended turn's tool
   *  call on whatever branch the reader moved to (H-05). */
  private turnGen = 0;
  /** The todo entry the agent has seen (X-31) — the read barrier's whole state.
   *  `undefined` is "never read", which is distinct from `null` ("read it, and
   *  it was empty"), so the very first write on a fresh branch is refused until
   *  the agent has looked. */
  private todoSeen: string | null | undefined;
  /** Live config lookup + retarget derivation for per-thread switching (D-87). */
  private readonly lookupConfig: ((id: string) => ModelConfig | undefined) | undefined;
  private readonly deriveRetarget: ((config: ModelConfig) => SessionRetarget) | undefined;
  private readonly bindingConfig: (() => ModelConfig | undefined) | undefined;
  /** Whether `config` came from a `model-switch` entry rather than the binding —
   *  what tells a retry on a branch with no switch that the config it holds
   *  belongs to some other branch (D-87). */
  private configFromSwitch = false;
  /** A switch picked while busy (X-56 Q4): in memory only, written at the next
   *  idle point, replaced by a second pick. Never persisted — a pick that a
   *  restart loses was never applied, so nothing on disk disagrees with it. */
  private pendingSwitch: PendingModelSwitch | undefined;
  /** The pending pick's landing check: does the branch it would be written on
   *  at the idle point still carry the key the pick was confirmed against? The
   *  reader may have moved to another branch while the turn ran, and a pick that
   *  needed no confirmation there might need one here (Q3). */
  private pendingAccepts: ((leaf: string | null) => boolean) | undefined;

  constructor(options: SessionOptions) {
    if (options.tools && !options.sandbox) throw new Error("A tool registry requires a sandbox");
    this.id = options.id ?? newId("sess");
    this.config = options.config;
    this.driver = options.driver;
    this.maxFailures = options.maxConsecutiveFailures ?? 3;
    this.maxAutoRetries = options.maxAutoRetries ?? 3;
    this.autoRetryDelay = options.autoRetryDelay ?? retryDelayMs;
    this.tools = options.tools;
    this.sandbox = options.sandbox;
    this.mode = options.mode ?? options.config.defaultMode;
    this.approval = options.approval ?? options.config.defaultApproval;
    this.buildGate = options.buildGate;
    this.gate = options.buildGate
      ? options.buildGate(this.mode, this.approval)
      : (options.gate ?? new AllowAllGate());
    this.maxToolIterations = options.maxToolIterations ?? DEFAULT_TOOL_ROUNDS;
    this.iterationBudget = this.maxToolIterations;
    this.onAddRoot = options.onAddRoot;
    // The system prompt, composed once and never again (X-15c/d). Order is
    // base → the **workspace's** instructions → the **config's** addendum, and
    // the addendum sits last deliberately: it is per-client and the more
    // specific of the two, so where a project and a client disagree, the client
    // config is what the operator chose most recently. Composed here, at
    // construction, so `this.systemPrompt` is a frozen string for the life of
    // the session and every turn replays a byte-identical cached prefix.
    const project = options.projectInstructions?.trim();
    const addendum = options.config.systemPromptAddendum?.trim();
    const base = options.systemPrompt ?? BASE_SYSTEM;
    // The todo list's usage instructions ride here, and **only when the tools
    // are actually registered** (X-31): the base prompt is shared with sessions
    // that have no tool registry at all, and telling a model to call a tool it
    // has not been given is how a turn gets spent on an apology.
    const todos = options.tools?.get(TODO_READ) ? TODO_GUIDANCE : undefined;
    this.promptPrefix = [base, todos, project].filter((s): s is string => Boolean(s)).join("\n\n");
    this.promptAddendum = addendum || undefined;
    this.stamps = turnTimestampsEnabled(options.config);
    this.conversation = options.conversation ?? newConversation();
    this.pricing = options.config.pricing;
    this.spendCapUsd = options.spendCapUsd;
    this.autoTitle = options.autoTitle ?? false;
    this.autoRetitle = options.autoRetitle ?? false;
    this.acceptsImages = options.acceptsImages === true;
    // A conversation that arrives already named is measured from **here**, not
    // from its first turn (X-17): the log doesn't say how far along the thread
    // was when that name was chosen, and re-titling on the first settle after
    // every resume would spend a call on a guess. Drift is measured from where
    // we found it.
    if (this.conversation.title) this.titleMark = this.branchTitleMark();
    this.contextWindow = options.contextWindow ?? options.config.compaction?.contextLength;
    // An injected source describes the injected window; falling through to the
    // config override means the window came from the config either way.
    this.contextWindowSource =
      options.contextWindow !== undefined
        ? options.contextWindowSource
        : options.config.compaction?.contextLength !== undefined
          ? "config"
          : undefined;
    this.compactorWindow = options.compactorWindow;
    this.triggerMode = activeTriggerMode(options.config.compaction);
    this.watchdogMs = options.watchdogMs ?? WATCHDOG_MS;
    this.tasks = options.tasks ?? new TaskRegistry();
    this.lookupConfig = options.lookupConfig;
    this.deriveRetarget = options.deriveRetarget;
    this.bindingConfig = options.bindingConfig;
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
    // Agent messages a previous process recorded as sent but never delivered
    // (D-88) wait in the queue rather than vanish. Nothing auto-starts on load
    // (X-56 Q15): they land with whatever turn opens next.
    this.queue = (this.conversation.inbox ?? []).map((m) => ({
      id: newId("q"),
      text: m.text,
      inbound: { id: m.id, from: m.from, kind: m.kind },
    }));
    // A resumed thread whose branch was switched (D-87) reports — and runs
    // under — its own model from the start, not the binding's it was built
    // with. A deleted config is left for `send` to refuse, where the refusal
    // has somewhere to go; `modelMissing` already says so to anyone asking.
    if (this.governingSwitch && !this.modelMissing) this.syncGoverningConfig(false);
    // Loaded at rest, it already *is* in a rest state: seed it, so the first
    // turn's start announces `rest: null` instead of looking like no change.
    this.announcedRest = this.restState;
  }

  /** The full system prompt: the once-composed prefix plus this config's
   *  addendum. A getter rather than a field so a config switch (D-82a) changes
   *  the addendum and nothing else — the workspace instructions above it stay
   *  the ones read at session construction. */
  private get systemPrompt(): string {
    return this.promptAddendum ? `${this.promptPrefix}\n\n${this.promptAddendum}` : this.promptPrefix;
  }

  /**
   * Adopt a different model configuration on a **running** session (D-82a).
   *
   * The server calls this at the top of a user turn, having noticed that
   * `jlcode config model` (or `config set`/`use`) changed what this directory
   * resolves to. The parts arrive pre-derived from the session factory, because
   * a switch that changed the model but not the window — or not the tool
   * descriptions — would be exactly H-06 again: a setting that looks applied and
   * reaches only half of what it governs.
   *
   * **Only at a turn boundary.** Explicitly not per LLM call, which was the
   * literal reading of "whenever the system has paused": an `ask_user` or an
   * approval pauses *mid-cycle*, where the assistant message above it carries
   * signed reasoning from the outgoing model, and switching there would hand
   * model B model A's signed thinking — the shape D-28/D-38 forbid. So a session
   * that is anything but idle declines, and picks the switch up next message.
   *
   * What is deliberately **not** touched: `mode`, `approval` and `triggerMode`.
   * Those are live runtime state the person set from the header; a config switch
   * is not a reason to overrule a choice made ten seconds ago.
   *
   * An open thread that no longer fits the new model's window gets the ordinary
   * over-window error on its next request — the notice that already has to
   * exist, since compaction can be off and a thread can be ground into that
   * state unaided. No compact-on-switch, no per-thread refusal.
   */
  adoptConfig(next: SessionRetarget): boolean {
    // `atIdlePoint`, not just `idle`: a spend-cap block reads idle while its
    // turn is pinned and resumes on a raise — retargeting it would hand the
    // resumed turn another model mid-cycle.
    if (!this.atIdlePoint) return false;
    if (next.config.id === this.config.id && next.config.updatedAt === this.config.updatedAt) return false;
    this.applyRetarget(next);
    this.configFromSwitch = false;
    return true;
  }

  /** Install a pre-derived config — the one body behind both the binding switch
   *  (`adoptConfig`, D-82a) and the per-thread one (`syncGoverningConfig`, D-87).
   *  Callers own the "is this a safe moment" question; this only assigns. */
  private applyRetarget(next: SessionRetarget): void {
    const from = { name: this.config.name, model: this.config.model };
    this.config = next.config;
    this.driver = next.driver;
    if (next.tools) this.tools = next.tools;
    this.promptAddendum = next.config.systemPromptAddendum?.trim() || undefined;
    this.stamps = turnTimestampsEnabled(next.config);
    this.pricing = next.config.pricing;
    this.watchdogMs = next.watchdogMs;
    this.maxToolIterations = next.maxToolIterations;
    // Mid-turn (a per-request re-resolve, D-87) the turn keeps the budget it is
    // spending, Continue-doublings included (D-79); a new one starts at `send`.
    if (this.turnLeaf === undefined) this.iterationBudget = next.maxToolIterations;
    this.contextWindow = next.contextWindow ?? next.config.compaction?.contextLength;
    this.contextWindowSource =
      next.contextWindow !== undefined
        ? next.contextWindowSource
        : next.config.compaction?.contextLength !== undefined
          ? "config"
          : undefined;
    this.compactorWindow = next.compactorWindow;
    this.acceptsImages = next.acceptsImages;
    // The budget is measured against the *new* window, so a thread that was
    // comfortably inside the old one may already be over this one. Re-evaluate
    // from what we know rather than waiting for the next usage report.
    this.needsCompaction = false;
    this.emit({
      type: "config",
      configId: next.config.id,
      configName: next.config.name,
      model: next.config.model,
      from,
    });
  }

  // ---- Per-thread model switching (X-56, D-87).

  /** The `model-switch` entry governing the branch in play, if any. */
  get governingSwitch(): ModelSwitchEntry | undefined {
    return governingSwitch(this.conversation, this.workingLeaf);
  }

  /** The refusal this thread would hit on its next send: its governing switch
   *  names a config that no longer exists (X-56 Q2). The browser reads this to
   *  open the picker before anyone types into a composer that cannot send. */
  get modelMissing(): ModelConfigMissingError | undefined {
    const sw = this.governingSwitch;
    if (!sw || !this.lookupConfig) return undefined;
    return this.lookupConfig(sw.configId) ? undefined : new ModelConfigMissingError(sw.configId, sw.snapshot);
  }

  /** The config governing the branch **in view**, for writes that name a
   *  config (the mode/trigger defaults): its switch's config, live, when it has
   *  one; otherwise the binding's — the held config when that is the binding's,
   *  else the binding read fresh (the held one may be a sibling's mid-turn).
   *  Undefined when the switch's config is gone: there is nothing to write to,
   *  and naming the held config would edit a file the person never looked at. */
  get inViewConfig(): ModelConfig | undefined {
    const sw = governingSwitch(this.conversation, this.conversation.activeLeaf);
    if (sw) return this.lookupConfig?.(sw.configId);
    return this.configFromSwitch ? this.bindingConfig?.() : this.config;
  }

  /** A switch picked while busy, waiting for the next idle point. */
  get pendingModelSwitch(): PendingModelSwitch | undefined {
    return this.pendingSwitch;
  }

  /** Idle in the sense a switch needs: no turn in flight *or suspended*. A
   *  spend-cap block reads `idle` but resumes the same turn on a raise, with its
   *  branch pin still held, so a switch there waits like any other busy state. */
  get atIdlePoint(): boolean {
    return this.status === "idle" && !this.capReached && this.turnLeaf === undefined;
  }

  /**
   * Switch this thread to another model config (X-56, D-87).
   *
   * Idle → a `model-switch` entry is written on the branch in view and the
   * session adopts the config at once. Busy (running, or paused for an approval,
   * a question, a compaction decision or the round budget) → held **pending**
   * and written at the next idle point; a second pick replaces the first. The
   * cross-key acknowledgement is the server's to demand — it is a question about
   * what the person was shown, not about the session — so a pending pick carries
   * the server's `accepts` check, re-asked of the branch it actually lands on.
   *
   * Applied at once, the switch is an idle point like any other, so a message
   * held in the queue (a thread whose model was gone) is sent now.
   */
  async switchModel(
    configId: string,
    opts: { accepts?: (leaf: string | null) => boolean } = {},
  ): Promise<"applied" | "pending"> {
    if (!this.lookupConfig || !this.deriveRetarget) throw new Error("This session cannot switch models.");
    const config = this.lookupConfig(configId);
    if (!config) throw new Error(`No such model config: ${configId}`);
    if (this.atIdlePoint) {
      this.clearPendingSwitch();
      // Only a queue that was *held* for the missing model goes now. Anything
      // else waiting — X-31's parked todo notices — waits for a turn the
      // person opens; a model pick is not a reason to spend a call.
      const held = this.heldForMissingModel;
      this.writeSwitch(config);
      if (held) await this.drainQueue();
      return "applied";
    }
    this.pendingSwitch = { configId: config.id, name: config.name, model: config.model };
    this.pendingAccepts = opts.accepts;
    this.emit({ type: "model-switch-pending", pending: this.pendingSwitch });
    return "pending";
  }

  private clearPendingSwitch(): void {
    if (!this.pendingSwitch) return;
    this.pendingSwitch = undefined;
    this.pendingAccepts = undefined;
    this.emit({ type: "model-switch-pending", pending: null });
  }

  /** Is the queue being held because this branch's model is gone (D-87)? */
  private get heldForMissingModel(): boolean {
    return this.queue.length > 0 && this.modelMissing !== undefined;
  }

  /** Write the pending switch, if there is one and this is an idle point;
   *  true when an entry was written **and it released a queue held for the
   *  missing model** — the caller's cue to drain. Dropped with an error instead — never
   *  written — when its config was deleted since the pick (the entry would only
   *  make the thread refuse to send), or when the branch it would land on no
   *  longer carries the key the pick was confirmed against. */
  private applyPendingSwitch(): boolean {
    const pending = this.pendingSwitch;
    if (!pending || !this.atIdlePoint) return false;
    const accepts = this.pendingAccepts;
    this.clearPendingSwitch();
    const config = this.lookupConfig?.(pending.configId);
    const label = `"${pending.name}" (${pending.model})`;
    if (!config) {
      this.emit({ type: "error", message: `The model picked while busy, ${label}, no longer exists; the switch was not applied.` });
      return false;
    }
    if (accepts && !accepts(this.conversation.activeLeaf)) {
      this.emit({
        type: "error",
        message: `The model picked while busy, ${label}, was not applied: the branch in view now uses a different OpenRouter key. Pick it again to confirm.`,
      });
      return false;
    }
    const held = this.heldForMissingModel;
    this.writeSwitch(config);
    return held;
  }

  /*
   * THE CONFIG INVARIANT (X-56, D-87). Every path that calls the model resolves
   * its config from the branch it will act on, and an idle session always holds
   * the in-view branch's config. Concretely:
   *   - a turn pins its branch and resolves at its top (`send`: full resolve,
   *     binding included; `retry`: `alignToBranch`), then re-resolves before
   *     every request (`runLoop`, mid-turn rules);
   *   - when a turn's pin is released at an idle point, and when the reader
   *     moves while idle, the session re-aligns to the branch in view
   *     (`resyncModel`);
   *   - out-of-turn calls with no pin (`compactNow`, the watchdog ask) align
   *     for themselves, and refuse a branch whose config is gone.
   * "Align" replaces only a config that belongs to **another** branch: a config
   * that is this branch's own is kept, so a re-bound folder still reaches an
   * unswitched thread only at a user-turn top (D-82a), never mid-cycle.
   */

  /** Does the config held now belong to the branch in play? A switched branch
   *  owns its switch's config id; an unswitched one owns any binding config —
   *  the binding is re-read only at a user-turn top (D-82a). */
  private configBelongsToBranch(): boolean {
    const sw = this.governingSwitch;
    return sw ? sw.configId === this.config.id : !this.configFromSwitch;
  }

  /** Replace a config that belongs to another branch (see the invariant).
   *  Throws {@link ModelConfigMissingError} for a switch to a deleted config. */
  private alignToBranch(): void {
    if (!this.configBelongsToBranch()) this.syncGoverningConfig(false);
  }

  /** The in-view half of the invariant: at an idle point, hold the branch in
   *  view's config — after a rewind, and whenever a turn releases its pin. A
   *  deleted config is left for `modelMissing` to report and `send` to refuse. */
  resyncModel(): void {
    if (!this.atIdlePoint) return;
    try {
      this.alignToBranch();
    } catch (err) {
      if (!(err instanceof ModelConfigMissingError)) throw err;
    }
  }

  /** Out-of-turn model calls (compaction on demand, the watchdog): with no turn
   *  pinned they act on the branch in view, so align to it — and refuse, typed,
   *  when its config is gone. Mid-turn they act on the turn's branch, whose
   *  config the loop already resolves per request. */
  private alignOutOfTurn(): void {
    if (this.turnLeaf !== undefined) return;
    const missing = this.modelMissing;
    if (missing) throw missing;
    this.alignToBranch();
  }

  private writeSwitch(config: ModelConfig): void {
    this.pushEntry({ type: "model-switch", configId: config.id, snapshot: { name: config.name, model: config.model } });
    this.syncGoverningConfig(false);
  }

  /**
   * Bring `this.config` in line with the branch's governing switch, resolving
   * its id against the live store (D-87) — called at the top of every turn and
   * before every model request. No switch → the folder binding governs: at a
   * clean boundary (`midTurn` false) the live `bindingConfig()` is adopted
   * here; mid-turn nothing changes, since a re-bind must not reach a cycle in
   * progress (D-82a).
   *
   * Throws {@link ModelConfigMissingError} when the switch names a deleted
   * config — never a silent substitute.
   *
   * `midTurn`: an edit to the governing config is picked up per request, but a
   * change of its **model** waits for the turn boundary. Mid-cycle the window
   * still holds the outgoing model's signed reasoning with no switch entry to
   * drop it at, which is exactly the hand-over D-82a refuses to make.
   */
  private syncGoverningConfig(midTurn: boolean): void {
    if (!this.deriveRetarget) return;
    const sw = this.governingSwitch;
    if (!sw) {
      // No switch: the binding governs, adopted only at a clean boundary —
      // never per request, which is D-82a's mid-cycle hand-over.
      if (midTurn || !this.bindingConfig) return;
      const binding = this.bindingConfig();
      if (!binding) return; // nothing selected now → keep running under what we have
      if (binding.id !== this.config.id || binding.updatedAt !== this.config.updatedAt) {
        this.applyRetarget(this.deriveRetarget(binding));
      }
      this.configFromSwitch = false;
      return;
    }
    if (!this.lookupConfig) return;
    const config = this.lookupConfig(sw.configId);
    if (!config) throw new ModelConfigMissingError(sw.configId, sw.snapshot);
    if (config.id === this.config.id && config.updatedAt === this.config.updatedAt) {
      this.configFromSwitch = true;
      return;
    }
    if (midTurn && config.model !== this.config.model) return;
    this.applyRetarget(this.deriveRetarget(config));
    this.configFromSwitch = true;
  }

  /** Set / raise / clear the spend cap (D-33). Raising above current spend after
   *  a breach clears the block and resumes the paused loop; nothing is killed. */
  async setSpendCap(capUsd: number | null): Promise<void> {
    this.spendCapUsd = capUsd ?? undefined;
    this.emit({ type: "cap", capUsd });
    // Under a persistence fault nothing resumes (D-46): the cap is recorded and
    // the park kept, and recovery resumes it if this raise freed it.
    if (this.pendingPersistence) return;
    await this.resumeFromCap();
  }

  /** Resume a turn parked on the spend cap, if the cap now allows it — the
   *  one path for a raise and for recovery from a persistence fault. A raise
   *  resumes every parked member of a tree at once; the width cap must hold
   *  through that too (D-89), so a resume asks for a slot like an
   *  agent-started turn does, and waits `queued` for one. */
  private async resumeFromCap(): Promise<void> {
    if (!this.capReached || this.capBlocked()) return;
    this.capReached = false;
    if (this.agentHost && !this.agentHost.admit(this)) {
      this.queuedResume = "cap";
      this.status = "queued";
      return;
    }
    await this.advance(); // resume where the breach paused us
  }

  /** At/over the cap → the next LLM call is declined (D-33). */
  private capBlocked(): boolean {
    // In an agent tree the cap is the tree's (D-33 "whole-tree", D-35): every
    // member carries the root's cap and measures the whole tree against it.
    const spent = this.agentHost ? this.agentHost.treeSpendUsd(this) : this.spendUsd;
    return this.spendCapUsd !== undefined && spent >= this.spendCapUsd;
  }

  // ---- Sub-agents (X-56, D-88/D-89). The tree itself — names, depth, keys, the
  // concurrency queue — is the coordinator's; the session only carries its
  // place in it, takes in messages, and asks before an agent-started turn.

  /** Join an agent tree. Called by the coordinator, once. */
  setAgentHost(host: AgentHost, info: AgentInfo): void {
    this.agentHost = host;
    this.agentInfo = info;
    // A sub-agent joins the bag (and the bus announces it) before the
    // coordinator links it, so its `session-added` frame carries no place in
    // the tree — this is what lets the rail nest it (P9e).
    this.emit({ type: "agent", info });
  }

  /** Leave it (the session was closed out of the tree). */
  clearAgentHost(): void {
    this.agentHost = undefined;
  }

  /** This session's descendants, when it is in a tree. */
  get subtree(): SubtreeSummary | undefined {
    return this.agentHost?.subtree(this);
  }

  /** Whole-tree spend when in a tree, else this session's own (D-33). */
  get treeSpendUsd(): number {
    return this.agentHost ? this.agentHost.treeSpendUsd(this) : this.spendUsd;
  }

  /** Announce a change below this session (the coordinator's call). */
  reportSubtree(summary: SubtreeSummary): void {
    this.emit({ type: "subtree", summary });
  }

  /**
   * Take in a message another agent sent (X-56 Q5, D-88) — recorded first
   * (`inbox`, persisted before anything else, so a message owed a reply
   * survives a crash), then queued. It does **not** open a turn: the
   * coordinator calls {@link startNext} for that, so a turn never starts
   * inside the sender's own tool call. While this session is busy it simply
   * rides the queue, which the loop flushes at every tool-loop pass (D-52) —
   * which is how a correction reaches a working child before its next step.
   */
  receive(message: InboundMessage): void {
    this.emit({ type: "inbox", message });
    this.queue.push({
      id: newId("q"),
      text: message.text,
      inbound: { id: message.id, from: message.from, kind: message.kind },
    });
    this.emit({ type: "queue", queue: [...this.queue] });
  }

  /** Open a turn on the queue's head if idle — what a delivered message does to
   *  an idle receiver (D-88). Busy, it is already waiting its turn. */
  async startNext(): Promise<void> {
    if (this.status === "idle") await this.drainQueue();
  }

  /** The coordinator found a slot for a `queued` turn (D-89): start it — or,
   *  for a turn a cap raise released, resume it where the breach parked it. */
  async startQueued(): Promise<void> {
    if (this.status !== "queued") return;
    if (this.queuedResume === "wake") {
      this.queuedResume = false;
      this.status = "idle";
      await this.wake({ admitted: true }).done;
      return;
    }
    if (this.queuedResume) {
      this.queuedResume = false;
      await this.advance(); // `runLoop` marks it running
      return;
    }
    this.status = "idle";
    await this.drainQueue({ admitted: true });
  }

  /** The question this session is paused on is addressed to its parent agent
   *  (P9d) — so the parent's next message to it answers it rather than queue. */
  get asksParent(): boolean {
    return this.pendingQuestion?.request.to === "parent";
  }

  /**
   * The parent agent replied while this session waits on the question it asked
   * that parent (P9d, X-56 Q16): the reply **is** the answer. Synchronous, like
   * {@link receive} — the answer is on the tree inside the sender's own tool
   * call, so it is on disk before the sender moves on — and like `receive` it
   * opens no turn: the session waits `queued` until the coordinator calls
   * {@link resumeAnswered} off the sender's stack. Returns false (nothing done)
   * when there is no such question any more — the person answered it first, or
   * a Stop ended it — and the caller delivers the reply as an ordinary message.
   *
   * Under a persistence fault the answer still lands (it joins the backlog, as
   * a `receive` would) and the resume waits for recovery.
   */
  answerFromParent(from: string, text: string): boolean {
    const pending = this.pendingQuestion;
    if (!pending || pending.request.to !== "parent") return false;
    // Only a session actually paused on the card. Between `tryExecute` setting
    // the question and `runLoop` setting `awaiting-input`, an answer that set
    // `queued` would be overwritten — a question-less card, stranded. The
    // reply then queues like any message.
    const paused =
      this.status === "awaiting-input" ||
      (this.status === "awaiting-persistence" && this.statusBeforeFault === "awaiting-input");
    if (!paused) return false;
    this.pendingQuestion = undefined;
    // Answers the call (H-10): nothing more is said over it, and the rest of
    // the batch — if the question was not its last call — runs on resume.
    this.appendToolResult(pending.call, `[Answer from your parent agent "${from}"]\n\n${text}`, false);
    this.pendingToolCalls.shift();
    this.queuedResume = "answer";
    if (this.pendingPersistence) this.statusBeforeFault = "queued";
    else this.status = "queued";
    return true;
  }

  /** Resume a turn its parent's answer released (P9d) — through `admit`, since
   *  an agent caused it: no slot → it stays `queued` and the tree starts it
   *  FIFO. A no-op once anything else has claimed the turn (a Stop, a person's
   *  message, a persistence fault). */
  async resumeAnswered(): Promise<void> {
    if (this.status !== "queued" || this.queuedResume !== "answer") return;
    if (this.agentHost && !this.agentHost.admit(this)) return;
    this.queuedResume = false;
    await this.advance();
  }

  /** The current turn is being, or was, ended by a Stop — so nothing it does
   *  from here may start another agent's turn (D-34 reaching the subtree). */
  get stopping(): boolean {
    return this.stopScope !== null || this.stoppedTurn;
  }

  /** The agent tools' handle on the tree, bound to this session as the caller.
   *  A successful spawn marks the turn to end once its batch drains. */
  private get agentAccess(): AgentAccess | undefined {
    const host = this.agentHost;
    if (!host) return undefined;
    return {
      spawn: async (task, model, mode) => {
        const result = await host.spawn(this, task, model, mode);
        this.yieldTurn = true;
        return result;
      },
      send: (to, text) => host.send(this, to, text),
      listModels: () => host.listModels(this),
      listAgents: (showClosed) => host.listAgents(this, showClosed),
      closeAgent: (name) => host.closeChild(this, name),
      wakeAgents: () => host.wakeAgents(this),
      setAgentMode: (name, mode) => host.setAgentMode(this, name, mode),
    };
  }

  /** The compaction budget for this session (D-27/D-44), or undefined when no
   *  context window is known (so no trigger can fire). Takes the absolute
   *  `thresholdTokens` when set, else derives from the config buffer (X-27), then
   *  applies the compactor-fit guard (D-44a) when a smaller summarizer is
   *  configured — in that order, so the guard can tighten either. */
  compactionBudget(): CompactionBudget | undefined {
    if (this.contextWindow === undefined) return undefined;
    const buffer = this.config.compaction?.bufferTokens;
    const budget = computeBudget(this.contextWindow, {
      bufferTokens: buffer,
      thresholdTokens: this.config.compaction?.thresholdTokens,
    });
    // The guard only bites when a *different*, smaller compaction model is set;
    // an identical/absent compactor uses the working window unchanged.
    const compactorId = this.config.compaction?.model;
    const compactorWindow =
      compactorId && compactorId !== this.config.model ? this.compactorWindow : undefined;
    return applyCompactorFit(budget, compactorWindow, buffer);
  }

  /** How full the context is right now, in tokens — the meter's reading (X-24).
   *
   *  **Derived, never stored:** walk back along the active branch and report the
   *  most recent authoritative measurement. That is the same ground-truth number
   *  the trigger uses (`prompt + completion` of the last turn, D-44), so the
   *  meter and the trigger can never disagree — and because it is read off the
   *  tree rather than latched in a field, it is automatically right after a
   *  resume, a fork/rewind, or a branch switch, none of which a stored counter
   *  would notice.
   *
   *  A `compaction` overlay short-circuits it to 0: everything above the replay
   *  cut is no longer sent, so the pre-compaction figure describes a prefix that
   *  no longer exists. 0 means *not measured yet* — a fresh session, a
   *  just-compacted one, or a branch with no assistant turn on it. The UI shows
   *  that as unmeasured rather than as "empty", since the true value is small
   *  but unknown. Stale by construction between turns (D-44 reads authoritative
   *  usage rather than tokenizing), which the meter says out loud. */
  get contextTokens(): number {
    const branch = pathToLeaf(this.conversation, this.workingLeaf).reverse();
    for (const entry of branch) {
      if (entry.type === "compaction") return 0; // replay cut — nothing measured since
      if (entry.type === "assistant") return knownPrefixTokens(entry.usage);
    }
    return 0;
  }

  /** After a turn, decide from ground-truth usage whether the *next* request would
   *  exceed the budget (D-44). Detection only — P6a announces via `needs-compaction`
   *  and latches `needsCompaction`; the loop still proceeds (the accepted one-turn
   *  overshoot). The compaction engine (summarize + overlay) is P6b. */
  private evaluateCompaction(usage: Usage | undefined): void {
    const budget = this.compactionBudget();
    // Announce the meter reading every round trip, crossed or not (X-24) — the
    // filed defect was that this number only ever surfaced once it was too late
    // to act on. Emitted before the budget check so a session with no budget
    // still drives a meter (it just has nothing to measure against).
    this.emit({ type: "context", tokens: knownPrefixTokens(usage), threshold: budget?.threshold, window: budget?.window });
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
   *  live prefix is resent with an **ephemeral** instruction (never persisted),
   *  so the provider serves the prefix from prompt cache; only the short
   *  instruction + summary output are billed. `ephemeralRequest` is what makes
   *  that true — it copies the tools, pin and reasoning the cache keys on, and
   *  leaves `tool_choice` alone (D-81). The `forced` variant
   *  (D-44b over-window recovery) truncates tool outputs in the summary input so
   *  it fits when the live prefix itself over-windowed — trading the cache hit for
   *  a request that fits (the fuller flattened/cross-model path is P6c). Returns
   *  true once the overlay entry lands; false if there was nothing to compact or
   *  the summary call failed (the caller decides how to proceed). */
  async compact(opts: { forced?: boolean } = {}): Promise<boolean> {
    // Compact the branch the turn is building, not whatever the reader has
    // navigated to since (H-05) — it is that branch's prefix we're about to resend.
    const leafId = this.workingLeaf;
    const prefix = this.wire(leafId);
    // Only a system prompt (or nothing) → nothing to summarize.
    if (prefix.every((m) => m.role === "system")) return false;
    const hasPriorSummary = pathToLeaf(this.conversation, leafId).some((e) => e.type === "compaction");
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
      ? buildCrossModelSummaryInput(this.conversation, { system: this.systemPrompt, leafId, stamps: this.stamps })
      : opts.forced
        ? truncateToolOutputsForSummary(prefix)
        : prefix;
    const req = this.ephemeralRequest({
      model,
      messages: input,
      instruction: buildCompactionInstruction({ hasPriorSummary }),
      maxTokens: COMPACTION_MAX_TOKENS,
    });
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
        // What actually went on the wire. A hardcoded `[]` here is what hid
        // D-81's missing-tools defect in the journal for as long as it did.
        tools: (req.tools ?? []).map((t) => t.function.name),
        finishReason: result.finishReason,
        usage: result.usage,
        textPreview: `[compaction${opts.forced ? " forced" : ""}] ${summary.slice(0, 160)}`,
      },
    });
    // The todo count, stated by us rather than asked of the model (X-31). The
    // list itself is *not* folded into the summary: it survives compaction on
    // its own (the ops are on the branch, above the cut but still folded on
    // read), so restating it would only create a second copy to drift. A count
    // is cheap, and it prompts a read at the one moment the agent has genuinely
    // lost the thread.
    const todos = this.todos;
    const withTodos =
      todos.length === 0
        ? summary
        : `${summary}\n\n## Todo list\n${capitalize(todoCensus(todos))} — call ${TODO_READ} for the current list.`;
    const entry = this.pushEntry({ type: "compaction", summary: withTodos, replayCut: true });
    this.needsCompaction = false;
    // The prefix above the cut is no longer sent, so the last reading now
    // describes a request that will never be made again (X-24). Back to
    // unmeasured until the next turn reports real usage.
    this.emit({ type: "context", tokens: 0 });
    this.emit({ type: "compacted", entryId: entry.id, forced: opts.forced ?? false, summaryChars: withTodos.length });
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
    // Running from here, as in `approve`: a Stop during the summary call takes
    // the running path, and `advance` below settles the stop with the pin.
    this.status = "running";
    if (skip && pending.cancelable) {
      this.needsCompaction = false; // proceed uncompacted this turn (accepted overshoot)
    } else {
      const ok = await this.compact();
      if (!ok) this.needsCompaction = false;
    }
    // A stop that landed during the compaction is honored by the loop's first
    // check, and `advance`'s tail releases the pin — no model call is made.
    await this.advance();
  }

  get awaitingContinue(): StallRequest | undefined {
    return this.pendingStall;
  }

  /** Raise the "still working?" pause (D-79). Reached only from the one point in
   *  the loop where nothing is half-done: the tool batch is drained, its results
   *  are on the tree, and the next model call has not been made. */
  private raiseStallPause(): void {
    const request: StallRequest = {
      id: newId("stall"),
      rounds: this.toolRounds,
      budget: this.iterationBudget,
      nextBudget: this.iterationBudget * 2,
    };
    this.pendingStall = request;
    this.status = "awaiting-continue";
    // The journal is where "why did it stop?" is answered (D-15). The bug this
    // pause replaces was invisible precisely because it wrote nothing here.
    this.emit({
      type: "debug",
      record: {
        kind: "note",
        message: `Paused after ${request.rounds} model turn${request.rounds === 1 ? "" : "s"} on one message (budget ${request.budget}). Continue → ${request.nextBudget}.`,
        entryId: this.activeAssistantId,
      },
    });
    this.emit({ type: "awaiting-continue", request });
  }

  /** Resume a stalled turn on a doubled budget (D-79) — the Continue button.
   *  Nothing is replayed and nothing was dropped: the loop picks up at the model
   *  call it was about to make.
   *
   *  `dontAskAgain` is the card's third button (P9d, X-56 Q8, D-89): continue,
   *  and switch the pause off for this thread and every sub-agent below it.
   *  Recorded in the log (`rounds-off`), so it holds across a restart; the
   *  spend cap (D-33) is then the only brake. */
  async continueRun(opts: { dontAskAgain?: boolean } = {}): Promise<void> {
    const pending = this.pendingStall;
    if (!pending) throw new Error("No pending continue");
    this.pendingStall = undefined;
    this.iterationBudget = pending.nextBudget;
    if (opts.dontAskAgain && !this.conversation.roundsOff) {
      this.conversation.roundsOff = true;
      this.emit({ type: "rounds-off" });
    }
    await this.advance();
  }

  /** Whether the tool-round pause is off for this session (P9d, D-89): in a
   *  tree, the coordinator answers from the root's config and the "don't ask
   *  again" marks above; alone, this thread's own config (read live) and mark. */
  get roundsOff(): boolean {
    if (this.agentHost?.roundsOff) return this.agentHost.roundsOff(this);
    const live = this.lookupConfig?.(this.config.id) ?? this.config;
    return this.conversation.roundsOff === true || toolRoundsOff(live);
  }

  /** Compact on demand from the UI (P6c) — the `manual`/`suggest` "Compact now"
   *  button. Only runs from a settled (idle) session; a no-op otherwise (so it
   *  can't race a live turn). compact() clears needsCompaction on success. */
  async compactNow(): Promise<boolean> {
    if (this.status !== "idle") return false;
    // Over an open call (a reply cut off mid-call) the summary request would be
    // the D-84 shape. Compaction writes only its summary, so it refuses rather
    // than answer the call itself; the next message heals the branch (P9c).
    if (unansweredToolCalls(this.conversation, this.workingLeaf).length > 0) {
      this.emit({
        type: "error",
        message: "Can't compact yet: the last reply ended in the middle of a tool call. Send a message first, then compact.",
      });
      return false;
    }
    this.alignOutOfTurn(); // the config invariant: summarize with this branch's model
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
    // A stop outranks a Retry that was mid-flight: the user changed their mind
    // about wanting this turn at all, so don't let the restart flag resurrect it.
    this.restartRequested = false;
    // A running turn ends at its next safe point: that turn was ended by a
    // person — what a parent is told. (A suspended one is marked below, only
    // if this Stop actually ends it: a soft Stop leaves a cap-parked turn
    // parked, and the raise that resumes it must run it as a normal turn.)
    if (this.status === "running") this.stoppedTurn = true;
    // A spawn earlier in the batch must not end some later turn early.
    this.yieldTurn = false;
    // Whatever pause a persistence fault was covering, a Stop ends it: when the
    // fault clears, the session returns to idle, not to a card that is gone.
    this.statusBeforeFault = undefined;
    // A resume a cap raise queued is a parked turn again: a hard stop ends it
    // below; a soft one leaves it parked on the cap, as before the raise. A
    // resume an answer queued (P9d) has nothing to park on — any Stop ends it.
    const resumeWasQueued = this.queuedResume;
    this.queuedResume = false;
    if (scope === "hard") {
      this.abortController?.abort();
      this.tasks?.killAll("stop");
      // Agent messages emptied out here will never be delivered: say so on
      // disk, or a reload would hand them back as still owed (D-88).
      this.dropInbound(this.queue);
      this.queue = [];
      // A remark that rode in on an approval belongs to the turn being stopped.
      this.pendingNote = undefined;
      // Nothing is answered here: mid-batch the head call is still running and
      // its real result will land. The calls that never run are answered when
      // the loop unwinds, in `settleStopped` — the one closer (H-10).
      this.pendingToolCalls = [];
      this.pendingApproval = undefined;
      this.pendingQuestion = undefined;
      this.pendingCompaction = undefined;
      this.pendingStall = undefined;
      this.emit({ type: "queue", queue: [] });
    }
    this.emit({ type: "stopped", scope });
    if (this.status !== "running") {
      // A suspended turn ended here is the one place a turn comes to rest with
      // no `advance` tail to say so (see below); remembered before the reset.
      // A turn whose branch ends in a call with no result (a card — whatever
      // the status says, `awaiting-persistence` included) cannot stay parked:
      // `settleStopped` answers it, so even a soft Stop has ended that turn
      // and it gets the same tail as a hard one.
      const ends =
        scope === "hard" ||
        resumeWasQueued === "answer" ||
        resumeWasQueued === "wake" ||
        (this.turnLeaf !== undefined && unansweredToolCalls(this.conversation, this.turnLeaf).length > 0);
      const endsTurn = ends && this.turnLeaf !== undefined;
      if (endsTurn) this.stoppedTurn = true;
      this.settleStopped();
      if (!ends && resumeWasQueued === "cap") this.capReached = true;
      // A hard stop of a turn that was *suspended* — a card, the round budget,
      // or parked on the spend cap — ends it here, and no `advance` tail will
      // ever run for it. So do that tail's work now: release its pin (and the
      // cap park, or a later raise would resume a turn the person stopped),
      // bump the generation so a settle tail still awaiting its title ask
      // (status idle, pin held) doesn't redo this work after us, and treat
      // this as the idle point it is — the in-view branch's config, then any
      // pick made while it was busy. The hard stop has already emptied the
      // queue, so there is nothing held to drain.
      if (ends) {
        this.turnLeaf = undefined;
        this.capReached = false;
        this.turnGen++;
        this.resyncModel();
        this.applyPendingSwitch();
        this.applyPendingMode();
        if (endsTurn) this.emit({ type: "settled", outcome: "stopped" });
      }
    }
    // else: the running advance() loop notices stopScope and settles at a safe point.
    // Idle to idle emits no `status`, yet a Stop can change how it stands at
    // rest — a cap park released is now cut off, and Wake must be offered.
    this.announceRest();
  }

  /** Clear the stop flag and settle — called once the loop unwinds. A stalled
   *  persistence write settles into its own pause instead of idle (D-46), so the
   *  session can't quietly accept new work while records are unwritten. */
  private settleStopped(): void {
    // Nothing comes to rest over a call with no result (H-10): every stopped
    // path — a card, mid-batch, a stream that finished into a Stop — ends here.
    this.closeDanglingCalls(STOPPED_CALL);
    this.stopScope = null;
    this.status = this.pendingPersistence ? "awaiting-persistence" : "idle";
  }

  /**
   * Answer every call at the turn's tip that has no result, as an error, and
   * drop whatever was waiting to run or to be decided on them. The one place a
   * dangling `tool_use` is closed (H-10, P9c). Reads the **tree**, not the loop's
   * bookkeeping, so it is right however the turn got here; and writes only on
   * the turn's own pinned branch — with no turn pinned there is nothing of this
   * session's to close, and an idle Stop must never write to the reader's branch.
   * Never called while a call is in flight: `approve` and the loop mark the
   * session `running` first, and a Stop then defers to the unwind.
   */
  private closeDanglingCalls(content: string): number {
    if (this.turnLeaf === undefined) return 0;
    const dangling = unansweredToolCalls(this.conversation, this.turnLeaf);
    for (const call of dangling) this.appendToolResult(call, content, true);
    this.pendingToolCalls = [];
    this.pendingApproval = undefined;
    this.pendingQuestion = undefined;
    return dangling.length;
  }

  /** The status to return to when a persistence fault clears: the pause it
   *  covered, or `idle`. A Stop meanwhile ended that pause, and cleared this. */
  private takeStatusBeforeFault(): SessionStatus {
    const before = this.statusBeforeFault ?? "idle";
    this.statusBeforeFault = undefined;
    // A turn that was waiting for a slot lost its place in the tree's queue
    // while it read `awaiting-persistence`. It goes back to idle — its queued
    // messages wait for the next turn to open, and a resume a raise had
    // queued is parked on the cap again, where the next raise finds it.
    // An answered turn (P9d) keeps its mark: `afterRecovery` resumes it.
    if (before === "queued") {
      if (this.queuedResume === "cap") {
        this.queuedResume = false;
        this.capReached = true;
      }
      // A Wake waiting for a slot (P9f) is simply not taken: the agent is
      // still interrupted or owed, and the next Wake finds it so.
      if (this.queuedResume === "wake") this.queuedResume = false;
      return "idle";
    }
    return before;
  }

  /** Record that these queued agent messages will never be delivered (D-88). */
  private dropInbound(removed: QueuedMessage[]): void {
    const ids = removed.flatMap((m) => (m.inbound ? [m.inbound.id] : []));
    if (ids.length > 0) this.emit({ type: "inbox-dropped", ids });
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
      this.statusBeforeFault = this.status;
      this.status = "awaiting-persistence";
    }
  }

  /** Retry the stalled writes — the disk-full recovery path (D-46). On success
   *  the backlog lands and the session returns to idle; on repeat failure it
   *  stays paused with `retryFailed` set so the banner can say so. `retryWrites`
   *  is injected by the server (it owns the store). */
  async retryPersistence(retryWrites: () => Promise<void>): Promise<boolean> {
    if (!this.pendingPersistence) throw new Error("No pending persistence fault");
    const faultId = this.pendingPersistence.id;
    let failure: Error | undefined;
    try {
      await retryWrites();
    } catch (err) {
      failure = err as Error;
    }
    // Another recovery (a second tab, a Discard) may have cleared this fault
    // while the writes were retried — and its resume may already be running. By
    // identity, not truthiness: a newer fault is not this one either. Then this
    // call has nothing left to restore, and must not write `idle` over a live
    // loop (which would let a second turn open beside it).
    if (this.pendingPersistence?.id !== faultId) return failure === undefined;
    if (failure) {
      this.pendingPersistence = { ...this.pendingPersistence, message: failure.message, retryFailed: true };
      this.emit({ type: "awaiting-persistence", fault: this.pendingPersistence });
      return false;
    }
    this.pendingPersistence = undefined;
    this.status = this.takeStatusBeforeFault();
    this.emit({ type: "persistence-recovered", discarded: 0 });
    this.startRecovery();
    return true;
  }

  /** Give up on the stalled records and carry on, accepting the loss (D-46).
   *  The explicit escape hatch — the conversation on disk will be missing these
   *  entries after a restart, which is why it is never done automatically. */
  discardPersistence(discardWrites: () => number): number {
    if (!this.pendingPersistence) throw new Error("No pending persistence fault");
    // No await between the check and the clear, so no other recovery can slip
    // in between (the race `retryPersistence` guards against).
    const discarded = discardWrites();
    this.pendingPersistence = undefined;
    this.status = this.takeStatusBeforeFault();
    this.emit({ type: "persistence-recovered", discarded });
    this.startRecovery();
    return discarded;
  }

  /** The resume a recovery set off, if any — resolves when it has run as far as
   *  its first pause or its end. Recovery itself does not wait for it. */
  private recovery: Promise<void> = Promise.resolve();
  get recovered(): Promise<void> {
    return this.recovery;
  }

  /** Run `afterRecovery` **off the request** that cleared the fault: the
   *  person's Retry/Discard answers as soon as the fault is gone, rather than
   *  staying open for the whole resumed turn (and failing with it). A failure
   *  in the resumed turn is reported on the session's stream, never thrown. */
  private startRecovery(): void {
    this.recovery = this.afterRecovery().catch((err: unknown) => {
      this.emit({ type: "error", message: `Resuming after the persistence fault failed: ${err instanceof Error ? err.message : String(err)}` });
    });
  }

  /** What the fault held back, once it clears (D-46): a cap park a raise freed
   *  meanwhile resumes (through `admit`, like any raise); otherwise agent
   *  messages that arrived during it start their turn, as a delivery would
   *  have. Back on a card, neither — they wait behind the person's decision. */
  private async afterRecovery(): Promise<void> {
    if (this.status !== "idle") return;
    if (this.queuedResume === "answer") {
      // The parent's answer landed under the fault (P9d): resume that turn now,
      // through `admit` like any agent-caused resume.
      this.status = "queued";
      return this.resumeAnswered();
    }
    if (this.capReached) return this.resumeFromCap(); // still blocked → stays parked for the next raise
    if (this.queue.some((m) => m.inbound)) await this.drainQueue();
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
    // The config invariant: idle, this asks about the branch in view; a gone
    // config throws, which the caller treats as "keep it, ask again later".
    this.alignOutOfTurn();
    const elapsedMin = Math.round(this.tasks.elapsedMs(taskId) / 60000);
    const output = this.tasks.output(taskId);
    const tail = output.length > 4000 ? "…" + output.slice(-4000) : output;
    const messages = this.wire();
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
    // Same routing as a turn (D-86): it replays the same signed history, and a
    // configured endpoint or data policy must not lapse for a side question.
    const provider = this.routing();
    if (provider) req.provider = provider;
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
        provider: result.provider,
        ...(configuredRouting(this.config).routing
          ? { routing: req.provider }
          : { pinnedTo: req.provider?.order?.[0] }),
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
    // A person's choice outranks a parent agent's change still waiting to land
    // (P9f2) — and the note that would announce it is no longer true.
    if (mode !== undefined) {
      this.pendingMode = undefined;
      this.modeNote = undefined;
    }
    this.regate(mode, approval);
  }

  private regate(mode?: Mode, approval?: ApprovalPolicy): void {
    if (mode !== undefined) this.mode = mode;
    if (approval !== undefined) this.approval = approval;
    if (this.buildGate) this.gate = this.buildGate(this.mode, this.approval);
    this.emit({ type: "mode", mode: this.mode, approval: this.approval });
  }

  /**
   * A parent agent changed this session's mode (P9f2, X-58). Between batches
   * — idle, parked, or at a pause with nothing left to run — it applies now
   * and announces itself (`mode` event) like the person's toggle. With calls
   * issued and not yet all run, it waits for the batch to drain: a call keeps
   * the mode it was issued under. `note` tells the model, at its next model
   * call; it opens no turn of its own.
   */
  setModeFromParent(mode: Mode, note: InboundMessage): void {
    this.modeNote = note;
    if (this.status !== "running" && this.pendingToolCalls.length === 0) {
      this.pendingMode = undefined;
      if (mode !== this.mode) this.regate(mode);
    } else {
      this.pendingMode = mode;
    }
  }

  /** The mode this session is at, or will be at once a parent's change waiting
   *  on a batch lands (P9f2) — what a sub-agent's own children are capped by. */
  get modeAhead(): Mode {
    return this.pendingMode ?? this.mode;
  }

  /** Land a parent's mode change held for the batch to drain (P9f2). */
  private applyPendingMode(): void {
    const mode = this.pendingMode;
    if (mode === undefined) return;
    this.pendingMode = undefined;
    if (mode === this.mode) return;
    this.regate(mode);
    this.agentHost?.modeLanded?.(this);
  }

  /** Write the mode note into the transcript (P9f2) — only where a user entry
   *  is legal: a turn being opened, or a drained batch. */
  private landModeNote(): boolean {
    const note = this.modeNote;
    if (!note) return false;
    this.modeNote = undefined;
    this.appendUserText(note.text, { id: note.id, from: note.from, kind: note.kind });
    return true;
  }

  /** Rewind / switch branches: point the active leaf at an existing entry (null
   *  = above the root, where an edit of the first message forks). The next
   *  `send()` will fork a sibling off it (D-10, D-17). Persisted.
   *
   *  Deliberately unguarded while a turn runs: navigating is passive (SPEC §27),
   *  and the running turn is pinned to the branch it started on (H-05), so this
   *  moves what you're *reading* and nothing else. */
  setActiveLeaf(entryId: string | null): void {
    if (entryId !== null && !this.conversation.entries.some((e) => e.id === entryId)) {
      throw new Error(`No such entry: ${entryId}`);
    }
    this.conversation = treeSetActiveLeaf(this.conversation, entryId);
    this.emit({ type: "active-leaf", leaf: entryId });
    // Each branch has its own prefix, so the reading moves with the leaf (X-24).
    // Derived from the branch, so this only announces what already changed — and
    // mid-turn it re-announces the *pinned* branch's figure, since that is the
    // context the in-flight request actually has (H-05).
    this.emit({ type: "context", tokens: this.contextTokens });
  }

  /** Edit-and-fork: create a sibling of `entryId` (off its parent) with new text
   *  and run a turn — the pencil-edit affordance (D-17). */
  async editFork(entryId: string, text: string): Promise<void> {
    const entry = this.conversation.entries.find((e) => e.id === entryId);
    if (!entry) throw new Error(`No such entry: ${entryId}`);
    // Refuse *before* touching the pointer (H-05): `send()` rejects a busy
    // session, and a rejected edit used to leave the leaf moved anyway.
    this.assertCanSend();
    // …and the same for a branch whose model is gone (D-87): `send()` would
    // refuse it after the pointer had moved.
    const sw = governingSwitch(this.conversation, entry.parent);
    if (sw && this.lookupConfig && !this.lookupConfig(sw.configId)) {
      throw new ModelConfigMissingError(sw.configId, sw.snapshot);
    }
    // Point at the edited entry's parent so send() appends a sibling. Routed
    // through setActiveLeaf so the move is announced and persisted like any
    // other — a silent mutation is what made the reply look lost.
    this.setActiveLeaf(entry.parent);
    await this.send(text);
  }

  /** Where the next append goes: the turn's pinned tip while a turn is in
   *  flight, else the reader's active leaf (H-05). Also the branch every wire
   *  build for the turn walks, so a mid-turn branch switch can't re-shape the
   *  request the turn is in the middle of making. */
  private get workingLeaf(): string | null {
    return this.turnLeaf !== undefined ? this.turnLeaf : this.conversation.activeLeaf;
  }

  /** The replayed window, built one way for every caller (X-25). The per-turn
   *  stamps must be identical across the live request, the compaction input and
   *  the ephemeral title/watchdog asks, or those "reuse the exact live prefix"
   *  paths (D-29) would miss the cache on a difference nobody meant to make. */
  private wire(leafId: string | null = this.workingLeaf): ChatMessage[] {
    return buildWireMessages(this.conversation, {
      system: this.systemPrompt,
      leafId,
      stamps: this.stamps,
    });
  }

  /** Append an entry to the tree and emit it for the persistence projection.
   *  With a turn in flight the parent defaults to the turn's pin (and advances
   *  it), so the turn's entries chain off each other regardless of where the
   *  active leaf has since moved. */
  private pushEntry(input: EntryInput, parent?: string | null): Entry {
    const at = parent !== undefined ? parent : this.workingLeaf;
    const { conv, entry } = appendEntry(this.conversation, input, at);
    this.conversation = conv;
    if (this.turnLeaf !== undefined) this.turnLeaf = entry.id;
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
    if (event.type === "settled") this.restedAs = event.outcome;
    for (const listener of this.listeners) listener(event);
    if (REST_MOVERS.has(event.type)) this.announceRest();
  }

  /** The last rest state announced, so a `rest` event goes out on a change only. */
  private announcedRest: RestState | null = null;

  /**
   * How this session stands at rest, read from its log (P9f, X-56 Q14) —
   * interrupted, owes-reply or quiescent; null while it is not at rest (a turn
   * under way or waiting for a slot, a card, a fault, the breaker). The branch
   * is the reader's (`activeLeaf`), which is the branch Wake resumes. A message
   * owed counts only when an agent sent it: a person's queued words wait for
   * the person.
   */
  get restState(): RestState | null {
    if (this.status !== "idle" || this.capReached) return null;
    return restStateOf(this.conversation, this.conversation.activeLeaf, this.queue.some((m) => m.inbound));
  }

  private announceRest(): void {
    const rest = this.restState;
    if (rest === this.announcedRest) return;
    this.announcedRest = rest;
    this.emit({ type: "rest", rest });
  }

  /**
   * Wake (P9f, X-56 Q14): pick up where the log says this session stopped,
   * without anyone saying anything new. An **interrupted** turn is re-sent the
   * way Retry re-sends it — pinned to the reader's branch, its open calls
   * answered first (`takeTurn`, H-10) — and an **owed** message that was never
   * delivered opens its turn as delivery would have. A quiescent session, or
   * one that is not at rest, is left alone.
   *
   * Never human input: the tool-round budget carries on (D-89). And it is an
   * agent-like start, so it goes through the tree's width cap (`admit`) — no
   * slot, it waits `queued` and the tree starts it FIFO (`startQueued`).
   *
   * Returns what happened, for the caller's summary.
   */
  wake(opts: { admitted?: boolean } = {}): { outcome: WakeOutcome; done: Promise<void> } {
    const idle = Promise.resolve();
    const rest = this.restState;
    if (rest === null) return { outcome: this.capReached || this.status === "halted" ? "blocked" : "busy", done: idle };
    if (rest === "quiescent") return { outcome: "quiescent", done: idle };
    if (this.stopScope || this.modelMissing) return { outcome: "blocked", done: idle };
    if (!opts.admitted && this.agentHost && !this.agentHost.admit(this)) {
      this.queuedResume = "wake";
      this.status = "queued";
      return { outcome: "queued", done: idle };
    }
    // Everything below is synchronous up to the turn's first await, so the
    // session reads `running` before the caller counts the next one (`admit`).
    if (restStateOf(this.conversation, this.conversation.activeLeaf, false) === "quiescent") {
      // At rest on its own reply, owed only what the inbox holds: open its turn
      // on the queue's head, as a delivery to an idle receiver does — never as
      // the person speaking, whatever else is waiting with it.
      return { outcome: "woken", done: this.drainQueue({ admitted: true, woken: true }) };
    }
    // Mid-turn on the branch: resume it as Retry would, with no Retry needed.
    this.turnLeaf = this.conversation.activeLeaf;
    try {
      this.alignToBranch();
    } catch (err) {
      this.turnLeaf = undefined; // a refused wake opens no turn
      return { outcome: "blocked", done: Promise.reject(err as Error) };
    }
    this.takeTurn(); // heals the tip (H-10) and owns the pin from here
    const opener = pathToLeaf(this.conversation, this.turnLeaf)
      .reverse()
      .find((e) => e.type === "user");
    this.turnByHuman = !(opener?.type === "user" && opener.inbound);
    this.retryable = false;
    // `consecutiveFailures` is kept: a Wake is not a person's Retry, and a root
    // waking a failing child in a loop must still reach the halt breaker.
    this.pendingStall = undefined;
    this.pendingToolCalls = [];
    return { outcome: "woken", done: this.advance() };
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
      messages: this.wire(),
    };
    if (this.tools) req.tools = this.tools.defs();
    const s = this.config.sampling;
    if (s?.temperature !== undefined) req.temperature = s.temperature;
    if (s?.topP !== undefined) req.top_p = s.topP;
    if (s?.maxTokens !== undefined) req.max_tokens = s.maxTokens;
    const reasoning = this.reasoningParam();
    if (reasoning) req.reasoning = reasoning;
    const provider = this.routing();
    if (provider) req.provider = provider;
    return req;
  }

  /**
   * The `provider` block for a request to the **working** model. A config's own
   * routing (D-86) wins outright; otherwise stick to the backend that minted the
   * reasoning signatures we're about to replay (D-49/H-02). `allow_fallbacks:
   * false` makes that pin binding: a failover would 400 on the signatures anyway,
   * so "that provider is unavailable" beats an opaque `Invalid signature`.
   *
   * Decided here, at send time, and nowhere else: the journal keeps recording
   * which backend served each turn whatever is configured, so dropping the
   * override later falls straight back to the pin. One helper for **every**
   * request to the working model — turns, the ephemeral asks, the watchdog — so
   * a title ask can never route differently from the turn whose cache it means
   * to ride (D-81). A malformed block is ignored here, not sent
   * (`configuredRouting`).
   */
  private routing(): ProviderRouting | undefined {
    const { routing } = configuredRouting(this.config);
    if (routing) return routing;
    const pin = pinnedProvider(this.conversation, this.workingLeaf);
    return pin ? { order: [pin], allow_fallbacks: false } : undefined;
  }

  /**
   * An **ephemeral ask** that rides the live prefix (D-29): the title question
   * (X-09/X-17) and the same-model compaction summary. Both append one
   * instruction to the exact live transcript and throw the answer away.
   *
   * Riding the prefix is only worth anything if the provider actually serves it
   * from cache, and the cache keys on more than the messages. Anthropic's tiers
   * invalidate top-down, so an ask must match `buildRequest()` on **every**
   * field ahead of the instruction:
   *
   *   - `tools` — tool definitions render at position 0, *ahead of* system, so
   *     omitting them changes the prompt at byte zero and forces a full rebuild.
   *     This is the defect that made every title call in this repo's history a
   *     full-price ~200k-token write (D-81).
   *   - `provider` — caches are per-deployment; an unpinned route can land on a
   *     backend that has never seen this prefix.
   *   - `reasoning` — a thinking/effort change invalidates the messages cache.
   *
   * `tool_choice` is deliberately **not** set, even though these asks want prose:
   * changing it invalidates the messages cache, which is the whole ~200k we came
   * for. The instructions tell the model not to call tools instead, and both
   * callers already treat an answer with no usable text as "no result".
   */
  private ephemeralRequest(opts: {
    model: string;
    messages: ChatMessage[];
    instruction: string;
    maxTokens: number;
  }): ChatRequest {
    const req: ChatRequest = {
      model: opts.model,
      messages: [...opts.messages, { role: "user", content: opts.instruction }],
      max_tokens: opts.maxTokens,
    };
    // Caches are model-scoped, so a cross-model compactor has no prefix to ride
    // and must not inherit a pin — or configured routing (D-86) — meant for the
    // working model's backend. With no cache to lose, `tool_choice:"none"` is
    // free here — so take the hard guarantee of prose rather than relying on
    // the instruction.
    if (opts.model !== this.config.model) {
      req.tool_choice = "none";
      return req;
    }
    if (this.tools) req.tools = this.tools.defs();
    const reasoning = this.reasoningParam();
    if (reasoning) req.reasoning = reasoning;
    const provider = this.routing();
    if (provider) req.provider = provider;
    return req;
  }

  /** Whether a new user message can open a turn right now; throws the reason if
   *  not. Split out so `editFork` can ask *before* it moves the leaf (H-05). */
  private assertCanSend(): void {
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
  }

  /**
   * The bookkeeping every turn opening shares, once its branch is pinned —
   * `openTurn` and `retry` both, so a future way of opening a turn cannot
   * forget a piece of it. The turn takes the pin and its settle (`turnGen`),
   * starts with no stale Stop, yield or queued resume, and **heals** its tip:
   * a branch can reach a new turn with a call still open — a rewind onto it,
   * a `length` cut-off mid-call, an idle pick written over one, a log older
   * than the rule — and nothing may be sent or said under it (P9c).
   */
  private takeTurn(): void {
    this.turnGen++;
    this.stoppedTurn = false;
    this.yieldTurn = false;
    this.queuedResume = false; // a parked turn a raise had queued is abandoned
    this.closeDanglingCalls(SKIPPED_CALL);
  }

  /** Send a **human-typed** message and run until the session settles or needs
   *  the user. The only door that resets the tool-round budget (D-89). */
  async send(text: string): Promise<void> {
    await this.openTurn(text, { human: true });
  }

  /**
   * Open a turn on one message. `human` is whether a person typed it — or, for a
   * queue drain, whether a person typed anything waiting in it: only human input
   * starts the D-79 budget over (D-89, X-56 Q7). An agent's message, a sub-agent's
   * completion notice and (P9f) a Wake all continue the count, so a tree that
   * keeps waking itself up still pauses at the same budget a single unattended
   * turn would.
   */
  private async openTurn(text: string, opts: { human: boolean; inbound?: InboundMeta }): Promise<void> {
    this.assertCanSend();
    // A send always opens a **new** turn on the reader's branch. A pin still
    // held here belongs to a turn that is not coming back as such — one parked
    // on the spend cap, or settling through its title ask — and resolving the
    // config against it would run this branch on that one's model. Released
    // only for as long as the resolve below takes, though: a **refused** send
    // opens no turn, so it must leave a parked turn exactly as it found it —
    // pin and all — or the cap raise that resumes it runs unpinned on
    // whatever the reader is looking at.
    const parked = this.turnLeaf;
    this.turnLeaf = undefined;
    try {
      // A user turn is an idle point (X-56 Q4): a switch picked while busy lands
      // first, and the branch's model is resolved live before anything is
      // appended — a deleted config refuses here, leaving no unanswered message.
      this.applyPendingSwitch();
      this.syncGoverningConfig(false);
    } catch (err) {
      this.turnLeaf = parked;
      throw err;
    }
    this.stopScope = null; // a fresh message clears any prior stop flag
    this.retryable = false; // ...and supersedes any failed turn waiting on a Retry
    // Pin the turn to the branch in view (H-05) before the first append, so
    // everything this turn produces chains off here no matter where the reader
    // navigates while it runs.
    this.turnLeaf = this.conversation.activeLeaf;
    this.takeTurn();
    // A fresh *human* message is a fresh turn, so the tool-round budget starts
    // over (D-79) — and it starts over *here only*: approval, ask_user and
    // compaction all resume the same turn and keep spending the same budget,
    // and an agent's message continues it (D-89).
    if (opts.human) {
      this.toolRounds = 0;
      this.iterationBudget = this.maxToolIterations;
    }
    this.turnByHuman = opts.human;
    this.pendingStall = undefined;
    // A turn's top is between batches (P9f2): a parent's mode change lands, and
    // its note goes ahead of the message that opens the turn.
    this.applyPendingMode();
    this.landModeNote();
    this.appendUserText(text, opts.inbound);
    this.pendingToolCalls = [];
    await this.advance();
  }

  /** Resolve a pending approval (approve / deny / edit-then-approve) and continue. */
  async approve(decision: ApprovalDecision): Promise<void> {
    const pending = this.pendingApproval;
    if (!pending) throw new Error("No pending approval");
    this.pendingApproval = undefined;
    // Whatever they typed alongside the decision (D-51) — held until the batch
    // drains, then appended as an ordinary user message.
    const note = decision.note?.trim();
    if (note) this.pendingNote = note;
    // Answers first (D-48): they are facts about the tool, kept whether or not
    // this call runs, and the fence check below must see them. A field the user
    // just called prose is no longer an escape, so it widens nothing.
    this.applyLearned(pending.tool, decision.learned);
    const blocked = pending.request.learn?.modeBlocked;
    if (decision.approve && blocked !== undefined) {
      // The pause existed only because the tool was presumed to write. Re-run
      // the gate against what we now know rather than trusting the approval.
      const recheck = this.gate.check(pending.tool, pending.request.args);
      if (recheck.kind === "deny") {
        this.appendToolResult(pending.call, `denied: ${recheck.reason}`, true);
        this.pendingToolCalls.shift();
        await this.advance();
        return;
      }
    }
    if (decision.approve) {
      const runArgs = decision.editedArgs ?? pending.request.args;
      const edited = decision.editedArgs !== undefined;
      // Widen the fence for any out-of-fence paths the user consented to (D-19).
      const escapes = this.fenceEscapes(pending.tool, runArgs);
      // H-08: allow-once is meaningless for a server that can remember the path.
      // Approving without choosing a root is refused rather than quietly treated
      // as "remember", because widening the fence must stay something the user
      // did on purpose and can see afterwards.
      if (escapes.length > 0 && pending.tool.classifyPaths && !decision.addRoot) {
        this.appendToolResult(
          pending.call,
          "denied: this path is outside the workspace, and it was sent to an MCP server, " +
            "which can remember it — so it cannot be allowed just once. Approve it with " +
            "\"remember this root\" to widen the workspace deliberately, or deny it.",
          true,
        );
        this.pendingToolCalls.shift();
        await this.advance();
        return;
      }
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
      // The approved tool is about to run: from here this is a running turn. A
      // Stop must see it as running — the loop then settles it with its pin,
      // rather than the stop ending a "suspended" turn that is in fact live (and
      // landing its tool result elsewhere). Set here, not when the card is
      // consumed: nothing above awaits, so no Stop can land earlier, and a throw
      // above (a failing `onAddRoot`) leaves the card's status, which a hard
      // Stop recovers. Deny and refuse paths reach running through `advance()`.
      this.status = "running";
      await this.doExecute(pending.call, pending.tool, runArgs, edited);
      this.sandbox?.clearOnce();
    } else {
      this.appendToolResult(pending.call, `denied by user${decision.reason ? `: ${decision.reason}` : ""}`, true);
    }
    this.pendingToolCalls.shift();
    await this.advance();
  }

  /** Provide the answer(s) to a pending question and continue (D-18). A bare
   *  string answers a single-question form verbatim (the tool result is exactly
   *  that text); an array carries per-question answers for a multi-question form.
   *
   *  A blank answer is a **decline** and is legal — that is the escape D-72 is
   *  about — except where the model marked the question `required`, which is
   *  enforced here rather than only in the card, so the flag means the same
   *  thing to every frontend. */
  async answer(payload: string | AskUserAnswer[]): Promise<void> {
    const pending = this.pendingQuestion;
    if (!pending) throw new Error("No pending question");
    const questions = pending.request.questions;
    if (Array.isArray(payload) && payload.length === questions.length) {
      const missing = questions.find((q, i) => q.required === true && isBlankAnswer(payload[i]!));
      if (missing) throw new Error(`This question requires an answer: ${missing.question}`);
    }
    this.pendingQuestion = undefined;
    this.appendToolResult(pending.call, formatAnswers(payload, questions), false);
    this.pendingToolCalls.shift();
    await this.advance();
  }

  /** Append one user entry mid-run and announce it (the shared seam behind the
   *  approval note and the mid-run queue drain). */
  private appendUserText(text: string, inbound?: InboundMeta): void {
    const entry = this.pushEntry(inbound ? { type: "user", text, inbound } : { type: "user", text });
    this.emit({ type: "user", entryId: entry.id, text });
  }

  /** Land everything the user has said that is waiting to enter the conversation:
   *  a remark that rode in on an approval decision (D-51), then the pending queue
   *  (D-52 — **all** of it, in order, so three things typed while waiting are all
   *  seen before the model re-plans).
   *
   *  Only safe with no tool call outstanding: tool results must follow their
   *  assistant message unbroken, so every call site is guarded by a drained
   *  batch. The queue is held back behind a stop — a stopped loop takes no
   *  further turn, so injecting there would strand the message unanswered. */
  private flushPendingUser(): boolean {
    // Nothing is said over an unanswered call (D-79/D-84). Stopping, the calls
    // that will never run are closed first, so a note lands after them; not
    // stopping, a dangling call here is a loop bug — refuse to write it.
    const dangling = this.turnLeaf === undefined ? [] : unansweredToolCalls(this.conversation, this.turnLeaf);
    if (dangling.length > 0) {
      if (!this.stopScope) {
        throw new Error(`invariant: about to append a message over ${dangling.length} unanswered tool call(s)`);
      }
      this.closeDanglingCalls(STOPPED_CALL);
    }
    // Between batches: a parent's mode change held for this one lands now, so
    // the next request is made under it (P9f2).
    this.applyPendingMode();
    let landed = false;
    if (this.pendingNote) {
      const text = this.pendingNote;
      this.pendingNote = undefined;
      this.appendUserText(text);
      landed = true;
    }
    if (!this.stopScope && this.queue.length > 0) {
      const pending = this.queue;
      this.queue = [];
      this.emit({ type: "queue", queue: [] });
      for (const m of pending) this.appendUserText(m.text, m.inbound);
      landed = true;
    }
    // The mode note (P9f2) lands only where a model call follows: not on a
    // stopped loop, and not on a turn about to yield after a spawn with nothing
    // else said — it is never `spoken` itself, so it cannot keep a yielding
    // turn going (an extra billed call). It waits for the next turn's top.
    if (!this.stopScope && (!this.yieldTurn || landed)) this.landModeNote();
    return landed;
  }

  /** Run the loop, then release the turn's branch pin unless the turn is merely
   *  suspended and will be resumed (H-05). An approval / question / compaction
   *  pause — and a spend-cap block, which settles to `idle` but resumes on
   *  `setSpendCap` — all continue the *same* turn, so the pin has to outlive
   *  them; anything else has ended the turn. */
  private async advance(): Promise<void> {
    const gen = this.turnGen;
    try {
      await this.runLoop();
    } finally {
      // A newer turn opened while this one ran its tail: the pin, the status
      // and the settle are that turn's now (see `turnGen`).
      const stale = gen !== this.turnGen;
      // Every issued call has run (or none was issued): a mode a parent set
      // during the turn's last model call applies here, at rest (P9f2).
      if (!stale && this.pendingToolCalls.length === 0) this.applyPendingMode();
      const suspended =
        this.status === "awaiting-approval" ||
        this.status === "awaiting-input" ||
        this.status === "awaiting-compaction" ||
        this.status === "awaiting-continue" ||
        this.capReached;
      if (!suspended && !stale) {
        this.turnLeaf = undefined;
        this.resyncModel(); // the reader may have moved while the turn ran
        // The turn is over — the other idle point a pending switch waits for —
        // and a queue held for a missing model can go once one is written.
        if (this.applyPendingSwitch()) await this.drainQueue();
        // At rest, and still this turn's to report: no newer turn opened from
        // the queue in the meantime (that one reports for itself), nothing is
        // waiting for a slot. This is what a sub-agent's parent hears (D-88).
        if (gen === this.turnGen && (this.status === "idle" || this.status === "halted")) {
          const outcome = this.stoppedTurn ? "stopped" : this.status === "halted" || this.retryable ? "failed" : "finished";
          this.emit({ type: "settled", outcome });
        }
      }
    }
  }

  private async runLoop(): Promise<void> {
    const gen = this.turnGen;
    this.status = "running";
    if (this.pendingToolCalls.length === 0) this.flushPendingUser();
    // Unbounded by construction (D-79). What used to end the turn here was a
    // `for` over `maxToolIterations` that simply *fell out the bottom* into the
    // same code as a finished answer: no event, no journal line, and the last
    // batch of tool calls left un-run. The budget now lives on `toolRounds` and
    // is spent at the one point where stopping costs nothing — before the next
    // model call, with every tool call already executed and its result landed.
    for (;;) {
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
          // A question for the parent agent goes to it now that this session is
          // paused (P9d) — its reply is the answer. The person can answer too.
          const asked = this.pendingQuestion?.request;
          if (asked?.to === "parent") this.agentHost?.askParent?.(this, asked);
          return;
        }
        this.pendingToolCalls.shift(); // "done" → dequeue
      }
      // Batch drained — this is the turn boundary (D-34). Anything the user has
      // said since lands *here*, before the next LLM call, so a queued message
      // steers the run it was typed during instead of arriving after it (D-52).
      const spoken = this.flushPendingUser();

      // A stop requested *during* this iteration's tool run (soft or hard): take
      // no further LLM turn. Running commands were allowed to finish above.
      if (this.stopScope) return this.settleStopped();

      // A sub-agent was spawned in this batch (X-56 Q5): the parent's turn ends
      // here, like a turn waiting on the user — its children report back by
      // message. Unless someone just said something, which the model must see.
      if (this.yieldTurn) {
        this.yieldTurn = false;
        if (!spoken) break;
      }

      // Spend cap (D-33): at/over the cap, decline the next LLM call. Kill
      // nothing; just pause so the user can raise the cap (which resumes us).
      if (this.capBlocked()) {
        this.capReached = true;
        this.emit({ type: "cap-reached", spendUsd: this.spendUsd, capUsd: this.spendCapUsd! });
        this.status = "idle";
        return;
      }

      // Out of budget (D-79). Every tool call this turn issued has run and its
      // result is on the tree, so the pause costs nothing to hold and nothing to
      // resume — Continue simply takes the next turn on a doubled budget.
      // Unless it is switched off (P9d, D-89): the root's config says
      // `--tool-rounds off`, or someone chose "don't ask again" on this thread
      // or above it. The spend cap above is then the only brake.
      if (this.toolRounds >= this.iterationBudget) {
        if (!this.roundsOff) {
          this.raiseStallPause();
          return;
        }
        // Unbraked, a round whose driver and tools never touch I/O (the fake
        // driver, a sync tool refusal) would hold the event loop for good: no
        // Stop request, no log write, no timer could land. Past the budget,
        // give the rest of the process a turn before every further round.
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (this.stopScope) return this.settleStopped();
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

      // Resolve the branch's model live before the next request (D-87). A config
      // deleted mid-turn ends the turn here, with the reason, rather than
      // sending under a substitute.
      try {
        this.syncGoverningConfig(true);
      } catch (err) {
        if (!(err instanceof ModelConfigMissingError)) throw err;
        // Nothing was sent, so after a pick the same prefix can simply go (D-57).
        this.retryable = true;
        this.emit({ type: "error", message: err.message, retryable: true });
        this.status = "idle";
        return;
      }

      // Name the thread as soon as there is something to name (X-09), rather
      // than only when the run settles: an autonomous run's *first* settle can
      // be 190 messages in, and the ask is billed against whatever the prefix is
      // by then. Every first title in this repo's history but four landed past
      // message 30; the one that fired at message 7 cost $0.012 against
      // $0.51-$2.47 for the rest (D-81). `maybeAutoTitle` is called at the settle
      // below too; the trigger is idempotent, so this fires once and then no-ops.
      //
      // **Here** is the one early place it can fire, and that is not incidental
      // (D-84): the ask appends a user message to the live window, so it is only
      // sendable where no tool call is outstanding. That is this boundary — the
      // batch has drained and the next live call is about to go out with exactly
      // this prefix, so the ask also writes the cache that turn then reads.
      await this.maybeAutoTitle();

      const result = await this.assistantTurnWithRestart();
      this.toolRounds++; // spent whether or not it answered — a failed round is a round
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
    await this.maybeAutoTitle();
    // Status read `idle` through that await, so a new turn may have opened in
    // it; if so, everything below is that turn's to do (see `turnGen`).
    if (gen !== this.turnGen) return;
    // The turn is over: release its branch pin here rather than in `advance`,
    // so the queued turn below starts from a true idle point — a switch picked
    // while busy lands *before* it, not after it (X-56 Q4).
    this.turnLeaf = undefined;
    this.resyncModel(); // the reader may have moved while the turn ran
    this.applyPendingSwitch();
    await this.drainQueue();
  }

  /** Where this session's active branch stands, for the title trigger (X-17).
   *  Derived from the tree like `contextTokens` rather than counted into a
   *  field, so a fork, a rewind or a branch switch is measured on the branch in
   *  view instead of on whatever the last turn happened to build. */
  private branchTitleMark(): TitleMark {
    const branch = pathToLeaf(this.conversation, this.workingLeaf);
    let turns = 0;
    let folds = 0;
    for (const entry of branch) {
      if (entry.type === "user") turns++;
      else if (entry.type === "compaction") folds++;
    }
    return { turns, folds };
  }

  /** Should we spend a title call at this settle? (X-09's first name, X-17's
   *  re-title.) Everything expensive about this feature is decided here. */
  private shouldTitleNow(): boolean {
    if (!this.autoTitle) return false;
    // A name a person chose is **never** overwritten (X-17 (c)). Silently
    // undoing someone's rename is a worse failure than a stale label, and
    // X-12b just made renaming a one-click affordance.
    if (this.conversation.titleSource === "manual") return false;
    // Nothing worth naming until the model has actually said something.
    if (!this.conversation.entries.some((e) => e.type === "assistant" && e.text.trim() !== "")) return false;
    const mark = this.titleMark;
    if (!mark) return true; // never named, never asked — X-09's one shot
    // Opting out of drift re-titling still leaves a failed *first* attempt free
    // to try again later; what it pins is a name that actually landed.
    if (this.conversation.title && !this.autoRetitle) return false;
    return driftedEnough(mark, this.branchTitleMark());
  }

  /** Name the conversation (X-09), and re-name it as it drifts (X-17). Joshua's
   *  design: once the first exchange has happened, tag an **ephemeral** question
   *  onto the end of the live conversation — asked of the active model, never
   *  appended to the tree — so the title comes from the real context without
   *  flattening or re-shaping anything, and the prompt-cache reuse that makes
   *  same-model compaction cheap (D-29, via `ephemeralRequest`) pays for most
   *  of it. A failure is swallowed: a label is a nicety and must never cost
   *  a turn.
   *
   *  X-17 makes this repeatable rather than once-per-session, on the trigger in
   *  `shouldTitleNow` / `driftedEnough` — geometric growth plus "a fold is
   *  drift", so a long thread pays ~log2(turns) title calls over its life. The
   *  re-ask carries the current name and may answer with it unchanged, in which
   *  case nothing is emitted, written, or re-rendered. */
  private async maybeAutoTitle(): Promise<void> {
    if (!this.shouldTitleNow()) return;
    if (this.stopScope || this.capBlocked()) return; // don't spend past a stop/cap
    // An ask appends a user message, which an unanswered tool call forbids
    // (D-84) — the provider rejects the whole request before reading a word of
    // it. The loop calls this where the batch has drained, so this guard is for
    // the paths that don't: a `length` cut-off mid-tool-call settling to idle.
    const messages = this.wire();
    if (endsWithUnansweredToolCall(messages)) return;
    // Mark *before* the call: the spend has happened either way, so a failure
    // (or a "keep the name" answer) backs off on the same schedule instead of
    // re-asking at every settle.
    this.titleMark = this.branchTitleMark();

    const req = this.ephemeralRequest({
      model: this.config.model,
      messages,
      instruction: buildTitleInstruction(this.conversation.title),
      maxTokens: TITLE_MAX_TOKENS,
    });
    const startedAt = Date.now();
    const events: StreamEvent[] = [];
    // Its own controller, so a hard Stop (which aborts the current one) cuts
    // the ask short rather than waiting it out.
    this.abortController = new AbortController();
    try {
      for await (const ev of this.driver.streamChat(req, { signal: this.abortController.signal })) events.push(ev);
    } catch (err) {
      // A failed title costs the thread nothing but its name — and it used to
      // cost that *silently*: a thrown ask wrote no journal line at all, which
      // is how D-84 went a week with every title rejected and no trace of it
      // anywhere. The line below is the trace.
      this.emit({
        type: "debug",
        record: {
          kind: "llm",
          ms: Date.now() - startedAt,
          model: req.model,
          messages: req.messages.length,
          tools: (req.tools ?? []).map((t) => t.function.name),
          error: `[title] ${err instanceof Error ? err.message : String(err)}`,
        },
      });
      return; // no title this time; the thread just stays unnamed
    }
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
        tools: (req.tools ?? []).map((t) => t.function.name),
        finishReason: result.finishReason,
        usage: result.usage,
        textPreview: `[title] ${result.text.slice(0, 160)}`,
      },
    });
    const title = sanitizeTitle(result.text);
    // An unchanged answer is the *expected* one for a thread that hasn't
    // drifted — write nothing, so the index takes no record and the rail card
    // doesn't blink (X-17 (d)).
    if (title && title !== this.conversation.title) this.setTitle(title, "auto");
  }

  /** Set the thread's label (X-09). `manual` is the browser's inline rename;
   *  persistence is the caller's concern (the server projects the event). A
   *  manual name **pins** — `titleSource` rides on the conversation and is
   *  persisted with the title record, so the drift re-title (X-17) leaves it
   *  alone in this session and after a resume. */
  setTitle(title: string, source: "auto" | "manual" = "manual"): void {
    const clean = sanitizeTitle(title);
    if (!clean) throw new Error("Title is empty.");
    this.conversation.title = clean;
    this.conversation.titleSource = source;
    this.titleMark = this.branchTitleMark(); // drift is measured from this name
    this.emit({ type: "title", title: clean, source });
  }

  // ---- Queued message (D-34): typed mid-turn, applied at a turn boundary — the
  // boundary being **each pass of the tool loop** (D-52), not the settle to idle.

  /** Queue a message to apply at the next turn boundary. If the session is idle,
   *  it is sent right away (the boundary is now) — unless `openTurn` is false,
   *  which parks it for whenever a turn next happens.
   *
   *  Parking exists for machine-written notices (the todo nudge, X-31): the
   *  person edited a list in their own browser, and turning that into a paid
   *  model call they never asked for is not a notification, it's a bill. Parked
   *  or not, `flushPendingUser` lands it before the next LLM call either way. */
  async enqueue(text: string, opts: { openTurn?: boolean } = {}): Promise<void> {
    // A parked message is JLCode's own (the todo nudge) — not human input, so it
    // must never count as the human speaking when a turn later drains it (D-89).
    this.queue.push(opts.openTurn === false ? { id: newId("q"), text, machine: true } : { id: newId("q"), text });
    this.emit({ type: "queue", queue: [...this.queue] });
    if (this.status === "idle" && opts.openTurn !== false) await this.drainQueue();
  }

  /** Replace the pending queue wholesale — the UI's edit/cancel affordance. */
  setQueue(messages: { text: string }[]): void {
    // The browser edits by text alone. An agent message it hands back unchanged
    // keeps its attribution; one it dropped is recorded as never delivered
    // (D-88); one it edited is now the person's own words.
    const before = [...this.queue];
    this.queue = messages.map((m) => {
      const at = before.findIndex((q) => q.text === m.text && (q.inbound || q.machine));
      if (at >= 0) return before.splice(at, 1)[0]!;
      return { id: newId("q"), text: m.text };
    });
    this.dropInbound(before);
    this.emit({ type: "queue", queue: [...this.queue] });
  }

  /** Settle-time drain: start a fresh turn from the head of the queue, unless
   *  stopped or cap-blocked. A running loop no longer relies on this — it flushes
   *  the queue at each pass (D-52) — but a message that arrives *after* the last
   *  LLM call of a run still needs a turn opened for it, and that is this. The
   *  rest of the queue rides along: `send` → `advance` flushes it before the
   *  first LLM call, so the whole backlog lands together. */
  private async drainQueue(opts: { admitted?: boolean; woken?: boolean } = {}): Promise<void> {
    if (this.status !== "idle" || this.stopScope || this.capReached) return;
    // A thread whose model is gone keeps its queue rather than drop the head
    // into a send that refuses it (D-87); picking a model is what unblocks it.
    if (this.modelMissing) return;
    const next = this.queue[0];
    if (!next) return;
    // Whether a person said any of this (D-89): they reset the budget, and they
    // never wait behind the tree's concurrency cap — a turn of agent traffic
    // does, `queued`, until the coordinator starts it (`startQueued`).
    // A Wake is never the person speaking (P9f, D-89), whatever is queued.
    const human = !opts.woken && this.queue.some((m) => !m.inbound && !m.machine);
    if (!human && !opts.admitted && this.agentHost && !this.agentHost.admit(this)) {
      this.status = "queued";
      return;
    }
    this.queue.shift();
    this.emit({ type: "queue", queue: [...this.queue] });
    await this.openTurn(next.text, { human, inbound: next.inbound });
  }

  // ---- The shared todo list (X-31): state folded from ops on this branch.

  /** The list as it stands on the branch in play — the turn's, while one is in
   *  flight; the reader's otherwise (H-05). */
  get todos(): TodoItem[] {
    return todosOn(this.conversation, this.workingLeaf);
  }

  /** The handle every tool call is given. Reads clear the barrier; writes are
   *  refused while it is armed. */
  private get todoAccess(): TodoAccess {
    return {
      read: () => {
        this.todoSeen = todoTip(this.conversation, this.workingLeaf);
        return this.todos;
      },
      write: (input) => this.writeTodos(input),
    };
  }

  /**
   * An agent write, guarded by the read barrier.
   *
   * The barrier is armed whenever the branch's newest todo op is not the one the
   * agent last saw — it has never looked, or the person has edited since, or the
   * reader has moved to a branch whose list says something else. It is **causal,
   * not temporal**: nothing can hang on it, because the agent holds the key.
   * The refusal carries the current list, which *is* the look it was missing —
   * so the barrier costs exactly one refused call, and the retry is made against
   * the truth instead of against memory. That is the property that made this
   * beat the edit-mode freeze first proposed.
   */
  private writeTodos(input: TodoWriteInput): TodoWriteResult {
    const items = this.todos;
    const tip = todoTip(this.conversation, this.workingLeaf);
    if (this.todoSeen !== tip) {
      this.todoSeen = tip; // one look clears it — and this refusal is that look
      return {
        ok: false,
        error:
          (this.todoSeen === null && items.length === 0
            ? "Refused: read the todo list before writing to it."
            : "Refused: the todo list has changed since you last read it.") +
          ` Here it is — re-issue your write against this.\n\n${renderTodoList(items)}`,
      };
    }
    const plan = planTodoWrite(items, input);
    if (!plan.ok) return plan;
    this.appendTodoOps(plan.ops, "agent");
    return { ok: true, items: plan.items, changed: plan.changed };
  }

  /** Record todo ops on the branch and announce the new list. An agent write
   *  also counts as seen: it knows what it just did. */
  private appendTodoOps(ops: TodoOp[], by: "agent" | "user"): void {
    const entry = this.pushEntry({ type: "todo", ops, by });
    if (by === "agent") this.todoSeen = entry.id;
    this.emit({ type: "todos", items: this.todos });
  }

  /**
   * The person's commit from the browser — the whole list as they left it.
   *
   * Their edit is a snapshot rather than a stream of keystrokes, because that is
   * what leaving edit mode means: this is the list now. It enqueues a message
   * telling the agent the list changed and **what** changed — a capped diff, not
   * the list itself (D-77): the census alone left the agent to re-read before it
   * could tell whether the edit touched its work. Delivery stays pull, so the
   * full list is still a `todo_read` away. Returns false when nothing changed,
   * in which case nobody is told anything.
   */
  async setTodos(rows: { id?: string; text: string; done?: boolean; note?: string }[]): Promise<boolean> {
    const before = this.todos;
    const op = planTodoSnapshot(before, rows);
    if (!op) return false;
    this.appendTodoOps([op], "user");
    // A pure re-order changes the list without changing any item, so it has a
    // real diff of no lines — say that rather than queueing a bare census.
    const diff = renderTodoDiff(before, this.todos);
    const what = diff.length > 0 ? diff.map((l) => `  ${l}`).join("\n") : "  (the items were re-ordered)";
    await this.enqueue(
      `[todo] The user edited the todo list — ${todoCensus(this.todos)}.\n${what}\nCall ${TODO_READ} for the full list.`,
      { openTurn: false },
    );
    return true;
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

  /** Run one assistant turn, honoring a Retry that arrives while it is in flight
   *  (D-57). The abort surfaces as an empty turn with `restartRequested` set, and
   *  we send the identical prefix again — same shape as the over-window
   *  compact-and-retry it wraps, and bounded the same way: each click sets the
   *  flag once, so this loops exactly as often as the user asks it to. */
  private async assistantTurnWithRestart(): Promise<AssistantResult | undefined> {
    for (;;) {
      const result = await this.assistantTurnWithCompaction();
      if (!this.restartRequested) return result;
      this.restartRequested = false;
      // The abandoned attempt landed anyway — it finished in the gap between the
      // click and the abort. Its entry is already in the tree, so take it rather
      // than asking the model the same thing twice.
      if (result) return result;
    }
  }

  /** Wait between automatic attempts without going deaf: a Stop or a manual
   *  Retry during the backoff cuts it short, rather than making the user watch
   *  out a countdown they have already decided against. False → interrupted. */
  private async backOff(ms: number): Promise<boolean> {
    const step = 100;
    for (let waited = 0; waited < ms; waited += step) {
      if (this.stopScope || this.restartRequested) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(step, ms - waited)));
    }
    return !this.stopScope && !this.restartRequested;
  }

  /**
   * Re-attempt the current turn (D-57) — the Retry button.
   *
   * One act with three doors into it, because the work is identical in all
   * three: a failed or abandoned attempt appends **nothing** to the tree, so
   * re-running the loop rebuilds the very same wire prefix from the very same
   * leaf. Retry never edits history; it just asks again.
   *
   *  - **idle after an error** — send it again.
   *  - **`halted`** — the breaker counts *consecutive* failures, and a person
   *    deliberately asking again is the discontinuity that count is measuring;
   *    reset it and send.
   *  - **running** — the request looks hung: abort the stream and re-send.
   *    Only the LLM request is aborted. Background tasks keep running and the
   *    queue is untouched — killing those is Stop's job (D-34), and someone who
   *    wanted that would have reached for the red button.
   *
   * Retries the branch **in view**: the failed turn released its pin when it
   * ended, so the reader's pointer is the honest answer to "which turn?" (D-54).
   */
  async retry(): Promise<void> {
    if (this.status === "running") {
      if (!this.streaming) {
        throw new Error("No model request is in flight — a tool or command is running. Use Stop, or kill the task.");
      }
      this.restartRequested = true;
      this.abortController?.abort();
      return; // the in-flight turn observes the flag and re-sends itself
    }
    if (this.status !== "idle" && this.status !== "halted") {
      throw new Error(`Cannot retry while ${this.status}.`);
    }
    if (!this.retryable) throw new Error("Nothing to retry — the last turn did not fail.");
    // The retried branch may not be the one that failed — the reader can
    // rewind after a failure — so a config that belongs to **another** branch
    // is replaced first (D-87): a retry must never replay one model's signed
    // reasoning to another. A config that does belong here is kept exactly as
    // before this slice: a retry resumes a cycle, and handing it a re-bound
    // model there is D-82a's forbidden mid-cycle switch. Pinned first, so a
    // re-resolve keeps the turn's round budget (D-79). A branch whose config is
    // gone refuses here, typed, so the picker opens; the turn stays retryable.
    const missing = this.modelMissing;
    if (missing) throw missing;
    const prior = this.turnLeaf;
    this.turnLeaf = this.conversation.activeLeaf;
    try {
      this.alignToBranch();
    } catch (err) {
      this.turnLeaf = prior; // a refused retry opens no turn
      throw err;
    }
    this.takeTurn(); // the retried turn owns the pin from here
    // Who opened the retried turn, for an `ask` with no `to` (P9d): its last
    // user entry — the message the failed request was answering.
    const opener = pathToLeaf(this.conversation, this.turnLeaf)
      .reverse()
      .find((e) => e.type === "user");
    this.turnByHuman = !(opener?.type === "user" && opener.inbound);
    this.retryable = false;
    this.consecutiveFailures = 0;
    this.stopScope = null;
    await this.advance();
  }

  private async oneAssistantTurn(): Promise<AssistantResult | undefined> {
    // No model call after a Stop — whichever caller reached here: the loop
    // after an in-loop title ask, the forced-compaction retry, the D-57
    // restart. The caller settles, and `settleStopped` closes the batch.
    if (this.stopScope) return undefined;
    const req = this.buildRequest();
    const toolNames = (req.tools ?? []).map((t) => t.function.name);
    // Attempt loop (D-57). A *transient* failure — rate limited, gateway blip,
    // socket reset — is re-sent automatically rather than surfaced as something
    // the user has to click through: the request was fine, the provider merely
    // wasn't. Failures that say something true about the request or the account
    // (402 no credits, 401, 400) fall straight through on the first attempt,
    // because retrying a fact does not change it.
    let events: StreamEvent[] = [];
    // Per-attempt, so each journal record times the attempt it belongs to rather
    // than the whole retried sequence.
    let startedAt = Date.now();
    for (let attempt = 1; ; attempt++) {
      events = [];
      startedAt = Date.now();
      // Re-announced per attempt: `assistant-start` resets the browser's live
      // overlay, so a re-send starts from an empty bubble instead of appending
      // to the half-streamed text of the attempt we just abandoned.
      this.emit({ type: "assistant-start", parent: this.workingLeaf });
      this.abortController = new AbortController();
      this.streaming = true;
      try {
        for await (const ev of this.driver.streamChat(req, { signal: this.abortController.signal })) {
          events.push(ev);
          if (ev.type === "text") this.emit({ type: "text", delta: ev.delta });
          else if (ev.type === "reasoning") this.emit({ type: "reasoning", delta: ev.delta });
        }
        break; // streamed clean — fall through to accumulate it
      } catch (err) {
        // A Retry landed while this request was in flight (D-57) — the user
        // called it hung. The abort is a restart, not a failure: unwind with
        // nothing counted and let the wrapper send the identical prefix again.
        if (this.restartRequested) return undefined;
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
        // A rate limit has no attempt cap (D-95): it is a "not now", so the
        // session keeps backing off until capacity frees up or someone stops it.
        const unlimited = isRateLimitError(err);
        if ((unlimited || attempt <= this.maxAutoRetries) && isTransientError(err)) {
          const delayMs = this.autoRetryDelay(err, attempt);
          this.emit({
            type: "retrying",
            attempt,
            of: unlimited ? null : this.maxAutoRetries,
            delayMs,
            message: (err as Error).message,
          });
          this.emit({
            type: "debug",
            record: {
              kind: "llm",
              ms: Date.now() - startedAt,
              model: req.model,
              messages: req.messages.length,
              tools: toolNames,
              error: `[transient — auto-retry ${attempt}/${unlimited ? "∞" : this.maxAutoRetries} in ${delayMs}ms] ${(err as Error).message}`,
            },
          });
          if (await this.backOff(delayMs)) continue;
          return undefined; // a stop or a manual Retry cut the wait short
        }
        this.consecutiveFailures++;
        // Nothing was appended, so the branch still ends at the message this
        // request was answering: a Retry can send it again as-is (D-57).
        this.retryable = true;
        this.emit({ type: "error", message: (err as Error).message, retryable: true });
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
          this.emit({ type: "halted", reason: `${this.consecutiveFailures} consecutive failures`, retryable: true });
        } else {
          this.status = "idle";
        }
        return undefined;
      } finally {
        this.streaming = false;
      }
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
      provider: result.provider,
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
        provider: result.provider,
        ...(configuredRouting(this.config).routing
          ? { routing: req.provider }
          : { pinnedTo: req.provider?.order?.[0] }),
        finishReason: result.finishReason,
        truncated: result.finishReason === "length",
        usage: result.usage,
        textPreview: result.text.slice(0, 200),
        reasoningPreview: result.reasoningText?.slice(0, 200),
        entryId: entry.id,
      },
    });
    this.consecutiveFailures = 0;
    this.retryable = false; // a turn landed — there is no failed attempt to redo
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

  /** `attachments` carries non-text output (P8b) onto the entry, because the wire
   *  is rebuilt from the tree — an image kept only on the live `ToolResult` would
   *  be gone by the next turn, let alone the next resume. */
  private appendToolResult(
    call: ToolCall,
    content: string,
    isError: boolean,
    attachments?: Attachment[],
    files?: SharedFile[],
  ): void {
    this.pushEntry({
      type: "tool",
      toolCallId: call.id,
      name: call.function.name,
      content,
      isError,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(files && files.length > 0 ? { files } : {}),
    });
    this.emit({ type: "tool-end", name: call.function.name, isError });
  }

  /** Who an `ask` goes to (P9d, X-56 Q16). Omitted → whoever opened the
   *  current turn: the person for one they typed, the parent agent for one an
   *  agent's message or notice opened — so a question a sub-agent cannot
   *  answer climbs to its own questioner, up to the person at the root. A
   *  session with no parent agent asks the person, and is refused `parent`. */
  private addressee(raw: unknown): "user" | "parent" | { refused: string } {
    const hasParent = this.agentHost !== undefined && (this.agentInfo?.parentSessionId ?? null) !== null;
    const wanted = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (wanted === "") return this.turnByHuman || !hasParent ? "user" : "parent";
    if (wanted === "user" || wanted === "human") return "user";
    if (wanted === "parent") {
      return hasParent
        ? "parent"
        : { refused: 'ask refused: you have no parent agent — ask the user (to: "user"). Nothing was asked.' };
    }
    return { refused: `ask refused: \`to\` is "user" or "parent", not ${JSON.stringify(raw)}. Nothing was asked.` };
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

    // The question tool is intercepted — it pauses for the answer (D-18). Its
    // old name, `ask_user`, still is: logs before P9d are full of it.
    if (isAskTool(call.function.name)) {
      const to = this.addressee(args.to);
      if (typeof to !== "string") {
        this.appendToolResult(call, to.refused, true);
        return "done";
      }
      const request: AskUserRequest = {
        id: newId("ask"),
        questions: parseAskQuestions(args),
        ...(to === "parent" ? { to } : {}),
      };
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
      // A presumed-writing MCP tool blocked *because* it is presumed to write
      // (D-48): the block rests on a guess JLCode made, and denying is a
      // different outcome from running, so this is worth stopping for. Answering
      // "read-only" reclassifies the tool and the call proceeds; "writes" denies
      // it, permanently. The second check confirms the guess is the only reason.
      if (tool.writeUnknown?.() === true && this.gate.check({ ...tool, kind: "read", mutates: false }, args).kind !== "deny") {
        return this.pauseForApproval(call, tool, args, decision.reason, [], { askWrite: true, modeBlocked: decision.reason });
      }
      this.appendToolResult(call, `denied: ${decision.reason}`, true);
      return "done";
    }

    // Soft fence (D-19): out-of-fence paths need explicit consent, so they force
    // a prompt even if the mode/approval gate would otherwise allow.
    const escapes = this.fenceEscapes(tool, args);
    if (decision.kind === "prompt" || escapes.length > 0) {
      const reason = escapes.length > 0 ? "access outside the workspace" : "approval required by policy";
      return this.pauseForApproval(call, tool, args, reason, escapes, this.learnRequest(tool, args, escapes));
    }

    await this.doExecute(call, tool, args, false);
    return "done";
  }

  /** Raise the approval pause, optionally carrying questions to settle (D-48). */
  private pauseForApproval(
    call: ToolCall,
    tool: Tool,
    args: Record<string, unknown>,
    reason: string,
    escapes: { arg: string; escapedPath: string }[],
    learn?: LearnRequest,
  ): StepOutcome {
    // A tool may render itself better than its JSON does (D-53 — apply_edits
    // shows a unified diff). Advisory only, and never allowed to break the
    // pause: a throwing preview costs the diff, not the approval.
    let preview: ToolPreview | undefined;
    if (tool.preview && this.sandbox) {
      try {
        preview = tool.preview(args, { sandbox: this.sandbox, tasks: this.tasks });
      } catch {
        preview = undefined;
      }
    }
    const request: ApprovalRequest = {
      id: newId("appr"),
      tool: tool.name,
      kind: tool.kind,
      args,
      reason,
      ...(escapes.length > 0
        ? {
            outOfFence: {
              paths: escapes.map((e) => e.escapedPath),
              // Parallel to `paths` — which arg produced each escape, so the UI
              // can drop one the user just reclassified as prose (D-48).
              fields: escapes.map((e) => e.arg),
              suggestedRoot: path.dirname(escapes[0]!.escapedPath),
              // A bridged tool (the one that classifies its own args, D-47d) can
              // remember what it is given, so a one-shot grant is unenforceable
              // past this call — H-08.
              ...(tool.classifyPaths ? { requiresRoot: true } : {}),
            },
          }
        : {}),
      ...(learn ? { learn } : {}),
      ...(preview ? { preview } : {}),
    };
    this.pendingApproval = { request, call, tool };
    this.emit({ type: "awaiting-approval", request });
    return "paused-approval";
  }

  /**
   * What this pause can also settle (D-48): whether the tool writes (when that
   * is still a guess) and which unclassified slashy args are really paths. Both
   * only ever ride along — `tryExecute` has already decided to stop.
   */
  private learnRequest(
    tool: Tool,
    args: Record<string, unknown>,
    escapes: { arg: string; escapedPath: string }[],
  ): LearnRequest | undefined {
    const askWrite = tool.writeUnknown?.() === true;
    const escaped = new Set(escapes.map((e) => e.arg));
    const fields = (tool.classifyPaths?.(args).unknown ?? []).map((u) => ({
      field: u.field,
      value: u.value,
      ...(escaped.has(u.field) ? { escapes: true } : {}),
    }));
    if (!askWrite && fields.length === 0) return undefined;
    return { ...(askWrite ? { askWrite: true } : {}), ...(fields.length > 0 ? { fields } : {}) };
  }

  /** Persist the answers a pause collected, before anything acts on them (D-48). */
  private applyLearned(tool: Tool, learned: LearnAnswers | undefined): void {
    if (!learned) return;
    if (learned.writes !== undefined) tool.rememberWrite?.(learned.writes);
    for (const [field, isPath] of Object.entries(learned.fields ?? {})) {
      tool.rememberPathField?.(field, isPath);
    }
  }

  /** Path args of a tool call that fall outside the fence (D-19). Native tools
   *  declare `pathArgs`; MCP tools classify their arbitrary JSON args instead
   *  (D-47d) — an unclassified path-looking value is fenced until answered. */
  private fenceEscapes(tool: Tool, args: Record<string, unknown>): { arg: string; escapedPath: string }[] {
    if (!this.sandbox) return [];
    const candidates: { arg: string; value: string }[] = tool.classifyPaths
      ? tool.classifyPaths(args).paths.map((p) => ({ arg: p.field, value: p.value }))
      : (tool.pathArgs ?? []).flatMap((argName) => {
          // A declared path arg is a string or, since X-43, an array of them —
          // `file_url` takes several at once. Anything else is not a path and is
          // left to the tool's own validation.
          const value = args[argName];
          if (typeof value === "string") return [{ arg: argName, value }];
          if (Array.isArray(value)) {
            return value
              .filter((v): v is string => typeof v === "string")
              .map((v, i) => ({ arg: `${argName}[${i}]`, value: v }));
          }
          return [];
        });
    const escapes: { arg: string; escapedPath: string }[] = [];
    for (const { arg, value } of candidates) {
      const r = this.sandbox.resolve(value);
      if (!r.ok && r.kind === "escape") escapes.push({ arg, escapedPath: r.escapedPath });
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
    const res = await tool.execute(args, {
      sandbox: this.sandbox!,
      tasks: this.tasks,
      todos: this.todoAccess,
      acceptsImages: this.acceptsImages,
      conversationId: this.conversation.id,
      agents: this.agentAccess,
    });
    const note = edited ? "[note: the user edited the arguments before running]\n" : "";
    this.appendToolResult(call, note + res.content, res.isError ?? false, res.attachments, res.files);
    this.emit({
      type: "debug",
      record: {
        kind: "tool",
        ms: Date.now() - startedAt,
        name: tool.name,
        argsPreview: JSON.stringify(args).slice(0, 300),
        contentPreview: res.content.slice(0, 200),
        isError: res.isError ?? false,
        // The bytes never reach the journal — only that they exist and what
        // they are. A base64 blob in the debug record would make the one file
        // written for *reading* the least readable thing in the data dir.
        ...(res.attachments && res.attachments.length > 0
          ? { attachments: res.attachments.map((a) => `${a.name ?? "attachment"} (${a.mime})`) }
          : {}),
        ...(this.activeAssistantId ? { entryId: this.activeAssistantId } : {}),
      },
    });
  }
}
