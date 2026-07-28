/**
 * Thin browser client for the JLCode server: POST up (create session, send
 * message, approve/deny, answer, switch mode), SSE down (live session events).
 * The event stream is the same one the session emits (session/types.ts) and
 * persistence projects (D-37) — the UI is just another subscriber (§11).
 */

/** A conversation-tree node as the server ships it (server entryView). The
 *  browser walks these (tree.ts) to render the active branch + sibling arrows. */
export interface EntryView {
  id: string;
  parent: string | null;
  type: "user" | "assistant" | "tool" | "compaction";
  text?: string;
  reasoningText?: string;
  toolCalls?: { name: string; arguments: string }[];
  truncated?: boolean;
  finishReason?: string;
  name?: string; // tool
  content?: string; // tool
  isError?: boolean; // tool
  summary?: string; // compaction
}

/** The tree snapshot from GET /session/:id — entries + the viewed leaf. */
export interface LoadedTree {
  conversationId: string | null;
  activeLeaf: string | null;
  entries: EntryView[];
}

/** Token/cost usage carried on a journal llm record (mirrors llm/types Usage). */
export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  costUsd?: number;
}

/** One verbose per-turn record from the debug journal (D-15) — mirrors the
 *  server's DebugRecord. `entryId` links it to the assistant turn that made it. */
export type JournalRecord =
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
      entryId?: string;
    }
  | {
      kind: "tool";
      ms: number;
      name: string;
      argsPreview: string;
      contentPreview: string;
      isError: boolean;
      entryId?: string;
    };

export type Mode = "ask" | "plan" | "code";
export type ApprovalPolicy = "manual" | "auto-safe" | "full-auto" | "read-only";
/** Compaction trigger modes (D-27, P6c). */
export type TriggerMode = "auto" | "manual" | "suggest" | "cancelable" | "hard";

/** A pre-send compaction decision the loop is paused on (D-27, P6c): `cancelable`
 *  offers Compact/Skip, `hard` offers Compact only. */
export interface CompactionRequest {
  id: string;
  mode: TriggerMode;
  cancelable: boolean;
  prefixTokens: number;
  threshold: number;
  window: number;
}

/** A stalled persistence write the session is stopped on (D-46). Recoverable:
 *  free the disk, then Retry and the queued records land in order. */
export interface PersistenceFault {
  id: string;
  filePath: string;
  message: string;
  pending: number;
  retryFailed?: boolean;
}

/** Guesses this pause can settle, asked once and remembered (D-48). JLCode
 *  presumes an MCP tool writes and that a slashy arg is a path; those guesses
 *  are why it stopped, so it asks while the user is here anyway. */
export interface LearnRequest {
  askWrite?: boolean;
  fields?: { field: string; value: string; escapes?: boolean }[];
  /** Set when the pause exists *only* because the tool is presumed to write. */
  modeBlocked?: string;
}

export interface LearnAnswers {
  writes?: boolean;
  fields?: Record<string, boolean>;
}

/** A tool call paused for approval (D-16). Args are editable before running. */
export interface ApprovalRequest {
  id: string;
  tool: string;
  kind: "read" | "write" | "command" | "meta";
  args: Record<string, unknown>;
  reason: string;
  outOfFence?: { paths: string[]; fields: string[]; suggestedRoot: string };
  learn?: LearnRequest;
}

/** One MCP server as `GET /mcp` reports it (P7b). */
export interface McpToolStatus {
  name: string;
  mcpName: string;
  description?: string;
  kind: string;
  presumed: boolean;
  alwaysAllow: boolean;
}
export interface McpServerStatus {
  name: string;
  scope: "global" | "workspace";
  state: "connected" | "disabled" | "failed";
  tools: string[];
  toolInfo: McpToolStatus[];
  learned: { pathFields: string[]; notPathFields: string[]; writeTools: string[]; readTools: string[] };
  error?: string;
}
export interface McpStatus {
  enabled: boolean;
  servers: McpServerStatus[];
  problems: string[];
  files: { global: string; workspace: string } | null;
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
  triggerMode?: TriggerMode; // live compaction trigger mode (D-27, P6c)
  needsCompaction?: boolean; // budget crossed — drives the suggest banner (D-44)
  compactionRequest?: CompactionRequest; // pending pre-send compaction pause (D-27)
  persistenceFault?: PersistenceFault; // a write failed; session stopped on it (D-46)
}

/** A session event as it arrives over SSE (subset the UI acts on; see session/types.ts). */
export interface WireEvent {
  type: string;
  [k: string]: unknown;
}

/** A live session's roster entry on the multiplexed bus (D-43): identity + its
 *  current settled state, enough to draw a rail badge without loading the tree. */
export interface SessionDescriptor {
  id: string;
  model: string;
  state: SessionState;
}

/** A frame on the multiplexed `/events` stream (D-43). */
export type BusFrame =
  | { type: "roster"; sessions: SessionDescriptor[] }
  | { type: "session-added"; session: SessionDescriptor }
  | { type: "session-removed"; sessionId: string }
  | { type: "session-event"; sessionId: string; event: WireEvent };

/** Create a fresh live session; returns its id. */
export async function createSession(): Promise<string> {
  const res = await fetch("/session", { method: "POST" });
  if (!res.ok) throw new Error(`could not create session (${res.status})`);
  return (await res.json()).sessionId as string;
}

/** Close a session (D-43): the server hard-stops it and drops it from the bag,
 *  so it no longer appears in the roster. The conversation stays on disk. */
export async function closeSession(id: string): Promise<void> {
  await postJson(`/session/${id}/close`, {});
}

/** Subscribe to the instance's multiplexed event stream (D-43): all sessions'
 *  events tagged with sessionId, plus roster/added/removed lifecycle frames.
 *  Returns the EventSource so the caller can close it. */
export function openBus(onFrame: (f: BusFrame) => void): EventSource {
  const es = new EventSource("/events");
  es.onmessage = (ev) => {
    try {
      onFrame(JSON.parse(ev.data) as BusFrame);
    } catch {
      /* ignore malformed frame */
    }
  };
  return es;
}

/** Load a live session's tree (entries + active leaf + conversation id) so a
 *  reload/deep-link shows history and the branch arrows can be drawn (D-17). */
export async function loadTree(id: string): Promise<LoadedTree> {
  const res = await fetch(`/session/${id}`);
  if (!res.ok) return { conversationId: null, activeLeaf: null, entries: [] };
  const data = (await res.json()) as {
    conversationId?: string;
    activeLeaf?: string | null;
    entries?: EntryView[];
  };
  return {
    conversationId: data.conversationId ?? null,
    activeLeaf: data.activeLeaf ?? null,
    entries: data.entries ?? [],
  };
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
  decision: {
    approve: boolean;
    editedArgs?: Record<string, unknown>;
    addRoot?: boolean | string;
    reason?: string;
    /** Answers to the questions the pause carried (D-48) — kept even on a deny. */
    learned?: LearnAnswers;
  },
): Promise<void> {
  await postJson(`/session/${id}/approve`, decision);
}

/** MCP server status for the panel (P7b) — read-only; settings files are the
 *  source of truth and are edited by hand or via `jlcode mcp`. */
export async function fetchMcpStatus(): Promise<McpStatus> {
  const res = await fetch("/mcp");
  if (!res.ok) throw new Error(`request failed (${res.status})`);
  return (await res.json()) as McpStatus;
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

/** Switch the live compaction trigger mode (D-27, P6c); persisted as the config
 *  default like mode/approval. */
export async function setTriggerMode(id: string, mode: TriggerMode): Promise<void> {
  await postJson(`/session/${id}/trigger-mode`, { mode });
}

/** Compaction control (D-27, P6c): resolve a pending pre-send pause (`skip:true`
 *  skips a cancelable pause), or compact on demand (manual/suggest "Compact now"). */
export async function compact(id: string, opts: { skip?: boolean } = {}): Promise<void> {
  await postJson(`/session/${id}/compact`, opts);
}

/** Recover from a stalled persistence write (D-46): retry the queued records, or
 *  `discard: true` to give up on them and accept the loss. Returns the settled
 *  state — `recovered: false` means it failed again and the session stays paused. */
export async function resolvePersistence(
  id: string,
  opts: { discard?: boolean } = {},
): Promise<SessionState & { recovered?: boolean; discarded?: number }> {
  return (await postJson(`/session/${id}/persistence`, opts)) as SessionState & {
    recovered?: boolean;
    discarded?: number;
  };
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

/** Switch the active branch: point the active leaf at an existing entry (D-10). */
export async function rewind(id: string, entryId: string): Promise<void> {
  await postJson(`/session/${id}/rewind`, { entryId });
}

/** Pencil-edit a message: fork a sibling with new text and run a turn (D-17). */
export async function editFork(id: string, entryId: string, text: string): Promise<void> {
  await postJson(`/session/${id}/edit`, { entryId, text });
}

/** The verbose debug journal for a conversation — the "Halp!" record (D-15). */
export async function fetchJournal(conversationId: string): Promise<JournalRecord[]> {
  const res = await fetch(`/conversation/${conversationId}/journal`);
  if (!res.ok) return [];
  const data = (await res.json()) as { records?: JournalRecord[] };
  return data.records ?? [];
}
