/** Events a session emits on its stream (the persisted/UI/bus source, §11). */
export type SessionStatus = "idle" | "running" | "halted";

export type SessionEvent =
  | { type: "user"; entryId: string; text: string }
  | { type: "assistant-start" }
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "assistant-end"; entryId: string; finishReason: string; truncated: boolean }
  | { type: "tool-start"; name: string }
  | { type: "tool-end"; name: string; isError: boolean }
  | { type: "truncation"; message: string }
  | { type: "error"; message: string }
  | { type: "halted"; reason: string };

export type SessionListener = (event: SessionEvent) => void;
