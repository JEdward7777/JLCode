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

export type SessionStatus = "idle" | "running" | "awaiting-approval" | "awaiting-input" | "halted";

/** A tool call paused for approval (D-16 — args are editable before running). */
export interface ApprovalRequest {
  id: string;
  tool: string;
  kind: ToolKind;
  args: Record<string, unknown>;
  reason: string;
  /** Present when the call touches paths outside the fence (D-19). */
  outOfFence?: { paths: string[]; suggestedRoot: string };
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
  | { type: "stopped"; scope: "hard" | "soft" } // global stop: hard abort vs loop-only (D-34)
  | { type: "queue"; queue: QueuedMessage[] } // the queued-message list changed (D-34)
  | { type: "task-start"; task: TaskView } // a background command started (D-34)
  | { type: "task-update"; task: TaskView } // a task changed (e.g. kill requested)
  | { type: "task-end"; task: TaskView } // a task finished / was killed
  | { type: "truncation"; message: string }
  | { type: "error"; message: string }
  | { type: "halted"; reason: string };

export type SessionListener = (event: SessionEvent) => void;
