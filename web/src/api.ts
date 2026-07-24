/**
 * Thin browser client for the JLCode server: POST up (create session, send
 * message, approve/deny, answer, switch mode), SSE down (live session events).
 * The event stream is the same one the session emits (session/types.ts) and
 * persistence projects (D-37) — the UI is just another subscriber (§11).
 */

export interface UiMessage {
  role: "user" | "assistant";
  text: string;
  reasoning?: string;
  streaming?: boolean;
  truncated?: boolean;
}

export type Mode = "ask" | "plan" | "code";
export type ApprovalPolicy = "manual" | "auto-safe" | "full-auto" | "read-only";

/** A tool call paused for approval (D-16). Args are editable before running. */
export interface ApprovalRequest {
  id: string;
  tool: string;
  kind: "read" | "write" | "command" | "meta";
  args: Record<string, unknown>;
  reason: string;
  outOfFence?: { paths: string[]; suggestedRoot: string };
}

/** One field of an ask_user form (D-18). */
export interface AskQuestion {
  header?: string;
  question: string;
  options?: string[];
  multiSelect?: boolean;
  allowFreeText?: boolean;
}
export interface AskUserRequest {
  id: string;
  questions: AskQuestion[];
}

/** A background command (D-34) — listed, killable, watchdog-watched. */
export interface TaskView {
  id: string;
  command: string;
  startedAt: number;
  status: "running" | "exited" | "killed";
  exitCode?: number | null;
  killReason?: "user" | "stop" | "watchdog";
}

/** A message queued for the next turn boundary (D-34). */
export interface QueuedMessage {
  id: string;
  text: string;
}

/** The settled-state snapshot carried on the SSE `ready` frame and returned by
 *  the action POSTs (see server stateOf). */
export interface SessionState {
  status?: string;
  mode?: Mode;
  approval?: ApprovalPolicy; // the approval policy (D-08)
  approvalRequest?: ApprovalRequest; // the pending approval request, if any (D-16)
  question?: AskUserRequest; // the pending ask_user form, if any (D-18)
  spendUsd?: number; // whole-tree spend so far (D-33)
  spendCapUsd?: number | null; // the spend cap, if set (D-33)
  capReached?: boolean; // breach → the loop declined the next LLM call (D-33)
  tasks?: TaskView[]; // running background commands (D-34)
  queue?: QueuedMessage[]; // pending queued messages (D-34)
}

/** A session event as it arrives over SSE (subset the UI acts on; see session/types.ts). */
export interface WireEvent {
  type: string;
  [k: string]: unknown;
}

/** Reuse a `?session=<id>` deep-link if present, else create a fresh session. */
export async function createOrGetSession(): Promise<string> {
  const existing = new URL(window.location.href).searchParams.get("session");
  if (existing) return existing;
  const res = await fetch("/session", { method: "POST" });
  if (!res.ok) throw new Error(`could not create session (${res.status})`);
  return (await res.json()).sessionId as string;
}

/** Load a live session's settled transcript so a reload/deep-link shows history. */
export async function loadSession(id: string): Promise<UiMessage[]> {
  const res = await fetch(`/session/${id}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { entries?: Array<Record<string, any>> };
  const out: UiMessage[] = [];
  for (const e of data.entries ?? []) {
    if (e.type === "user") out.push({ role: "user", text: e.text ?? "" });
    else if (e.type === "assistant") {
      out.push({ role: "assistant", text: e.text ?? "", reasoning: e.reasoningText, truncated: e.truncated });
    }
    // tool/compaction entries aren't rendered in the bare chat view.
  }
  return out;
}

/** Subscribe to the session's live event stream. Returns the EventSource so the
 *  caller can close it. `onEvent` fires for every event (each carries `type`). */
export function openEvents(id: string, onEvent: (e: WireEvent) => void): EventSource {
  const es = new EventSource(`/session/${id}/events`);
  es.onmessage = (ev) => {
    try {
      onEvent(JSON.parse(ev.data) as WireEvent);
    } catch {
      /* ignore malformed frame */
    }
  };
  return es;
}

async function postJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `request failed (${res.status})`);
  }
  return res.json().catch(() => ({}));
}

/** Send a user message. Deltas arrive over SSE; this resolves at turn end. */
export async function sendChat(id: string, text: string): Promise<void> {
  await postJson("/chat", { sessionId: id, text });
}

/** Resolve a pending approval (D-16): approve/deny, optionally with edited args
 *  and an out-of-fence root decision (D-19). */
export async function approve(
  id: string,
  decision: { approve: boolean; editedArgs?: Record<string, unknown>; addRoot?: boolean | string; reason?: string },
): Promise<void> {
  await postJson(`/session/${id}/approve`, decision);
}

/** Answer a pending ask_user (D-18): a single string, or per-question answers. */
export async function answer(
  id: string,
  payload: string | Array<{ question: string; header?: string; answer: string }>,
): Promise<void> {
  await postJson(`/session/${id}/answer`, typeof payload === "string" ? { text: payload } : { answers: payload });
}

/** Switch capability mode and/or approval policy for the session (D-07/D-08). */
export async function setMode(id: string, patch: { mode?: Mode; approval?: ApprovalPolicy }): Promise<void> {
  await postJson(`/session/${id}/mode`, patch);
}

/** Set / raise / clear the whole-tree spend cap in USD (D-33); null clears it. */
export async function setCap(id: string, capUsd: number | null): Promise<void> {
  await postJson(`/session/${id}/cap`, { capUsd });
}

/** Global stop (D-34): "hard" aborts the LLM + kills tasks + clears the queue;
 *  "soft" lets running commands finish but takes no further LLM turn. */
export async function stopSession(id: string, scope: "hard" | "soft"): Promise<void> {
  await postJson(`/session/${id}/stop`, { scope });
}

/** Kill one background task (D-34). */
export async function killTask(id: string, taskId: string): Promise<void> {
  await postJson(`/session/${id}/task/${taskId}/kill`, {});
}

/** Queue a message for the next turn boundary (D-34). */
export async function queueMessage(id: string, text: string): Promise<void> {
  await postJson(`/session/${id}/queue`, { text });
}

/** Replace the whole pending queue — the edit/cancel affordance (D-34). */
export async function setQueue(id: string, queue: { text: string }[]): Promise<void> {
  await postJson(`/session/${id}/queue`, { queue });
}
