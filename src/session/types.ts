/** Events a session emits on its stream (the persisted/UI/bus source, §11). */
import type { ToolKind } from "../tools/types.js";

export type SessionStatus = "idle" | "running" | "awaiting-approval" | "awaiting-input" | "halted";

/** A tool call paused for approval (D-16 — args are editable before running). */
export interface ApprovalRequest {
  id: string;
  tool: string;
  kind: ToolKind;
  args: Record<string, unknown>;
  reason: string;
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
}

export type SessionEvent =
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
