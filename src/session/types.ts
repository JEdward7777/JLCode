/** Events a session emits on its stream (the persisted/UI/bus source, §11). */
import type { ToolKind } from "../tools/types.js";
import type { Entry } from "../conversation/types.js";
import type { Usage } from "../llm/types.js";

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
    }
  | { kind: "tool"; ms: number; name: string; argsPreview: string; contentPreview: string; isError: boolean };

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

/** The model's ask_user pause (D-18). */
export interface AskUserRequest {
  id: string;
  question: string;
  options?: string[];
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
  | { type: "truncation"; message: string }
  | { type: "error"; message: string }
  | { type: "halted"; reason: string };

export type SessionListener = (event: SessionEvent) => void;
