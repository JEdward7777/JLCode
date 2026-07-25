import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { renderMarkdown, renderMermaid, hasMermaid } from "./markdown";
import { pathToLeaf, childrenOf, leafOf } from "./tree";
import {
  answer as apiAnswer,
  approve as apiApprove,
  setMode as apiSetMode,
  setTriggerMode as apiSetTriggerMode,
  compact as apiCompact,
  setCap as apiSetCap,
  stopSession as apiStop,
  killTask as apiKillTask,
  queueMessage as apiQueue,
  setQueue as apiSetQueue,
  rewind as apiRewind,
  editFork as apiEditFork,
  closeSession as apiClose,
  createSession,
  fetchJournal,
  loadTree,
  openBus,
  sendChat,
  type ApprovalPolicy,
  type ApprovalRequest,
  type AskUserRequest,
  type BusFrame,
  type EntryView,
  type JournalRecord,
  type Mode,
  type QueuedMessage,
  type CompactionRequest,
  type SessionDescriptor,
  type TaskView,
  type TriggerMode,
} from "./api";
import {
  newSlice,
  reduceEvent,
  sliceFromDescriptor,
  applyState,
  type LiveAssistant,
  type SessionSlice,
} from "./session-state";

// Whimsical working-status words (SPEC §11 note: percolating…).
const WORKING = ["percolating…", "pondering…", "noodling…", "whirring…", "cogitating…", "ruminating…"];
const MODES: Mode[] = ["ask", "plan", "code"];
const POLICIES: ApprovalPolicy[] = ["manual", "auto-safe", "full-auto", "read-only"];
const TRIGGER_MODES: TriggerMode[] = ["auto", "manual", "suggest", "cancelable", "hard"];

/** The bag of live sessions, keyed by id (D-43). One multiplexed bus feeds every
 *  slice, so background sessions stay current while another is focused. */
type SliceMap = Record<string, SessionSlice>;
type SliceAction =
  | { t: "roster"; sessions: SessionDescriptor[] }
  | { t: "added"; session: SessionDescriptor }
  | { t: "removed"; id: string }
  | { t: "event"; id: string; event: import("./api").WireEvent }
  | { t: "tree"; id: string; entries: EntryView[]; activeLeaf: string | null; conversationId: string | null }
  | { t: "patch"; id: string; patch: Partial<SessionSlice> };

function slicesReducer(state: SliceMap, action: SliceAction): SliceMap {
  switch (action.t) {
    case "roster": {
      const next: SliceMap = {};
      for (const d of action.sessions) next[d.id] = state[d.id] ? applyState(state[d.id]!, d.state) : sliceFromDescriptor(d);
      return next;
    }
    case "added":
      return state[action.session.id]
        ? { ...state, [action.session.id]: applyState(state[action.session.id]!, action.session.state) }
        : { ...state, [action.session.id]: sliceFromDescriptor(action.session) };
    case "removed": {
      if (!state[action.id]) return state;
      const next = { ...state };
      delete next[action.id];
      return next;
    }
    case "event": {
      const slice = state[action.id] ?? newSlice(action.id);
      return { ...state, [action.id]: reduceEvent(slice, action.event) };
    }
    case "tree": {
      const slice = state[action.id] ?? newSlice(action.id);
      return {
        ...state,
        [action.id]: { ...slice, entries: action.entries, activeLeaf: action.activeLeaf, conversationId: action.conversationId, treeLoaded: true, live: null },
      };
    }
    case "patch": {
      const slice = state[action.id];
      if (!slice) return state;
      return { ...state, [action.id]: { ...slice, ...action.patch } };
    }
  }
}

export function App() {
  const [slices, dispatch] = useReducer(slicesReducer, {} as SliceMap);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  // Journal + TTS are viewed only for the focused pane, so they live here and
  // reset on focus change.
  const [journal, setJournal] = useState<JournalRecord[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [speakingId, setSpeakingId] = useState<string | null>(null);

  const focusedRef = useRef<string | null>(null);
  focusedRef.current = focusedId;
  const initializedRef = useRef(false); // first-roster focus/auto-create ran
  const loadingTrees = useRef(new Set<string>()); // in-flight tree fetches

  const focus = useCallback((id: string) => {
    setFocusedId(id);
    const url = new URL(window.location.href);
    url.searchParams.set("session", id);
    window.history.replaceState({}, "", url);
    setJournal([]);
    setDrawerOpen(false);
  }, []);

  // Handle one multiplexed bus frame (D-43): fold session events into their
  // slice, track the roster, and drive initial focus / auto-create.
  const onFrame = useCallback(
    (f: BusFrame) => {
      switch (f.type) {
        case "roster": {
          dispatch({ t: "roster", sessions: f.sessions });
          setConnected(true);
          if (initializedRef.current) return;
          initializedRef.current = true;
          if (f.sessions.length === 0) {
            void createSession().catch(() => {}); // an `added` frame will focus it
            return;
          }
          const wanted = new URL(window.location.href).searchParams.get("session");
          const pick = (wanted && f.sessions.find((s) => s.id === wanted)?.id) || f.sessions[0]!.id;
          focus(pick);
          break;
        }
        case "session-added":
          dispatch({ t: "added", session: f.session });
          if (!focusedRef.current) focus(f.session.id);
          break;
        case "session-removed":
          dispatch({ t: "removed", id: f.sessionId });
          break;
        case "session-event":
          dispatch({ t: "event", id: f.sessionId, event: f.event });
          break;
      }
    },
    [focus],
  );

  // One connection for the whole instance (D-43).
  useEffect(() => {
    const es = openBus(onFrame);
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [onFrame]);

  // If the focused session vanished (closed), fall back to another (or none).
  useEffect(() => {
    if (focusedId && !slices[focusedId]) {
      const ids = Object.keys(slices);
      setFocusedId(ids.length > 0 ? ids[0]! : null);
    }
  }, [slices, focusedId]);

  // Lazily load the focused session's tree on first focus; live events grow it.
  useEffect(() => {
    if (!focusedId) return;
    const slice = slices[focusedId];
    if (!slice || slice.treeLoaded || loadingTrees.current.has(focusedId)) return;
    loadingTrees.current.add(focusedId);
    void loadTree(focusedId)
      .then((t) => dispatch({ t: "tree", id: focusedId, entries: t.entries, activeLeaf: t.activeLeaf, conversationId: t.conversationId }))
      .finally(() => loadingTrees.current.delete(focusedId));
  }, [focusedId, slices]);

  const loadJournal = useCallback(async () => {
    const id = focusedRef.current;
    const conv = id ? slices[id]?.conversationId : null;
    if (!conv) return;
    setJournal(await fetchJournal(conv));
  }, [slices]);

  const notify = useCallback((id: string, message: string) => dispatch({ t: "patch", id, patch: { notice: message } }), []);

  // ---- Per-session actions (operate on the given session id). ----

  const setInput = useCallback((id: string, input: string) => dispatch({ t: "patch", id, patch: { input } }), []);

  const submit = useCallback(
    async (id: string) => {
      const text = (slices[id]?.input ?? "").trim();
      if (!text) return;
      dispatch({ t: "patch", id, patch: { input: "", notice: null } });
      try {
        await sendChat(id, text); // the user entry streams back over the bus
      } catch (err) {
        notify(id, (err as Error).message);
      }
    },
    [slices, notify],
  );

  const queueMsg = useCallback(
    async (id: string) => {
      const text = (slices[id]?.input ?? "").trim();
      if (!text) return;
      dispatch({ t: "patch", id, patch: { input: "" } });
      try {
        await apiQueue(id, text);
      } catch (err) {
        notify(id, (err as Error).message);
      }
    },
    [slices, notify],
  );

  const changeMode = useCallback(
    async (id: string, patch: { mode?: Mode; approval?: ApprovalPolicy }) => {
      dispatch({ t: "patch", id, patch }); // optimistic; the `mode` event re-syncs
      try {
        await apiSetMode(id, patch);
      } catch (err) {
        notify(id, (err as Error).message);
      }
    },
    [notify],
  );

  const changeTriggerMode = useCallback(
    async (id: string, mode: TriggerMode) => {
      dispatch({ t: "patch", id, patch: { triggerMode: mode } }); // optimistic; the event re-syncs
      try {
        await apiSetTriggerMode(id, mode);
      } catch (err) {
        notify(id, (err as Error).message);
      }
    },
    [notify],
  );

  // Compaction control (D-27, P6c): resolve a pending pre-send pause (Compact /
  // Skip), or compact on demand (the manual/suggest "Compact now" button).
  const doCompact = useCallback(
    async (id: string, opts: { skip?: boolean } = {}) => {
      dispatch({ t: "patch", id, patch: { pendingCompaction: null, working: !opts.skip } });
      try {
        await apiCompact(id, opts);
      } catch (err) {
        dispatch({ t: "patch", id, patch: { notice: (err as Error).message, working: false } });
      }
    },
    [],
  );

  const resolveApproval = useCallback(
    async (id: string, decision: { approve: boolean; editedArgs?: Record<string, unknown>; addRoot?: boolean | string }) => {
      dispatch({ t: "patch", id, patch: { pendingApproval: null, working: true } });
      try {
        await apiApprove(id, decision);
      } catch (err) {
        dispatch({ t: "patch", id, patch: { notice: (err as Error).message, working: false } });
      }
    },
    [],
  );

  const submitAnswer = useCallback(async (id: string, answers: Array<{ question: string; header?: string; answer: string }>) => {
    dispatch({ t: "patch", id, patch: { pendingAsk: null, working: true } });
    try {
      await apiAnswer(id, answers);
    } catch (err) {
      dispatch({ t: "patch", id, patch: { notice: (err as Error).message, working: false } });
    }
  }, []);

  const changeCap = useCallback(
    async (id: string, next: number | null) => {
      dispatch({ t: "patch", id, patch: { notice: null } });
      try {
        await apiSetCap(id, next);
      } catch (err) {
        notify(id, (err as Error).message);
      }
    },
    [notify],
  );

  const stop = useCallback(
    async (id: string, scope: "hard" | "soft") => {
      try {
        await apiStop(id, scope);
      } catch (err) {
        notify(id, (err as Error).message);
      }
    },
    [notify],
  );

  const killOne = useCallback(
    async (id: string, taskId: string) => {
      try {
        await apiKillTask(id, taskId);
      } catch (err) {
        notify(id, (err as Error).message);
      }
    },
    [notify],
  );

  const cancelQueued = useCallback(
    async (id: string, qid: string) => {
      const remaining = (slices[id]?.queue ?? []).filter((m) => m.id !== qid).map((m) => ({ text: m.text }));
      try {
        await apiSetQueue(id, remaining);
      } catch (err) {
        notify(id, (err as Error).message);
      }
    },
    [slices, notify],
  );

  const switchBranch = useCallback(
    async (id: string, siblingId: string) => {
      const slice = slices[id];
      if (!slice) return;
      try {
        await apiRewind(id, leafOf(slice.entries, siblingId));
        const t = await loadTree(id);
        dispatch({ t: "tree", id, entries: t.entries, activeLeaf: t.activeLeaf, conversationId: t.conversationId });
      } catch (err) {
        notify(id, (err as Error).message);
      }
    },
    [slices, notify],
  );

  const editMessage = useCallback(
    async (id: string, entryId: string, text: string) => {
      dispatch({ t: "patch", id, patch: { notice: null } });
      try {
        await apiEditFork(id, entryId, text);
        const t = await loadTree(id);
        dispatch({ t: "tree", id, entries: t.entries, activeLeaf: t.activeLeaf, conversationId: t.conversationId });
      } catch (err) {
        notify(id, (err as Error).message);
      }
    },
    [notify],
  );

  // Read an assistant reply aloud, or stop if it's already speaking (§11 TTS).
  const toggleSpeak = useCallback(
    (entryId: string, text: string) => {
      const synth = window.speechSynthesis;
      if (!synth) return;
      if (speakingId === entryId) {
        synth.cancel();
        setSpeakingId(null);
        return;
      }
      synth.cancel();
      const u = new SpeechSynthesisUtterance(plainText(text));
      u.onend = () => setSpeakingId((s) => (s === entryId ? null : s));
      setSpeakingId(entryId);
      synth.speak(u);
    },
    [speakingId],
  );

  // ---- Rail actions. ----

  const newSession = useCallback(async () => {
    try {
      const id = await createSession();
      focus(id); // slice arrives via the `added` frame
    } catch {
      /* the bus will show the roster regardless */
    }
  }, [focus]);

  const closeOne = useCallback(async (id: string) => {
    try {
      await apiClose(id); // server hard-stops + drops it; a `removed` frame follows
    } catch {
      /* ignore; roster is authoritative */
    }
  }, []);

  const openDrawer = useCallback(() => {
    void loadJournal();
    setDrawerOpen(true);
  }, [loadJournal]);

  const sessionList = Object.values(slices);
  const focused = focusedId ? slices[focusedId] : undefined;

  return (
    <div className="app-shell">
      <SessionRail
        sessions={sessionList}
        focusedId={focusedId}
        connected={connected}
        onFocus={focus}
        onNew={() => void newSession()}
        onClose={(id) => void closeOne(id)}
      />
      {focused ? (
        <ChatPane
          key={focused.id}
          slice={focused}
          journal={journal}
          drawerOpen={drawerOpen}
          speakingId={speakingId}
          onInput={setInput}
          onSubmit={submit}
          onQueue={queueMsg}
          onChangeMode={changeMode}
          onChangeTriggerMode={changeTriggerMode}
          onCompact={doCompact}
          onResolveApproval={resolveApproval}
          onSubmitAnswer={submitAnswer}
          onChangeCap={changeCap}
          onStop={stop}
          onKillTask={killOne}
          onCancelQueued={cancelQueued}
          onSwitchBranch={switchBranch}
          onEditMessage={editMessage}
          onSpeak={toggleSpeak}
          onLoadJournal={loadJournal}
          onOpenDrawer={openDrawer}
          onCloseDrawer={() => setDrawerOpen(false)}
        />
      ) : (
        <div className="pane empty-pane">
          <div className="empty">No session open. Create one to get started.</div>
          <button className="primary" onClick={() => void newSession()}>
            + New session
          </button>
        </div>
      )}
    </div>
  );
}

/** The left rail (D-43): one card per live session with its model, a status dot,
 *  live spend and mode; click to focus, ✕ to close (stop + drop from the bag). */
function SessionRail({
  sessions,
  focusedId,
  connected,
  onFocus,
  onNew,
  onClose,
}: {
  sessions: SessionSlice[];
  focusedId: string | null;
  connected: boolean;
  onFocus: (id: string) => void;
  onNew: () => void;
  onClose: (id: string) => void;
}) {
  const statusLabel = (s: SessionSlice): string => {
    if (s.pendingApproval) return "needs approval";
    if (s.pendingAsk) return "needs answer";
    if (s.capReached) return "cap reached";
    if (s.working || s.status === "running") return "working…";
    if (s.tasks.length > 0) return "task running";
    if (s.status === "halted") return "halted";
    return "idle";
  };
  const dotClass = (s: SessionSlice): string => {
    if (s.pendingApproval || s.pendingAsk || s.capReached) return "attn";
    if (s.working || s.status === "running" || s.tasks.length > 0) return "busy";
    if (s.status === "halted") return "halt";
    return "";
  };
  return (
    <aside className="rail">
      <div className="rail-head">
        <span className="brand">JLCode</span>
        <span className={`dot ${connected ? "on" : ""}`} title={connected ? "connected" : "connecting…"} />
      </div>
      <button className="rail-new" onClick={onNew} title="new session">
        + New
      </button>
      <div className="rail-list">
        {sessions.length === 0 && <div className="rail-empty">no live sessions</div>}
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`rail-item ${s.id === focusedId ? "focused" : ""}`}
            onClick={() => onFocus(s.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && onFocus(s.id)}
          >
            <div className="rail-item-top">
              <span className={`sdot ${dotClass(s)}`} />
              <span className="rail-model" title={s.model}>
                {s.model || "session"}
              </span>
              <button
                className="rail-close"
                title="close session (stops it)"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(s.id);
                }}
              >
                ✕
              </button>
            </div>
            <div className="rail-item-meta">
              <span className={`rail-status ${dotClass(s)}`}>{statusLabel(s)}</span>
              <span className="rail-spend">${s.spendUsd.toFixed(4)}</span>
              <span className="rail-mode">{s.mode}</span>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

/** The focused session's full chat surface: header controls + thread + composer.
 *  All state is the passed slice; all actions carry the session id back up. */
function ChatPane({
  slice,
  journal,
  drawerOpen,
  speakingId,
  onInput,
  onSubmit,
  onQueue,
  onChangeMode,
  onChangeTriggerMode,
  onCompact,
  onResolveApproval,
  onSubmitAnswer,
  onChangeCap,
  onStop,
  onKillTask,
  onCancelQueued,
  onSwitchBranch,
  onEditMessage,
  onSpeak,
  onLoadJournal,
  onOpenDrawer,
  onCloseDrawer,
}: {
  slice: SessionSlice;
  journal: JournalRecord[];
  drawerOpen: boolean;
  speakingId: string | null;
  onInput: (id: string, text: string) => void;
  onSubmit: (id: string) => void;
  onQueue: (id: string) => void;
  onChangeMode: (id: string, patch: { mode?: Mode; approval?: ApprovalPolicy }) => void;
  onChangeTriggerMode: (id: string, mode: TriggerMode) => void;
  onCompact: (id: string, opts?: { skip?: boolean }) => void;
  onResolveApproval: (id: string, d: { approve: boolean; editedArgs?: Record<string, unknown>; addRoot?: boolean | string }) => void;
  onSubmitAnswer: (id: string, answers: Array<{ question: string; header?: string; answer: string }>) => void;
  onChangeCap: (id: string, v: number | null) => void;
  onStop: (id: string, scope: "hard" | "soft") => void;
  onKillTask: (id: string, taskId: string) => void;
  onCancelQueued: (id: string, qid: string) => void;
  onSwitchBranch: (id: string, siblingId: string) => void;
  onEditMessage: (id: string, entryId: string, text: string) => void;
  onSpeak: (entryId: string, text: string) => void;
  onLoadJournal: () => void;
  onOpenDrawer: () => void;
  onCloseDrawer: () => void;
}) {
  const id = slice.id;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [workWord, setWorkWord] = useState(WORKING[0]!);

  // Rotate the working word while the agent is busy.
  useEffect(() => {
    if (!slice.working) return;
    let i = 0;
    const t = setInterval(() => setWorkWord(WORKING[++i % WORKING.length]!), 1400);
    return () => clearInterval(t);
  }, [slice.working]);

  // Keep the newest message / prompt in view.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [slice.entries, slice.activeLeaf, slice.live, slice.working, slice.pendingApproval, slice.pendingAsk, slice.pendingCompaction]);

  const path = pathToLeaf(slice.entries, slice.activeLeaf);
  const rendered = path.filter((e) => e.type === "user" || (e.type === "assistant" && (e.text || e.reasoningText)));

  // "Busy" = the agent can't take a fresh Send right now: the LLM is thinking, a
  // background command is running, or a prompt is open. While busy, the composer
  // queues (D-34) instead of sending.
  const blocked =
    slice.working ||
    slice.tasks.length > 0 ||
    slice.pendingApproval !== null ||
    slice.pendingAsk !== null ||
    slice.pendingCompaction !== null;

  return (
    <div className="pane">
      <header className="topbar">
        <span className="pane-model" title={slice.model}>
          {slice.model || "session"}
        </span>
        <div className="controls">
          <button className="ghost" title="debug journal (D-15)" onClick={onOpenDrawer}>
            journal
          </button>
          <SpendChip spendUsd={slice.spendUsd} capUsd={slice.capUsd} capReached={slice.capReached} onSetCap={(v) => onChangeCap(id, v)} />
          <StopControl active={slice.working || slice.tasks.length > 0} onStop={(scope) => onStop(id, scope)} />
          <div className="seg" role="group" aria-label="mode">
            {MODES.map((m) => (
              <button key={m} className={m === slice.mode ? "on" : ""} onClick={() => onChangeMode(id, { mode: m })}>
                {m}
              </button>
            ))}
          </div>
          <select
            className="policy"
            value={slice.approval}
            aria-label="approval policy"
            onChange={(e) => onChangeMode(id, { approval: e.target.value as ApprovalPolicy })}
          >
            {POLICIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <select
            className="policy compaction-mode"
            value={slice.triggerMode}
            aria-label="compaction trigger mode"
            title="when to compact the context (D-27)"
            onChange={(e) => onChangeTriggerMode(id, e.target.value as TriggerMode)}
          >
            {TRIGGER_MODES.map((m) => (
              <option key={m} value={m}>
                compact: {m}
              </option>
            ))}
          </select>
          {/* Manual mode gets an always-available compact button (D-27). */}
          {slice.triggerMode === "manual" && (
            <button className="ghost" title="compact the context now" onClick={() => onCompact(id)}>
              compact
            </button>
          )}
        </div>
      </header>

      <div className="thread" ref={scrollRef}>
        {rendered.length === 0 && !slice.live && !slice.pendingApproval && !slice.pendingAsk && (
          <div className="empty">Say something to get started.</div>
        )}
        {rendered.map((entry) => {
          const siblings = childrenOf(slice.entries, entry.parent);
          const branch =
            siblings.length > 1
              ? { index: siblings.findIndex((s) => s.id === entry.id), count: siblings.length, siblings }
              : null;
          return (
            <Message
              key={entry.id}
              entry={entry}
              branch={branch}
              onSwitch={(siblingId) => onSwitchBranch(id, siblingId)}
              onEdit={(entryId, text) => onEditMessage(id, entryId, text)}
              journal={journal.filter((r) => r.entryId === entry.id)}
              onNeedJournal={onLoadJournal}
              speaking={speakingId === entry.id}
              onSpeak={onSpeak}
            />
          );
        })}
        {slice.live && <LiveMessage live={slice.live} />}
        {slice.working && <div className="working">{workWord}</div>}
        {slice.tasks.length > 0 && <TasksPanel tasks={slice.tasks} onKill={(taskId) => onKillTask(id, taskId)} />}
        {slice.pendingApproval && <ApprovalCard request={slice.pendingApproval} onResolve={(d) => onResolveApproval(id, d)} />}
        {slice.pendingAsk && <AskForm request={slice.pendingAsk} onSubmit={(answers) => onSubmitAnswer(id, answers)} />}
        {slice.pendingCompaction && (
          <CompactionCard
            request={slice.pendingCompaction}
            onCompact={() => onCompact(id)}
            onSkip={() => onCompact(id, { skip: true })}
          />
        )}
        {/* suggest mode: non-blocking nudge once the budget is crossed (D-27). */}
        {slice.triggerMode === "suggest" && slice.needsCompaction && !slice.pendingCompaction && (
          <CompactionBanner onCompact={() => onCompact(id)} />
        )}
        {slice.capReached && <CapBanner spendUsd={slice.spendUsd} capUsd={slice.capUsd} onRaise={(v) => onChangeCap(id, v)} />}
        {slice.notice && <div className="notice">{slice.notice}</div>}
      </div>

      {slice.queue.length > 0 && (
        <div className="queue">
          <span className="queue-label">queued</span>
          {slice.queue.map((m) => (
            <button key={m.id} className="queued" title="cancel" onClick={() => onCancelQueued(id, m.id)}>
              <span className="queued-text">{m.text}</span>
              <span className="x">✕</span>
            </button>
          ))}
        </div>
      )}

      <footer className="composer">
        <textarea
          value={slice.input}
          placeholder={
            slice.pendingApproval || slice.pendingAsk
              ? "Respond to the agent above…"
              : blocked
                ? "Queue a message for the next turn…  (Enter to queue)"
                : "Message JLCode…  (Enter to send, Shift+Enter for newline)"
          }
          onChange={(e) => onInput(id, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (blocked) onQueue(id);
              else onSubmit(id);
            }
          }}
          rows={2}
        />
        {blocked ? (
          <button onClick={() => onQueue(id)} disabled={!slice.input.trim()}>
            Queue
          </button>
        ) : (
          <button onClick={() => onSubmit(id)} disabled={!slice.input.trim()}>
            Send
          </button>
        )}
      </footer>

      {drawerOpen && <JournalDrawer records={journal} entries={slice.entries} onClose={onCloseDrawer} onRefresh={onLoadJournal} />}
    </div>
  );
}

/** Strip the loudest markdown so text-to-speech doesn't read `##`/`*`/backticks. */
function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_#>]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

/** Live whole-tree spend in the corner (D-33); click to set / raise / clear the
 *  cap. Turns red on breach. */
function SpendChip({
  spendUsd,
  capUsd,
  capReached,
  onSetCap,
}: {
  spendUsd: number;
  capUsd: number | null;
  capReached: boolean;
  onSetCap: (v: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const commit = () => {
    const v = parseFloat(draft);
    onSetCap(Number.isFinite(v) && v >= 0 ? v : null);
    setOpen(false);
    setDraft("");
  };
  return (
    <div className="spend-wrap">
      <button
        className={`spend ${capReached ? "breach" : ""}`}
        title="whole-tree spend — click to set a cap"
        onClick={() => setOpen((o) => !o)}
      >
        ${spendUsd.toFixed(4)}
        {capUsd !== null && <span className="cap"> / ${capUsd.toFixed(2)}</span>}
      </button>
      {open && (
        <div className="spend-pop">
          <label>Spend cap (USD)</label>
          <input
            autoFocus
            inputMode="decimal"
            placeholder={capUsd !== null ? String(capUsd) : "e.g. 1.00"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && commit()}
          />
          <div className="spend-actions">
            <button className="primary" onClick={commit}>
              Set
            </button>
            <button
              onClick={() => {
                onSetCap(null);
                setOpen(false);
              }}
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The big red Stop (hard abort) with a caret menu for the soft, loop-only stop
 *  that lets running commands finish (D-34). */
function StopControl({ active, onStop }: { active: boolean; onStop: (scope: "hard" | "soft") => void }) {
  const [menu, setMenu] = useState(false);
  return (
    <div className="stop-wrap">
      <button className="stop" disabled={!active} onClick={() => onStop("hard")} title="stop everything now">
        ◼ Stop
      </button>
      <button className="stop caret" disabled={!active} onClick={() => setMenu((m) => !m)} aria-label="stop options">
        ▾
      </button>
      {menu && active && (
        <div className="stop-menu">
          <button
            onClick={() => {
              onStop("soft");
              setMenu(false);
            }}
          >
            Stop LLM loop only
            <span className="hint">let running commands finish; take no further turn</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** Running background commands (D-34): elapsed time + a per-task Kill. */
function TasksPanel({ tasks, onKill }: { tasks: TaskView[]; onKill: (id: string) => void }) {
  const [, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsed = (ms: number) => {
    const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  };
  return (
    <div className="card tasks">
      <div className="card-head">
        <span className="tool">background tasks</span>
        <span className="reason">running · killable</span>
      </div>
      {tasks.map((t) => (
        <div className="task" key={t.id}>
          <code className="task-cmd">{t.command}</code>
          <span className="task-time">{elapsed(t.startedAt)}</span>
          <button className="danger" onClick={() => onKill(t.id)}>
            Kill
          </button>
        </div>
      ))}
    </div>
  );
}

/** Cap-reached banner (D-33): nothing was killed; raising the cap resumes. */
function CapBanner({ spendUsd, capUsd, onRaise }: { spendUsd: number; capUsd: number | null; onRaise: (v: number) => void }) {
  return (
    <div className="card cap-banner">
      <div className="fence-note">
        ⚠ Spend cap reached — ${spendUsd.toFixed(4)}
        {capUsd !== null ? ` / $${capUsd.toFixed(2)}` : ""}. The agent stopped before the next model call; nothing was
        killed.
      </div>
      <div className="actions">
        {capUsd !== null && (
          <>
            <button className="primary" onClick={() => onRaise(capUsd * 2)}>
              Double the cap (${(capUsd * 2).toFixed(2)})
            </button>
            <button onClick={() => onRaise(capUsd + 1)}>+ $1.00</button>
          </>
        )}
      </div>
    </div>
  );
}

/** Pre-send compaction pause (D-27, P6c): `cancelable` offers Compact + Skip;
 *  `hard` offers Compact only ("can't proceed without acting"). */
function CompactionCard({
  request,
  onCompact,
  onSkip,
}: {
  request: CompactionRequest;
  onCompact: () => void;
  onSkip: () => void;
}) {
  const pct = request.window > 0 ? Math.round((request.prefixTokens / request.window) * 100) : 0;
  return (
    <div className="card compaction-card">
      <div className="card-head">
        <span className="tool">context nearly full</span>
        <span className="reason">{request.cancelable ? "compact to continue?" : "compaction required"}</span>
      </div>
      <div className="fence-note">
        The next request (~{request.prefixTokens.toLocaleString()} tokens{pct ? `, ${pct}% of the window` : ""}) would
        exceed the budget. Compacting folds the conversation so far into a summary and continues.
      </div>
      <div className="actions">
        <button className="primary" onClick={onCompact}>
          Compact &amp; continue
        </button>
        {request.cancelable && (
          <button onClick={onSkip} title="send this turn without compacting (accepts a one-turn overshoot)">
            Skip once
          </button>
        )}
      </div>
    </div>
  );
}

/** Non-blocking "suggest" nudge (D-27): the budget is crossed but the loop keeps
 *  going; the user may compact whenever. */
function CompactionBanner({ onCompact }: { onCompact: () => void }) {
  return (
    <div className="card compaction-banner">
      <div className="fence-note">◆ Context is getting large — compacting will keep replies fast and in-window.</div>
      <div className="actions">
        <button className="primary" onClick={onCompact}>
          Compact now
        </button>
      </div>
    </div>
  );
}

/** Markdown → sanitized HTML, with mermaid diagrams rendered after mount (P5d). */
function MarkdownView({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = renderMarkdown(text);
  useEffect(() => {
    if (ref.current && hasMermaid(html)) void renderMermaid(ref.current);
  }, [html]);
  return <div className="markdown" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** The streaming in-flight assistant turn (overlay before it's an entry). */
function LiveMessage({ live }: { live: LiveAssistant }) {
  if (!live.text && !live.reasoning) return null;
  return (
    <div className="msg assistant">
      {live.reasoning ? (
        <details className="reasoning">
          <summary>reasoning</summary>
          <pre>{live.reasoning}</pre>
        </details>
      ) : null}
      {live.text ? (
        <div className="bubble">
          <MarkdownView text={live.text} />
        </div>
      ) : null}
    </div>
  );
}

interface BranchNav {
  index: number;
  count: number;
  siblings: EntryView[];
}

/** One rendered turn (user or assistant entry) with the P5d affordances: branch
 *  arrows when it has siblings (D-10/D-17), a pencil to edit-fork a user message,
 *  a per-turn journal expander (D-15), and a TTS button on assistant replies. */
function Message({
  entry,
  branch,
  onSwitch,
  onEdit,
  journal,
  onNeedJournal,
  speaking,
  onSpeak,
}: {
  entry: EntryView;
  branch: BranchNav | null;
  onSwitch: (siblingId: string) => void;
  onEdit: (entryId: string, text: string) => void;
  journal: JournalRecord[];
  onNeedJournal: () => void;
  speaking: boolean;
  onSpeak: (id: string, text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.text ?? "");
  const [showJournal, setShowJournal] = useState(false);

  const arrows = branch ? (
    <span className="branch">
      <button className="arrow" disabled={branch.index <= 0} title="previous branch" onClick={() => onSwitch(branch.siblings[branch.index - 1]!.id)}>
        ‹
      </button>
      <span className="branch-idx">
        {branch.index + 1}/{branch.count}
      </span>
      <button
        className="arrow"
        disabled={branch.index >= branch.count - 1}
        title="next branch"
        onClick={() => onSwitch(branch.siblings[branch.index + 1]!.id)}
      >
        ›
      </button>
    </span>
  ) : null;

  if (entry.type === "user") {
    if (editing) {
      return (
        <div className="msg user">
          <div className="edit">
            <textarea value={draft} spellCheck={false} rows={Math.min(8, draft.split("\n").length + 1)} onChange={(e) => setDraft(e.target.value)} autoFocus />
            <div className="edit-actions">
              <button className="primary" disabled={!draft.trim()} onClick={() => { setEditing(false); onEdit(entry.id, draft.trim()); }}>
                Save & fork
              </button>
              <button onClick={() => { setEditing(false); setDraft(entry.text ?? ""); }}>Cancel</button>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="msg user">
        <div className="msg-inner">
          <div className="bubble">{entry.text}</div>
          <div className="msg-tools">
            {arrows}
            <button className="icon" title="edit & fork" onClick={() => { setDraft(entry.text ?? ""); setEditing(true); }}>
              ✎
            </button>
          </div>
        </div>
      </div>
    );
  }

  // assistant
  return (
    <div className="msg assistant">
      {entry.reasoningText ? (
        <details className="reasoning">
          <summary>reasoning</summary>
          <pre>{entry.reasoningText}</pre>
        </details>
      ) : null}
      {entry.text ? (
        <div className="bubble">
          <MarkdownView text={entry.text} />
          {entry.truncated ? <div className="truncated">⚠ output was truncated (max_tokens)</div> : null}
        </div>
      ) : null}
      <div className="msg-tools">
        {arrows}
        <button className={`icon ${speaking ? "on" : ""}`} title={speaking ? "stop" : "read aloud"} onClick={() => onSpeak(entry.id, entry.text ?? "")}>
          {speaking ? "◼" : "🔊"}
        </button>
        <button
          className={`icon ${showJournal ? "on" : ""}`}
          title="debug journal for this turn"
          onClick={() => { if (!showJournal) onNeedJournal(); setShowJournal((s) => !s); }}
        >
          ⓘ
        </button>
      </div>
      {showJournal ? <JournalRecords records={journal} /> : null}
    </div>
  );
}

/** Compact per-turn journal records (D-15): the llm call(s) + tools of a turn. */
function JournalRecords({ records }: { records: JournalRecord[] }) {
  if (records.length === 0) return <div className="journal empty-journal">no journal records for this turn</div>;
  return (
    <div className="journal">
      {records.map((r, i) => (
        <JournalRow key={i} r={r} />
      ))}
    </div>
  );
}

function JournalRow({ r }: { r: JournalRecord }) {
  if (r.kind === "llm") {
    const u = r.usage;
    return (
      <div className={`jrow ${r.error ? "err" : ""}`}>
        <div className="jrow-head">
          <span className="jkind llm">llm</span>
          <span className="jmodel">{r.model}</span>
          <span className="jmeta">{r.ms}ms · {r.messages} msgs{r.finishReason ? ` · ${r.finishReason}` : ""}{r.truncated ? " · truncated" : ""}</span>
        </div>
        {r.tools.length > 0 ? <div className="jmeta">tools: {r.tools.join(", ")}</div> : null}
        {u ? (
          <div className="jmeta">
            tokens: {u.promptTokens ?? "?"}→{u.completionTokens ?? "?"}
            {u.cachedTokens ? ` (${u.cachedTokens} cached)` : ""}
            {typeof u.costUsd === "number" ? ` · $${u.costUsd.toFixed(5)}` : ""}
          </div>
        ) : null}
        {r.error ? <div className="jerr">{r.error}</div> : null}
        {r.reasoningPreview ? <pre className="jprev">💭 {r.reasoningPreview}</pre> : null}
        {r.textPreview ? <pre className="jprev">{r.textPreview}</pre> : null}
      </div>
    );
  }
  return (
    <div className={`jrow ${r.isError ? "err" : ""}`}>
      <div className="jrow-head">
        <span className="jkind tool">tool</span>
        <span className="jmodel">{r.name}</span>
        <span className="jmeta">{r.ms}ms{r.isError ? " · error" : ""}</span>
      </div>
      <pre className="jprev">args: {r.argsPreview}</pre>
      <pre className="jprev">→ {r.contentPreview}</pre>
    </div>
  );
}

/** The whole-conversation debug journal in a slide-over drawer (D-15). Records
 *  are grouped by the assistant turn (entryId) they belong to. */
function JournalDrawer({
  records,
  entries,
  onClose,
  onRefresh,
}: {
  records: JournalRecord[];
  entries: EntryView[];
  onClose: () => void;
  onRefresh: () => void;
}) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer">
        <div className="drawer-head">
          <span className="drawer-title">Debug journal</span>
          <span className="drawer-sub">{records.length} records</span>
          <button className="ghost" onClick={onRefresh} title="reload">
            ↻
          </button>
          <button className="ghost" onClick={onClose} title="close">
            ✕
          </button>
        </div>
        <div className="drawer-body">
          {records.length === 0 ? (
            <div className="empty">No journal records yet.</div>
          ) : (
            records.map((r, i) => {
              const turn = r.entryId ? byId.get(r.entryId) : undefined;
              const label = turn?.text ? turn.text.slice(0, 48) : r.entryId ? "(tool-only turn)" : "(untied)";
              return (
                <div key={i} className="drawer-item">
                  <div className="drawer-turn" title={r.entryId ?? ""}>
                    ↳ {label}
                  </div>
                  <JournalRow r={r} />
                </div>
              );
            })
          )}
        </div>
      </aside>
    </>
  );
}

/** The primary editable arg for a tool (the D-16 quick-fix case), if any. */
function primaryArgKey(args: Record<string, unknown>): string | null {
  for (const k of ["command", "path", "pattern"]) if (typeof args[k] === "string") return k;
  return null;
}

/** Approval card with the hybrid edit-before-approve editor (D-16): a prominent
 *  field for the primary arg plus a collapsible raw-JSON box for the rest, and
 *  the soft-fence out-of-fence choices (D-19). */
function ApprovalCard({
  request,
  onResolve,
}: {
  request: ApprovalRequest;
  onResolve: (d: { approve: boolean; editedArgs?: Record<string, unknown>; addRoot?: boolean | string }) => void;
}) {
  const primaryKey = primaryArgKey(request.args);
  const [edited, setEdited] = useState<Record<string, unknown>>({ ...request.args });
  const [rawText, setRawText] = useState(() => JSON.stringify(request.args, null, 2));
  const [rawOpen, setRawOpen] = useState(false);
  const [jsonErr, setJsonErr] = useState<string | null>(null);

  const setPrimary = (value: string) => {
    const next = { ...edited, [primaryKey!]: value };
    setEdited(next);
    setRawText(JSON.stringify(next, null, 2));
    setJsonErr(null);
  };
  const onRaw = (text: string) => {
    setRawText(text);
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      setEdited(parsed);
      setJsonErr(null);
    } catch (e) {
      setJsonErr((e as Error).message);
    }
  };

  const changed = JSON.stringify(edited) !== JSON.stringify(request.args);
  const editedArgs = changed ? edited : undefined;
  const fence = request.outOfFence;

  return (
    <div className="card approval">
      <div className="card-head">
        <span className="tool">{request.tool}</span>
        <span className={`kind ${request.kind}`}>{request.kind}</span>
        <span className="reason">{request.reason}</span>
      </div>

      {primaryKey ? (
        <label className="field">
          <span>{primaryKey}</span>
          <input value={String(edited[primaryKey] ?? "")} spellCheck={false} onChange={(e) => setPrimary(e.target.value)} />
        </label>
      ) : null}

      <details open={rawOpen || !primaryKey} onToggle={(e) => setRawOpen((e.target as HTMLDetailsElement).open)}>
        <summary>raw args (JSON)</summary>
        <textarea className="raw" value={rawText} spellCheck={false} rows={Math.min(10, rawText.split("\n").length + 1)} onChange={(e) => onRaw(e.target.value)} />
        {jsonErr ? <div className="json-err">invalid JSON: {jsonErr}</div> : null}
      </details>

      {fence ? (
        <div className="fence">
          <div className="fence-note">⚠ outside the workspace fence:</div>
          <ul>
            {fence.paths.map((p) => (
              <li key={p}>
                <code>{p}</code>
              </li>
            ))}
          </ul>
          <div className="actions">
            <button className="primary" disabled={!!jsonErr} onClick={() => onResolve({ approve: true, editedArgs })}>
              Allow once
            </button>
            <button className="primary" disabled={!!jsonErr} onClick={() => onResolve({ approve: true, editedArgs, addRoot: true })}>
              Remember <code>{fence.suggestedRoot}</code>
            </button>
            <button className="danger" onClick={() => onResolve({ approve: false })}>
              Deny
            </button>
          </div>
        </div>
      ) : (
        <div className="actions">
          <button className="primary" disabled={!!jsonErr} onClick={() => onResolve({ approve: true, editedArgs })}>
            {changed ? "Approve edited" : "Approve"}
          </button>
          <button className="danger" onClick={() => onResolve({ approve: false })}>
            Deny
          </button>
        </div>
      )}
    </div>
  );
}

/** A single question's local selection state. */
interface QState {
  selected: string[];
  text: string;
}

/** The ask_user form (D-18): one field per question, options as buttons
 *  (single- or multi-select), optional free-text, single Submit. */
function AskForm({
  request,
  onSubmit,
}: {
  request: AskUserRequest;
  onSubmit: (answers: Array<{ question: string; header?: string; answer: string }>) => void;
}) {
  const [state, setState] = useState<QState[]>(() => request.questions.map(() => ({ selected: [], text: "" })));

  const update = (i: number, fn: (q: QState) => QState) =>
    setState((s) => s.map((q, j) => (j === i ? fn(q) : q)));

  const toggle = (i: number, opt: string, multi: boolean) =>
    update(i, (q) => {
      if (multi) {
        return q.selected.includes(opt)
          ? { ...q, selected: q.selected.filter((o) => o !== opt) }
          : { ...q, selected: [...q.selected, opt] };
      }
      return { ...q, selected: q.selected[0] === opt ? [] : [opt] };
    });

  const answerFor = (q: QState): string => {
    const parts = [...q.selected];
    const t = q.text.trim();
    if (t) parts.push(t);
    return parts.join(", ");
  };

  const answered = state.every((q, i) => {
    const def = request.questions[i]!;
    // A question with only free-text can be blank; option questions need a pick.
    if (def.options && def.options.length > 0 && !def.allowFreeText) return q.selected.length > 0;
    return true;
  });

  const submit = () =>
    onSubmit(
      request.questions.map((def, i) => ({
        question: def.question,
        ...(def.header ? { header: def.header } : {}),
        answer: answerFor(state[i]!),
      })),
    );

  return (
    <div className="card ask">
      {request.questions.map((q, i) => (
        <div className="q" key={i}>
          <div className="q-head">
            {q.header ? <span className="q-header">{q.header}</span> : null}
            <span className="q-text">{q.question}</span>
            {q.multiSelect ? <span className="q-hint">choose any</span> : null}
          </div>
          {q.options && q.options.length > 0 ? (
            <div className="opts">
              {q.options.map((opt) => (
                <button
                  key={opt}
                  className={state[i]!.selected.includes(opt) ? "opt on" : "opt"}
                  onClick={() => toggle(i, opt, q.multiSelect ?? false)}
                >
                  {opt}
                </button>
              ))}
            </div>
          ) : null}
          {q.allowFreeText || !q.options || q.options.length === 0 ? (
            <input
              className="free"
              placeholder={q.options && q.options.length ? "or type your own…" : "type your answer…"}
              value={state[i]!.text}
              onChange={(e) => update(i, (s) => ({ ...s, text: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && request.questions.length === 1 && answered) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          ) : null}
        </div>
      ))}
      <div className="actions">
        <button className="primary" disabled={!answered} onClick={submit}>
          Submit
        </button>
      </div>
    </div>
  );
}
