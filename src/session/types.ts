/** Events a session emits on its stream (the persisted/UI/bus source, §11). */
import type { ToolKind, ToolPreview } from "../tools/types.js";
import type { TaskView } from "../tools/task-registry.js";
import type { Entry, InboundMeta } from "../conversation/types.js";
import type { RestState } from "../conversation/tree.js";
import type { TodoItem } from "../conversation/todos.js";
import type { ProviderRouting, Usage } from "../llm/types.js";
import type { ApprovalPolicy, CompactionTrigger, Mode } from "../config/types.js";

/** A message typed mid-turn, waiting to apply at the next turn boundary (D-34). */
export interface QueuedMessage {
  id: string;
  text: string;
  /** Sent by another agent, not typed by the human (D-88). Only a human
   *  message resets the tool-round budget (D-89), and only an agent's turn waits
   *  for a slot under the tree's concurrency cap. */
  inbound?: InboundMeta;
  /** Written by JLCode itself — the parked todo nudge (X-31). Neither human
   *  input nor agent traffic: it never opens a turn and never resets a budget. */
  machine?: boolean;
}

/** An agent message as it travels (D-88): the attribution plus the text the
 *  receiver will read, header line included. */
export type InboundMessage = InboundMeta & { text: string };

/** How a sub-tree stands, for the parent's "waiting for you" flag (X-56 Q10/Q11)
 *  and the counts the rail will nest (P9e). Descendants only — not the agent itself. */
export interface SubtreeSummary {
  agents: number;
  running: number;
  queued: number;
  /** Descendants paused on the human — an approval, a question, the round
   *  budget. Approvals never route through agents, so this is what lights the
   *  parent. */
  waiting: number;
  /** What the descendants have spent (D-33): the parent's own plus this is the
   *  subtree's total. */
  spendUsd: number;
  /** This session's own **closed** children (P9f, X-56 Q18–Q20): not loaded,
   *  so not in the bag, but still in the rail — grey, below the open ones, and
   *  a click reopens them. Spawn order. */
  closed: ClosedAgent[];
}

/** A closed sub-agent, as its parent's rail row lists it (P9f). */
export interface ClosedAgent {
  agentId: string;
  name: string;
  /** Its conversation id (`<root>~<agent>`): what a reopen names. */
  conversationId: string;
  /** Agents recorded below it — folded away with it (Q18). */
  below: number;
}

/** Where a sub-agent sits in its tree (D-88). Absent on a session that has never
 *  been part of one — every thread before P9c, and a root until it spawns. */
export interface AgentInfo {
  /** `root` for the human-started thread; `agent-N` below it. */
  name: string;
  /** Levels below the root; the root is 0. */
  depth: number;
  /** The parent session, or null for the root. */
  parentSessionId: string | null;
  rootSessionId: string;
}

/** A verbose per-turn record for the debug journal (D-15) — never replayed. */
export type DebugRecord =
  | {
      kind: "llm";
      ms: number;
      model: string;
      messages: number;
      tools: string[];
      /** Backend OpenRouter routed to, and the pin we asked for (D-49/H-02).
       *  Recorded so an unexpected provider switch is visible in the journal
       *  instead of only surfacing as a signature rejection two turns later. */
      provider?: string;
      pinnedTo?: string;
      /** The config's own routing block, when one replaced the pin (D-86) —
       *  recorded whole, since an endpoint slug (`openai/flex`) is not the
       *  provider name OpenRouter reports back and must not read as a switch. */
      routing?: ProviderRouting;
      finishReason?: string;
      truncated?: boolean;
      usage?: Usage;
      textPreview?: string;
      reasoningPreview?: string;
      error?: string;
      /** The assistant entry this call produced — links the record to a turn for
       *  the per-turn journal viewer (D-15). Absent when the call errored. */
      entryId?: string;
    }
  | {
      kind: "tool";
      ms: number;
      name: string;
      argsPreview: string;
      contentPreview: string;
      isError: boolean;
      /** Non-text output, named but never carried (P8b): `shot.png (image/png)`.
       *  The journal is the one file written to be *read*, so a base64 blob has
       *  no business in it — the bytes live on the entry. */
      attachments?: string[];
      /** The assistant entry that issued this tool call (per-turn linkage). */
      entryId?: string;
    }
  | {
      /** Something the loop did that is neither a call nor a tool — a pause, a
       *  budget, a decision taken on the agent's behalf (D-79). The journal is
       *  where "why did it stop?" gets answered, so a stop that leaves no record
       *  is a stop nobody can diagnose. */
      kind: "note";
      message: string;
      /** The assistant entry the note follows (per-turn linkage). */
      entryId?: string;
    };

export type SessionStatus =
  | "idle"
  // An agent's turn is ready but its tree is at its concurrency cap (D-89); it
  // starts, FIFO, when a running agent in the tree goes idle. Never refused.
  | "queued"
  | "running"
  | "awaiting-approval"
  | "awaiting-input"
  | "awaiting-compaction"
  | "awaiting-continue"
  | "awaiting-persistence"
  | "halted";

/** A stalled persistence write the session is paused on (D-46). Unlike the other
 *  pauses this one is raised **from outside the turn loop** — the store writes
 *  asynchronously off `entry` events — so it unwinds the loop via the hard-stop
 *  path and settles here instead of idle. Recoverable: fix the disk, then Retry. */
export interface PersistenceFault {
  id: string;
  /** The file whose write failed. */
  filePath: string;
  /** The underlying error message (ENOSPC, EIO, EMFILE, …). */
  message: string;
  /** Records queued and unwritten, including the one that failed. */
  pending: number;
  /** Set when a retry was attempted and failed again. */
  retryFailed?: boolean;
}

/** A pre-send compaction decision the loop is paused on (P6c, D-27). Raised in
 *  the `cancelable` and `hard` trigger modes when ground-truth usage says the
 *  next request would exceed the budget: the loop holds the just-sent turn until
 *  the user decides. `cancelable` → Compact **or** Skip; `hard` → Compact only. */
export interface CompactionRequest {
  id: string;
  /** The active trigger mode that raised this (`cancelable` | `hard`). */
  mode: CompactionTrigger;
  /** True when Skip is offered (`cancelable`); false when compaction is required
   *  to proceed (`hard`). */
  cancelable: boolean;
  prefixTokens: number;
  threshold: number;
  window: number;
}

/** The loop paused because it has taken its whole budget of model turns without
 *  handing the turn back (D-79). Not a failure and not a cost breach — just the
 *  point at which "still working" becomes a claim worth checking. Every tool
 *  call issued so far has already run: the pause sits *before* the next model
 *  call, never between a call and its result. Resolved via Session.continueRun,
 *  which resumes the same turn on a doubled budget. */
export interface StallRequest {
  id: string;
  /** Model turns taken since the user's message. */
  rounds: number;
  /** The budget that was just spent. */
  budget: number;
  /** What Continue would raise it to. */
  nextBudget: number;
}

/**
 * Questions riding along on a pause (D-48). JLCode guesses conservatively about
 * an MCP tool — it writes; a slashy arg is a path — and those guesses are what
 * make it stop. So when it has stopped *anyway*, it asks the user to settle
 * them, once, and persists the answers into `mcp_settings.json`. It never
 * creates a pause just to ask: if the policy would have let the call run
 * unattended, the answer wouldn't have changed the outcome.
 */
export interface LearnRequest {
  /** Ask *does this tool write?* — the class is presumed, not known. */
  askWrite?: boolean;
  /** Ask *is this a path?* per unclassified slashy arg (jq-style field names). */
  fields?: { field: string; value: string; escapes?: boolean }[];
  /** The pause exists *only* because a presumed-writing tool is mode-blocked
   *  (Ask/Plan). Answering "read-only" un-blocks the call; "writes" denies it. */
  modeBlocked?: string;
}

/** The user's answers to a `LearnRequest`, applied before the call proceeds. */
export interface LearnAnswers {
  writes?: boolean;
  /** Flattened field name → is it a filesystem path? */
  fields?: Record<string, boolean>;
}

/** A tool call paused for approval (D-16 — args are editable before running). */
export interface ApprovalRequest {
  id: string;
  tool: string;
  kind: ToolKind;
  args: Record<string, unknown>;
  reason: string;
  /** Present when the call touches paths outside the fence (D-19). `fields` runs
   *  parallel to `paths`: the arg each escape came from (D-48). */
  outOfFence?: {
    paths: string[];
    fields: string[];
    suggestedRoot: string;
    /** **Allow-once is not offered** (H-08). True for a bridged MCP tool: JLCode
     *  resolves a native tool's paths itself, so "once" is a promise it can keep,
     *  but an MCP server may *remember* what it is handed — `file_utils` keeps a
     *  `project_root` — and every later call can then reach the same place through
     *  a relative name the fence never sees as a path. So the only honest answers
     *  are widen-the-fence (visible, chosen) or deny. */
    requiresRoot?: boolean;
  };
  /** Present when this pause can also settle a guess (D-48). */
  learn?: LearnRequest;
  /** Richer-than-JSON rendering of the pending call — a unified diff for
   *  `apply_edits` (D-53). Advisory: the raw `args` stay the editable truth. */
  preview?: ToolPreview;
}

/** One question in an ask_user form (D-18). */
export interface AskUserQuestion {
  /** Short label/chip for the question (optional). */
  header?: string;
  question: string;
  /** Suggested answers, rendered as buttons. They are *suggestions*: a typed
   *  answer is always available beside them and is never the model's to
   *  withhold (D-72). There is deliberately no `allowFreeText` flag any more. */
  options?: string[];
  /** Allow selecting several options at once. */
  multiSelect?: boolean;
  /** The form cannot be submitted leaving this one blank (D-72). It compels
   *  *an* answer — never the picking of an offered option, since typing stays
   *  open — and it is the only thing that takes the decline away. */
  required?: boolean;
}

/** The model's question pause (D-18) — a structured multi-question form. */
export interface AskUserRequest {
  id: string;
  questions: AskUserQuestion[];
  /** Who the model asked (P9d, X-56 Q16): `parent` when a sub-agent asked the
   *  agent that started it — whose reply then answers it. Absent = the person.
   *  The person may answer either kind: they outrank every agent. */
  to?: "parent";
}

/** A resolved answer to one question of an ask_user form. `answer` is the flat
 *  rendering (and the whole of what a plain-text frontend needs to send); the
 *  rest is provenance, so the tool result can tell a chosen option from a typed
 *  answer from a decline instead of flattening all three into one string (D-72). */
export interface AskUserAnswer {
  question: string;
  header?: string;
  answer: string;
  /** Offered options the user actually picked. */
  chosen?: string[];
  /** Text the user typed — beside the options, or instead of them. */
  typed?: string;
  /** The user answered nothing here. Not the same as any option, and not the
   *  same as an empty string: it is reported to the model as a decline. */
  declined?: boolean;
}

export interface ApprovalDecision {
  approve: boolean;
  /** Edited arguments to run instead of the proposed ones (D-16). */
  editedArgs?: Record<string, unknown>;
  /** Reason, when denying. */
  reason?: string;
  /** A remark the user typed in the composer while the pause was up (D-51).
   *  Appended to the transcript as a plain user message once the tool batch
   *  settles — the same thing they'd have said in the next turn, said now. */
  note?: string;
  /** For out-of-fence access (D-19): true → remember the containing root(s);
   *  a string → remember that specific root; omitted → allow just this once. */
  addRoot?: boolean | string;
  /** Answers to the questions the pause carried (D-48). Applied — and persisted
   *  — before the fence is re-evaluated, so a field the user says is *not* a
   *  path never widens the fence on its account. Kept on a denial too: the
   *  answers are facts about the tool, not consent to this call. */
  learned?: LearnAnswers;
}

export type SessionEvent =
  | { type: "entry"; entry: Entry } // full tree node, for the persistence projection (D-37)
  // The session's status changed (P9c) — what the agent coordinator counts
  // running agents by, and what the rail will draw a sub-agent's dot from (P9e).
  | { type: "status"; status: SessionStatus }
  // An agent message was **sent** to this session (D-88): persisted before it
  // reaches the transcript, so a message owed a reply survives a crash.
  | { type: "inbox"; message: InboundMessage }
  // Inbox messages that will never be delivered (a hard Stop, a cancelled queue).
  | { type: "inbox-dropped"; ids: string[] }
  // "Continue, don't ask again in this thread" (P9d, D-89): the tool-round
  // pause is off for this thread and its subtree — persisted, so it holds
  // across a restart.
  | { type: "rounds-off" }
  // The session came to rest with nothing more to do on its own — no suspended
  // turn, nothing queued behind it (D-88). A sub-agent's parent gets its
  // completion notice from this.
  | { type: "settled"; outcome: "finished" | "failed" | "stopped" }
  // How the session stands at rest, read from its log (P9f, X-56 Q14):
  // interrupted / owes-reply / quiescent, or null while it is not at rest.
  // Sent when it changes — what the rail's dot and its Wake button go by.
  | { type: "rest"; rest: RestState | null }
  // This session's sub-agents changed state (X-56 Q10): the counts behind the
  // parent's "waiting for you" flag.
  | { type: "subtree"; summary: SubtreeSummary }
  // This session took its place in an agent tree (P9e): sent when the
  // coordinator links it, which for a sub-agent is just after its
  // `session-added` frame — the rail nests it by this.
  | { type: "agent"; info: AgentInfo }
  // Rewind / branch switch — persisted so resume restores it. `null` is the
  // point above the root, where editing the first message forks (H-05).
  | { type: "active-leaf"; leaf: string | null }
  | { type: "debug"; record: DebugRecord } // verbose per-turn record for the debug journal (D-15)
  | { type: "user"; entryId: string; text: string }
  // `parent` is the branch tip this turn is pinned to (H-05), so a viewer can
  // tell whether the streaming text belongs to the branch it is looking at.
  | { type: "assistant-start"; parent: string | null }
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "assistant-end"; entryId: string; finishReason: string; truncated: boolean }
  | { type: "tool-start"; name: string }
  | { type: "tool-end"; name: string; isError: boolean }
  | { type: "awaiting-approval"; request: ApprovalRequest }
  | { type: "awaiting-input"; question: AskUserRequest }
  | { type: "mode"; mode: Mode; approval: ApprovalPolicy } // live mode/approval change (D-07/D-08)
  // This thread is now running under a different model configuration (X-40,
  // D-82a). Raised at the top of a user turn, never mid-cycle — see
  // `Session.adoptConfig`. `from` is what it was, because "you are on Sonnet
  // now" is only half the sentence a person needs when they did not expect it.
  // `configId` is what the browser's model picker marks as current (X-56, P9b).
  | { type: "config"; configId: string; configName: string; model: string; from: { name: string; model: string } }
  // A model switch picked while the session was busy (X-56, D-87): held in
  // memory and written at the next idle point; a second pick replaces it.
  // `null` clears it — written, or superseded by nothing.
  | { type: "model-switch-pending"; pending: PendingModelSwitch | null }
  | { type: "title"; title: string; source: "auto" | "manual" } // the thread got a name (X-09)
  | { type: "spend"; totalUsd: number; turnUsd: number; usage?: Usage } // whole-tree spend (D-33)
  // How full the context is, for the meter (X-24). Emitted per LLM round trip of
  // the conversation loop — deliberately *not* off `spend`, which also fires for
  // the summary/title/watchdog calls whose prompt size is not this branch's
  // prefix. `tokens: 0` means not measured yet (fresh branch, or just compacted).
  | { type: "context"; tokens: number; threshold?: number; window?: number }
  | { type: "cap"; capUsd: number | null } // the spend cap was set/raised/cleared (D-33)
  | { type: "cap-reached"; spendUsd: number; capUsd: number } // breach → no further LLM call (D-33)
  // Ground-truth usage says the next request would exceed the budget (D-44). The
  // mode is what *would* happen (auto/manual/suggest/cancelable/hard, D-27);
  // compaction itself is stubbed until P6b, so P6a only announces. `forced` marks
  // an over-window hard-wall hit (D-44b) rather than a pre-emptive budget crossing.
  | {
      type: "needs-compaction";
      mode: CompactionTrigger;
      prefixTokens: number;
      threshold: number;
      window: number;
      forced?: boolean;
    }
  // A safe-harbor compaction just landed (P6b, D-28/D-38): everything on the
  // active branch was folded into the `compaction` overlay entry `entryId`, so
  // the next request replays only `system + summary`. `forced` marks the D-44b
  // over-window recovery path (truncated summary input) vs a budget-triggered one.
  | { type: "compacted"; entryId: string; forced: boolean; summaryChars: number }
  // The loop paused before the next send for a compaction decision (P6c, D-27):
  // `cancelable` mode offers Compact/Skip, `hard` offers Compact only. Resolved
  // via Session.resolveCompaction (server /session/:id/compact).
  | { type: "awaiting-compaction"; request: CompactionRequest }
  // The loop has taken `budget` model turns on one user message without handing
  // the turn back (D-79). It holds here — pending tool calls all executed — and
  // Session.continueRun resumes on a doubled budget.
  | { type: "awaiting-continue"; request: StallRequest }
  // The live compaction trigger mode changed (P6c, D-27) — the header selector,
  // persisted as the config default (like mode/approval).
  | { type: "trigger-mode"; mode: CompactionTrigger }
  // A persistence write failed and the session stopped on it (D-46). Everything
  // halts until the user retries (disk fixed → the stalled record lands) or
  // explicitly discards. Never auto-resolved: proceeding unpersisted is exactly
  // the silent divergence this pause exists to prevent.
  | { type: "awaiting-persistence"; fault: PersistenceFault }
  // The stalled writes drained after a retry — back to idle (D-46).
  | { type: "persistence-recovered"; discarded: number }
  | { type: "stopped"; scope: "hard" | "soft" } // global stop: hard abort vs loop-only (D-34)
  | { type: "queue"; queue: QueuedMessage[] } // the queued-message list changed (D-34)
  // The shared todo list changed (X-31) — by either writer. Carries the folded
  // list, since that is what the panel draws; the ops themselves ride in the
  // `entry` event that persists them.
  | { type: "todos"; items: TodoItem[] }
  | { type: "task-start"; task: TaskView } // a background command started (D-34)
  | { type: "task-update"; task: TaskView } // a task changed (e.g. kill requested)
  | { type: "task-end"; task: TaskView } // a task finished / was killed
  | { type: "truncation"; message: string }
  // A transient provider failure is being re-sent automatically (D-57), so the
  // wait has a story attached instead of looking like a stall.
  /** `of` is the attempt cap, or `null` when there is none — a rate limit retries until it clears (D-95). */
  | { type: "retrying"; attempt: number; of: number | null; delayMs: number; message: string }
  // `retryable` marks a failure the Retry button can act on: nothing was
  // appended, so the same prefix can simply be sent again (D-57). Absent on the
  // errors where asking again cannot help — an over-window wall, a failed
  // compaction — so the UI never offers a button that would just fail twice.
  | { type: "error"; message: string; retryable?: boolean }
  | { type: "halted"; reason: string; retryable?: boolean };

export type SessionListener = (event: SessionEvent) => void;

/** A model switch waiting for the session to go idle (X-56, D-87). */
export interface PendingModelSwitch {
  configId: string;
  name: string;
  model: string;
}

/**
 * This branch is governed by a model switch whose config no longer exists
 * (X-56 Q2, D-87). The thread **refuses to send** rather than substitute
 * anything — the snapshot is what the picker shows as "the model that is gone".
 * A typed error, with a stable `code`, so the browser can turn it into the
 * inline picker instead of a toast (P9b).
 */
export class ModelConfigMissingError extends Error {
  readonly code = "model-config-missing";
  constructor(
    readonly configId: string,
    readonly snapshot: { name: string; model: string },
  ) {
    super(
      `This thread's model config "${snapshot.name}" (${snapshot.model}) no longer exists — pick another model for the thread.`,
    );
    this.name = "ModelConfigMissingError";
  }
}
