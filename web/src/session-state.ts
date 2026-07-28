/**
 * Per-session UI state and its pure reducer (D-43). Multiple sessions arrive
 * multiplexed on one bus (api.openBus); each slice accumulates independently so
 * a background session's spend / status / streaming stay live even while another
 * is focused. `reduceEvent` folds one wire event; `applyState` folds a settled
 * snapshot (roster / added / action responses). Kept pure and framework-free so
 * it's trivially testable (web-tree-style Tier-0).
 */
import type {
  ApprovalPolicy,
  ApprovalRequest,
  AskUserRequest,
  CompactionRequest,
  PersistenceFault,
  EntryView,
  Mode,
  QueuedMessage,
  SessionDescriptor,
  SessionState,
  TaskView,
  TriggerMode,
  WireEvent,
} from "./api";

/** The in-flight assistant turn, streamed token-by-token before it becomes an
 *  entry (which only appears at turn end). Rendered as an overlay after the
 *  active-branch entries, then dropped when the real entry arrives. */
export interface LiveAssistant {
  text: string;
  reasoning: string;
  truncated?: boolean;
}

/** Everything the UI knows about one live session. */
export interface SessionSlice {
  id: string;
  model: string;
  /** The thread's label (X-09) — auto after the first exchange, or hand-edited.
   *  Null until it has one; the rail falls back to the model name. */
  title: string | null;
  status: string;
  mode: Mode;
  approval: ApprovalPolicy;
  spendUsd: number;
  capUsd: number | null;
  capReached: boolean;
  tasks: TaskView[];
  queue: QueuedMessage[];
  // Conversation tree (loaded lazily on first focus; grows via live events).
  entries: EntryView[];
  activeLeaf: string | null;
  conversationId: string | null;
  treeLoaded: boolean;
  // Live view state.
  live: LiveAssistant | null;
  working: boolean;
  pendingApproval: ApprovalRequest | null;
  pendingAsk: AskUserRequest | null;
  // Compaction (D-27, P6c): the live trigger mode, whether the budget is crossed
  // (drives the suggest banner + manual hint), and any pending pre-send pause.
  triggerMode: TriggerMode;
  needsCompaction: boolean;
  pendingCompaction: CompactionRequest | null;
  /** A stalled persistence write the session is stopped on (D-46). Blocks the
   *  composer: nothing may proceed until it is retried or explicitly discarded. */
  persistenceFault: PersistenceFault | null;
  notice: string | null;
  input: string;
}

/** A blank slice for a freshly-seen session id (before its descriptor lands). */
export function newSlice(id: string, model = ""): SessionSlice {
  return {
    id,
    model,
    title: null,
    status: "idle",
    mode: "code",
    approval: "manual",
    spendUsd: 0,
    capUsd: null,
    capReached: false,
    tasks: [],
    queue: [],
    entries: [],
    activeLeaf: null,
    conversationId: null,
    treeLoaded: false,
    live: null,
    working: false,
    pendingApproval: null,
    pendingAsk: null,
    triggerMode: "cancelable",
    needsCompaction: false,
    pendingCompaction: null,
    persistenceFault: null,
    notice: null,
    input: "",
  };
}

/** Build a slice from a roster/added descriptor (identity + settled state). */
export function sliceFromDescriptor(d: SessionDescriptor): SessionSlice {
  return applyState(newSlice(d.id, d.model), d.state);
}

/** Fold a settled-state snapshot (SSE `ready`/roster/added, or an action
 *  response) into a slice. */
export function applyState(s: SessionSlice, state: SessionState): SessionSlice {
  const next = { ...s };
  if (state.title !== undefined) next.title = state.title;
  if (state.mode) next.mode = state.mode;
  if (state.approval) next.approval = state.approval;
  if (state.status) next.status = state.status;
  next.working = state.status === "running";
  next.pendingApproval = state.approvalRequest ?? null;
  next.pendingAsk = state.question ?? null;
  if (typeof state.spendUsd === "number") next.spendUsd = state.spendUsd;
  if (state.spendCapUsd !== undefined) next.capUsd = state.spendCapUsd;
  if (typeof state.capReached === "boolean") next.capReached = state.capReached;
  if (state.tasks) next.tasks = state.tasks;
  if (state.queue) next.queue = state.queue;
  if (state.triggerMode) next.triggerMode = state.triggerMode;
  if (typeof state.needsCompaction === "boolean") next.needsCompaction = state.needsCompaction;
  next.pendingCompaction = state.compactionRequest ?? null;
  next.persistenceFault = state.persistenceFault ?? null;
  return next;
}

/** Fold one live wire event into a slice (the per-session bus reducer). */
export function reduceEvent(s: SessionSlice, e: WireEvent): SessionSlice {
  switch (e.type) {
    case "entry": {
      // Live tree growth (D-37): append new nodes, advance the active leaf along
      // the branch being built, retire the streaming overlay when the assistant
      // node materializes.
      const entry = e.entry as EntryView;
      const entries = s.entries.some((x) => x.id === entry.id) ? s.entries : [...s.entries, entry];
      const activeLeaf = entry.parent === s.activeLeaf ? entry.id : s.activeLeaf;
      return { ...s, entries, activeLeaf, live: entry.type === "assistant" ? null : s.live };
    }
    case "active-leaf":
      return { ...s, activeLeaf: e.leaf as string };
    case "mode":
      return { ...s, mode: e.mode as Mode, approval: e.approval as ApprovalPolicy };
    case "title":
      // Auto-titled after the first exchange, or renamed by hand (X-09).
      return { ...s, title: e.title as string };
    case "spend":
      return { ...s, spendUsd: e.totalUsd as number };
    case "cap":
      return { ...s, capUsd: (e.capUsd as number | null) ?? null, capReached: false };
    case "cap-reached":
      return {
        ...s,
        capReached: true,
        working: false,
        notice: `Spend cap reached ($${(e.spendUsd as number).toFixed(4)} / $${(e.capUsd as number).toFixed(2)}). Raise it to continue.`,
      };
    case "stopped":
      return {
        ...s,
        working: false,
        notice:
          e.scope === "hard"
            ? "Stopped — aborted the turn and killed all tasks."
            : "Stopping after the current work — no further turn.",
      };
    case "queue":
      return { ...s, queue: (e.queue as QueuedMessage[]) ?? [] };
    case "task-start":
    case "task-update": {
      const t = e.task as TaskView;
      const rest = s.tasks.filter((x) => x.id !== t.id);
      return { ...s, tasks: t.status === "running" ? [...rest, t] : rest };
    }
    case "task-end":
      return { ...s, tasks: s.tasks.filter((x) => x.id !== (e.task as TaskView).id) };
    case "assistant-start":
      // The held turn begins → any pre-send compaction pause is resolved (a Skip
      // emits no `compacted`, so clear it here too).
      return { ...s, working: true, live: { text: "", reasoning: "" }, pendingCompaction: null };
    case "reasoning":
      return { ...s, live: { ...(s.live ?? { text: "", reasoning: "" }), reasoning: (s.live?.reasoning ?? "") + (e.delta as string) } };
    case "text":
      return { ...s, live: { ...(s.live ?? { text: "", reasoning: "" }), text: (s.live?.text ?? "") + (e.delta as string) } };
    case "assistant-end":
      return { ...s, working: false, live: null };
    case "trigger-mode":
      return { ...s, triggerMode: e.mode as TriggerMode };
    case "needs-compaction":
      // Budget crossed (D-44) — light up the suggest banner / manual hint. The
      // pre-send pause (cancelable/hard) arrives as its own awaiting event.
      return { ...s, needsCompaction: true };
    case "awaiting-compaction":
      return { ...s, working: false, live: null, pendingCompaction: e.request as CompactionRequest };
    case "compacted":
      // A compaction landed — clear the crossed flag + any pending pause. The
      // fresh compaction entry arrives via the normal `entry` event.
      return { ...s, needsCompaction: false, pendingCompaction: null };
    case "awaiting-persistence":
      // A record could not be written (D-46) — stop everything and show the
      // blocking banner. The turn was aborted via the hard-stop path, so clear
      // any in-flight live view too.
      return { ...s, working: false, live: null, persistenceFault: e.fault as PersistenceFault };
    case "persistence-recovered":
      return { ...s, persistenceFault: null };
    case "awaiting-approval":
      return { ...s, working: false, live: null, pendingApproval: e.request as ApprovalRequest };
    case "awaiting-input":
      return { ...s, working: false, live: null, pendingAsk: e.question as AskUserRequest };
    case "truncation":
      return { ...s, notice: e.message as string };
    case "error":
      return { ...s, notice: e.message as string, working: false, live: null };
    case "halted":
      return { ...s, notice: `halted: ${e.reason as string}`, working: false, live: null };
    default:
      return s;
  }
}
