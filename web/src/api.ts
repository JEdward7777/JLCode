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
  type: "user" | "assistant" | "tool" | "compaction" | "todo";
  text?: string;
  reasoningText?: string;
  toolCalls?: { id?: string; name: string; arguments: string }[];
  truncated?: boolean;
  finishReason?: string;
  name?: string; // tool
  toolCallId?: string; // tool → the assistant toolCalls entry it answers (X-11)
  content?: string; // tool
  isError?: boolean; // tool
  summary?: string; // compaction
  by?: "agent" | "user"; // todo — who changed the list at this point (X-31)
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
      /** Named, not carried (P8b) — `shot.png (image/png)`. */
      attachments?: string[];
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
  outOfFence?: { paths: string[]; fields: string[]; suggestedRoot: string; requiresRoot?: boolean };
  learn?: LearnRequest;
  /** Richer rendering of the pending call — a unified diff for `apply_edits`
   *  and for overwriting a file, the file itself for a create/delete (D-53,
   *  X-23). Read-only: the raw args below it stay the editable truth. */
  preview?: ToolPreview;
}

/** A change to existing files, as a unified diff (D-53). */
export interface ToolPreviewDiff {
  kind: "diff";
  files: {
    path: string;
    patch: string;
    added: number;
    removed: number;
    /** `apply_edits` only — a whole-file write has no anchor sites. */
    sites?: number;
    error?: string;
  }[];
}

/** One whole file, shown as itself — nothing to diff against (X-23). */
export interface ToolPreviewFile {
  kind: "file";
  action: "create" | "overwrite" | "delete";
  path: string;
  body: string;
  /** Size of the whole file/content, not of the capped `body`. */
  lines: number;
  bytes: number;
  omitted?: number;
  note?: string;
  error?: string;
}

/** A tool's own rendering of a pending call (D-53, X-23). */
export type ToolPreview = ToolPreviewDiff | ToolPreviewFile;

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

/** One field of an ask_user form (D-18). `options` are suggestions only: a
 *  typed answer sits beside them on every question and cannot be withheld, and
 *  a question may be declined unless `required` (D-72). */
export interface AskQuestion {
  header?: string;
  question: string;
  options?: string[];
  multiSelect?: boolean;
  required?: boolean;
}
export interface AskUserRequest {
  id: string;
  questions: AskQuestion[];
}

/** One answer posted back (D-72). `answer` is the flat rendering; `chosen` /
 *  `typed` / `declined` keep the shape so the tool result can tell a picked
 *  option from a typed reply from "none of these". */
export interface AskAnswer {
  question: string;
  header?: string;
  answer: string;
  chosen?: string[];
  typed?: string;
  declined?: boolean;
}

/** A background command (D-34) — listed, killable, watchdog-watched. */
export interface TaskView {
  id: string;
  command: string;
  startedAt: number;
  status: "running" | "exited" | "killed";
  exitCode?: number | null;
  killReason?: "user" | "stop" | "watchdog" | "timeout";
}

/** A message queued for the next turn boundary (D-34). */
export interface QueuedMessage {
  id: string;
  text: string;
}

/** One row of the shared todo list (X-31). The `id` is stable across rewording,
 *  which is what lets the agent strike an item the user has since edited. */
export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  /** A short outcome hung under the item — "done — commit 6173b82" (D-77). */
  note?: string;
}

/** The settled-state snapshot carried on the SSE `ready` frame and returned by
 *  the action POSTs (see server stateOf). */
export interface SessionState {
  status?: string;
  /** Which conversation this session holds. Present on every settled state, so
   *  the rail knows a session's conversation before its tree is loaded — which
   *  is what keeps LIVE and HISTORY disjoint (X-12). */
  conversationId?: string;
  title?: string | null; // the thread's label (X-09), null until it has one
  mode?: Mode;
  approval?: ApprovalPolicy; // the approval policy (D-08)
  approvalRequest?: ApprovalRequest; // the pending approval request, if any (D-16)
  question?: AskUserRequest; // the pending ask_user form, if any (D-18)
  spendUsd?: number; // whole-tree spend so far (D-33)
  spendCapUsd?: number | null; // the spend cap, if set (D-33)
  capReached?: boolean; // breach → the loop declined the next LLM call (D-33)
  tasks?: TaskView[]; // running background commands (D-34)
  queue?: QueuedMessage[]; // pending queued messages (D-34)
  todos?: TodoItem[]; // the shared todo list, folded from this branch's ops (X-31)
  triggerMode?: TriggerMode; // live compaction trigger mode (D-27, P6c)
  needsCompaction?: boolean; // budget crossed — drives the suggest banner (D-44)
  compactionRequest?: CompactionRequest; // pending pre-send compaction pause (D-27)
  /** The window compaction measures against and where the number came from
   *  (D-44c/H-06) — `"fallback"` means we are guessing and must say so. */
  contextWindow?: number | null;
  contextThreshold?: number | null; // where compaction fires: window − buffer (D-44)
  contextTokens?: number; // how full it is now; 0 = not measured yet (X-24)
  contextWindowSource?: "config" | "catalog" | "fallback" | null;
  persistenceFault?: PersistenceFault; // a write failed; session stopped on it (D-46)
  retryable?: boolean; // the last turn failed and can be re-sent as-is (D-57)
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

/** A row in the persisted history (X-12). Rows come from `index.jsonl`, so this
 *  is everything known about a thread without opening it: no entry count, no
 *  spend. `title` is absent on threads whose first exchange predates X-09. */
export interface ConversationRow {
  id: string;
  workingDir: string;
  createdAt: string;
  title?: string;
}

/** A conversation read from disk (X-12) — the peek's source. Distinct from
 *  `loadTree`, which reads a *live* session; nothing here implies a session. */
export interface LoadedConversation {
  id: string;
  activeLeaf: string | null;
  entries: EntryView[];
}

/** History for a directory (D-09). Defaults to the server's workspace; `"all"`
 *  crosses projects. Newest first, by `createdAt`. */
export async function listConversations(dir?: "all"): Promise<ConversationRow[]> {
  const res = await fetch(dir === "all" ? "/conversations?dir=all" : "/conversations");
  if (!res.ok) return [];
  return ((await res.json()) as { conversations?: ConversationRow[] }).conversations ?? [];
}

/** Load a persisted conversation for a read-only peek (X-12). Creates nothing —
 *  no session, no rail card; the session is materialized by the first message. */
export async function loadConversation(id: string): Promise<LoadedConversation> {
  const res = await fetch(`/conversation/${id}`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `could not load conversation (${res.status})`);
  }
  const data = (await res.json()) as { id: string; activeLeaf?: string | null; entries?: EntryView[] };
  return { id: data.id, activeLeaf: data.activeLeaf ?? null, entries: data.entries ?? [] };
}

/** Rename a thread from its history row (X-12b). Addressed by *conversation*, so
 *  a thread nobody has open can still be named; the server routes through a live
 *  session when one holds it, so the rail card can't go stale. */
export async function renameConversation(id: string, title: string): Promise<void> {
  await postJson(`/conversation/${id}/title`, { title });
}

/** Remove a thread from the history list (X-12b). The server masks it with a
 *  reversible flag in the index rather than unlinking anything, so the files
 *  stay on disk and recovery by id keeps working. */
export async function deleteConversation(id: string): Promise<void> {
  const res = await fetch(`/conversation/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `could not delete conversation (${res.status})`);
  }
}

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

/** Send a user message. Deltas arrive over SSE; this resolves at turn end.
 *
 *  `conversationId` is the revival fallback (X-12): when the session id misses —
 *  a peek being promoted, or a stale tab whose session died with a previous
 *  process — the server attaches to a live session on that conversation or
 *  resumes it from disk. `leaf` continues a chosen branch instead of the
 *  persisted one. Returns the session actually used, which is *not* necessarily
 *  the id passed in. */
export async function sendChat(
  id: string | null,
  text: string,
  opts: { conversationId?: string; leaf?: string | null } = {},
): Promise<{ sessionId: string }> {
  const body = await postJson("/chat", {
    ...(id ? { sessionId: id } : {}),
    ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
    ...(opts.leaf ? { leaf: opts.leaf } : {}),
    text,
  });
  return { sessionId: body.sessionId as string };
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
    /** Composer text typed while the card was up (D-51) — appended to the
     *  transcript as a user message once the tool batch settles. */
    note?: string;
    /** Answers to the questions the pause carried (D-48) — kept even on a deny. */
    learned?: LearnAnswers;
  },
): Promise<void> {
  await postJson(`/session/${id}/approve`, decision);
}

/** Per-instance identity from GET /config: which config is selected and, since
 *  X-10, which workspace this server was launched in. */
export interface InstanceConfig {
  name: string;
  model: string;
  workingDir?: string;
  homeDir?: string;
}

/** The instance's config + workspace. Fetched once on load; `serve` is pinned to
 *  the directory it was launched in, so this doesn't change under us. */
export async function fetchConfig(): Promise<InstanceConfig | null> {
  const res = await fetch("/config");
  if (!res.ok) return null; // e.g. no config selected for this dir — the app still runs
  return (await res.json()) as InstanceConfig;
}

/** MCP server status for the panel (P7b) — read-only; settings files are the
 *  source of truth and are edited by hand or via `jlcode mcp`. */
export async function fetchMcpStatus(): Promise<McpStatus> {
  const res = await fetch("/mcp");
  if (!res.ok) throw new Error(`request failed (${res.status})`);
  return (await res.json()) as McpStatus;
}

/** Rename the thread (X-09). The auto-title runs once after the first exchange;
 *  this is the hand-edit, and it pins — auto never overwrites it. */
export async function setTitle(id: string, title: string): Promise<void> {
  await postJson(`/session/${id}/title`, { title });
}

/** Answer a pending ask_user (D-18): a single string, or per-question answers. */
export async function answer(id: string, payload: string | AskAnswer[]): Promise<void> {
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

/** The session's settled state, pauses included — what to believe when a POST
 *  failed and the local copy can no longer be trusted (X-21/D-57). Distinct from
 *  `loadTree`'s `GET /session/:id`, which answers with the tree and no pause. */
export async function fetchSessionState(id: string): Promise<SessionState> {
  const res = await fetch(`/session/${id}/state`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `request failed (${res.status})`);
  }
  return (await res.json()) as SessionState;
}

/** Re-attempt the current turn (D-57) — after a failure, after the breaker
 *  tripped, or against a request that has gone quiet. Appends nothing to the
 *  conversation: the same prefix is simply sent again. */
export async function retryTurn(id: string): Promise<SessionState> {
  return (await postJson(`/session/${id}/retry`, {})) as SessionState;
}

/** Kill one background task (D-34). */
export async function killTask(id: string, taskId: string): Promise<void> {
  await postJson(`/session/${id}/task/${taskId}/kill`, {});
}

/** Queue a message for the next turn boundary (D-34). */
export async function queueMessage(id: string, text: string): Promise<void> {
  await postJson(`/session/${id}/queue`, { text });
}

/** Commit the todo list as the user left it (X-31). Sent when they leave edit
 *  mode, not per keystroke: the whole list is the unit, and the server turns an
 *  actual change into the queued nudge that tells the agent to re-read. */
export async function setTodos(
  id: string,
  // An omitted `note` keeps whatever note the item already carries, server-side.
  items: { id?: string; text: string; done: boolean; note?: string }[],
): Promise<void> {
  const res = await fetch(`/session/${id}/todos`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `request failed (${res.status})`);
  }
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
