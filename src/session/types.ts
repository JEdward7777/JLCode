/** Events a session emits on its stream (the persisted/UI/bus source, §11). */
import type { ToolKind } from "../tools/types.js";
import type { TaskView } from "../tools/task-registry.js";
import type { Entry } from "../conversation/types.js";
import type { Usage } from "../llm/types.js";
import type { ApprovalPolicy, CompactionTrigger, Mode } from "../config/types.js";

/** A message typed mid-turn, waiting to apply at the next turn boundary (D-34). */
export interface QueuedMessage {
  id: string;
  text: string;
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
      /** The assistant entry that issued this tool call (per-turn linkage). */
      entryId?: string;
    };

export type SessionStatus =
  | "idle"
  | "running"
  | "awaiting-approval"
  | "awaiting-input"
  | "awaiting-compaction"
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
  outOfFence?: { paths: string[]; fields: string[]; suggestedRoot: string };
  /** Present when this pause can also settle a guess (D-48). */
  learn?: LearnRequest;
}

/** One question in an ask_user form (D-18). */
export interface AskUserQuestion {
  /** Short label/chip for the question (optional). */
  header?: string;
  question: string;
  /** Suggested answers, rendered as buttons. */
  options?: string[];
  /** Allow selecting several options at once. */
  multiSelect?: boolean;
  /** Allow a typed answer alongside / instead of the options. */
  allowFreeText?: boolean;
}

/** The model's ask_user pause (D-18) — a structured multi-question form. */
export interface AskUserRequest {
  id: string;
  questions: AskUserQuestion[];
}

/** A resolved answer to one question of an ask_user form. */
export interface AskUserAnswer {
  question: string;
  header?: string;
  answer: string;
}

export interface ApprovalDecision {
  approve: boolean;
  /** Edited arguments to run instead of the proposed ones (D-16). */
  editedArgs?: Record<string, unknown>;
  /** Reason, when denying. */
  reason?: string;
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
  | { type: "active-leaf"; leaf: string } // rewind / branch switch — persisted so resume restores it
  | { type: "debug"; record: DebugRecord } // verbose per-turn record for the debug journal (D-15)
  | { type: "user"; entryId: string; text: string }
  | { type: "assistant-start" }
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "assistant-end"; entryId: string; finishReason: string; truncated: boolean }
  | { type: "tool-start"; name: string }
  | { type: "tool-end"; name: string; isError: boolean }
  | { type: "awaiting-approval"; request: ApprovalRequest }
  | { type: "awaiting-input"; question: AskUserRequest }
  | { type: "mode"; mode: Mode; approval: ApprovalPolicy } // live mode/approval change (D-07/D-08)
  | { type: "title"; title: string; source: "auto" | "manual" } // the thread got a name (X-09)
  | { type: "spend"; totalUsd: number; turnUsd: number; usage?: Usage } // whole-tree spend (D-33)
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
  | { type: "task-start"; task: TaskView } // a background command started (D-34)
  | { type: "task-update"; task: TaskView } // a task changed (e.g. kill requested)
  | { type: "task-end"; task: TaskView } // a task finished / was killed
  | { type: "truncation"; message: string }
  | { type: "error"; message: string }
  | { type: "halted"; reason: string };

export type SessionListener = (event: SessionEvent) => void;
