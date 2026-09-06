import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { renderMarkdown, renderMermaid, hasMermaid } from "./markdown";
import { fileArgs, formatBytes, outputStats, prettyArgs, summarizeArgs } from "./tool-view";
import { abbreviatePath, folderName, tabTitle } from "./workspace";
import { newAttentionMemory, stepAttention } from "./attention";
import { createBlipper } from "./blip";
import { createSpeaker, newAutoReadMemory, plainText, stepAutoRead } from "./tts";
import { pathToLeaf, childrenOf, leafOf } from "./tree";
import { isAwaiting } from "./session-state";
import { fitModelLabel } from "./model-label";
import { isViewSwitch, newFollow, stepFollow, type FollowEvent, type FollowState } from "./scroll";
import {
  answer as apiAnswer,
  approve as apiApprove,
  setMode as apiSetMode,
  setTitle as apiSetTitle,
  setTriggerMode as apiSetTriggerMode,
  compact as apiCompact,
  continueRun as apiContinue,
  resolvePersistence as apiResolvePersistence,
  setCap as apiSetCap,
  stopSession as apiStop,
  retryTurn as apiRetry,
  fetchSessionState as apiSessionState,
  killTask as apiKillTask,
  queueMessage as apiQueue,
  setTodos as apiSetTodos,
  setQueue as apiSetQueue,
  rewind as apiRewind,
  editFork as apiEditFork,
  closeSession as apiClose,
  renameConversation as apiRenameConversation,
  deleteConversation as apiDeleteConversation,
  createSession,
  fetchConfig,
  fetchJournal,
  fetchMcpStatus,
  listConversations,
  loadConversation,
  loadTree,
  openBus,
  sendChat,
  type ApprovalPolicy,
  type ApprovalRequest,
  type ToolPreviewDiff,
  type ToolPreviewFile,
  type AskAnswer,
  type AskUserRequest,
  type BusFrame,
  type ConversationRow,
  type EntryView,
  type LoadedConversation,
  type InstanceConfig,
  type JournalRecord,
  type LearnAnswers,
  type McpServerStatus,
  type McpStatus,
  type Mode,
  type QueuedMessage,
  type CompactionRequest,
  type StallRequest,
  type PersistenceFault,
  type SessionDescriptor,
  type SessionState,
  type TaskView,
  type TodoItem,
  type TriggerMode,
} from "./api";
import { askActions, buildAnswers, emptyQState, toggleOption, type QState } from "./ask-form";
import {
  newSlice,
  reduceEvent,
  sliceFromDescriptor,
  applyState,
  isUnresumable,
  type LiveAssistant,
  type SessionSlice,
} from "./session-state";
import { readBoolPref, readNumberPref, writePref } from "./prefs";

// Whimsical working-status words (SPEC §11 note: percolating…).
const WORKING = ["percolating…", "pondering…", "noodling…", "whirring…", "cogitating…", "ruminating…"];
const MODES: Mode[] = ["ask", "plan", "code"];
const POLICIES: ApprovalPolicy[] = ["manual", "auto-safe", "full-auto", "read-only"];
const TRIGGER_MODES: TriggerMode[] = ["auto", "manual", "suggest", "cancelable", "hard"];
/** How long a running turn must go completely silent before we offer to abandon
 *  and re-send it (D-57). Long enough that a model thinking hard, or a slow
 *  first token on a cold route, never trips it. */
const HUNG_AFTER_MS = 20_000;

/** The bag of live sessions, keyed by id (D-43). One multiplexed bus feeds every
 *  slice, so background sessions stay current while another is focused. */
type SliceMap = Record<string, SessionSlice>;
type SliceAction =
  | { t: "roster"; sessions: SessionDescriptor[] }
  | { t: "added"; session: SessionDescriptor }
  | { t: "removed"; id: string }
  | { t: "event"; id: string; event: import("./api").WireEvent }
  | { t: "tree"; id: string; entries: EntryView[]; activeLeaf: string | null; conversationId: string | null }
  // Believe the server over our own copy (X-21/D-57) — the settled state,
  // pauses included, after a request we can no longer account for.
  | { t: "state"; id: string; state: SessionState }
  | { t: "patch"; id: string; patch: Partial<SessionSlice> };

/** A read-only look at a persisted conversation (X-12). Deliberately *not* a
 *  slice: a peek has no `Session` behind it, no rail card, and no event stream —
 *  it is a view over disk. `leaf` is local (branch arrows move the view without
 *  writing an `active-leaf` record), and it is what the first message continues
 *  from when the peek is promoted into a live session. */
type PeekState = {
  row: ConversationRow;
  conv: LoadedConversation | null; // null while loading
  leaf: string | null;
  input: string;
  error: string | null;
  /** A pre-H-04 log the model rejected on replay: fragmented `reasoning_details`
   *  are already on disk and the append-only log is never rewritten, so the only
   *  honest offer is a fresh thread. */
  unrecoverable: boolean;
  sending: boolean;
};

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
    case "state": {
      const slice = state[action.id];
      if (!slice) return state;
      return { ...state, [action.id]: applyState(slice, action.state) };
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
  // Which workspace this instance serves (X-10) — per instance, fetched once.
  const [instance, setInstance] = useState<InstanceConfig | null>(null);
  // Persisted history (X-12) and the read-only peek open over the main pane.
  const [history, setHistory] = useState<ConversationRow[]>([]);
  const [showAllDirs, setShowAllDirs] = useState(() => readBoolPref("history.allDirs", false));
  const [peek, setPeek] = useState<PeekState | null>(null);
  // A failed rename/delete has no session slice to carry its `notice` (X-12b).
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);
  // Attention (X-26): the sound preference, and the tab-title marker's latch.
  const [blipOn, setBlipOn] = useState(() => readBoolPref("notify.blip", true));
  const [attention, setAttention] = useState(false);
  /** Auto-read (X-13), the loud neighbour of the blip. **Default off**, which is
   *  the one place this deliberately parts company with X-26: a 150ms chirp that
   *  nobody asked for is a notification, and a voice reading a page of prose at
   *  someone who did not know the feature existed is a fright. It costs nothing
   *  to discover — it sits in the same cluster, one line under the toggle that
   *  *is* on by default, and the per-message 🔊 already says the client can
   *  talk. */
  const [autoReadOn, setAutoReadOn] = useState(() => readBoolPref("tts.autoRead", false));

  const focusedRef = useRef<string | null>(null);
  focusedRef.current = focusedId;
  const initializedRef = useRef(false); // first-roster focus/auto-create ran
  const loadingTrees = useRef(new Set<string>()); // in-flight tree fetches
  const blipper = useRef(createBlipper()); // touches no audio API until armed
  const attentionMemory = useRef(newAttentionMemory());
  // One speaker for the whole client: the per-message 🔊 and auto-read are the
  // same channel, so there is one utterance in flight and one place that knows
  // what is being spoken (H-07 — that is exactly what used to drift apart).
  const speaker = useRef(createSpeaker());
  const autoReadMemory = useRef(newAutoReadMemory());

  const focus = useCallback((id: string) => {
    setFocusedId(id);
    const url = new URL(window.location.href);
    url.searchParams.set("session", id);
    window.history.replaceState({}, "", url);
    setJournal([]);
    setDrawerOpen(false);
    setPeek(null); // focusing a live session leaves the peek (X-12)
    speaker.current.cancel(); // one voice, and it belongs to the pane in view (X-13)
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

  // ---- Persisted history (X-12). ----

  const refreshHistory = useCallback(async () => {
    setHistoryNotice(null);
    setHistory(await listConversations(showAllDirs ? "all" : undefined).catch(() => []));
  }, [showAllDirs]);

  // Reload on mount, on the dir-filter toggle, and whenever the roster changes:
  // closing a session is exactly when its thread should appear under HISTORY,
  // and promoting a peek is when it should leave.
  const rosterKey = Object.keys(slices).sort().join(",");
  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory, rosterKey]);

  const toggleAllDirs = useCallback(() => {
    setShowAllDirs((v) => {
      writePref("history.allDirs", String(!v));
      return !v;
    });
  }, []);

  /** Open a history row read-only. Creates nothing — the rail is untouched and a
   *  running turn keeps streaming behind the peek. */
  const openPeek = useCallback((row: ConversationRow) => {
    setPeek({ row, conv: null, leaf: null, input: "", error: null, unrecoverable: false, sending: false });
    void loadConversation(row.id)
      .then((conv) => setPeek((p) => (p?.row.id === row.id ? { ...p, conv, leaf: conv.activeLeaf } : p)))
      .catch((err: unknown) =>
        setPeek((p) => (p?.row.id === row.id ? { ...p, error: (err as Error).message } : p)),
      );
  }, []);

  /** Rename a past thread from its row (X-12b). Addressed by conversation, so it
   *  works on a thread with no session behind it. */
  const renameHistory = useCallback(
    async (id: string, title: string) => {
      setHistory((rows) => rows.map((r) => (r.id === id ? { ...r, title } : r))); // optimistic
      try {
        await apiRenameConversation(id, title);
      } catch (err) {
        setHistoryNotice((err as Error).message);
        void refreshHistory(); // the optimistic label was a guess; take the server's
      }
    },
    [refreshHistory],
  );

  /** Delete a past thread (X-12b). The server masks it rather than unlinking, so
   *  this hides a row — it does not destroy the log. */
  const deleteHistory = useCallback(
    async (id: string) => {
      setHistory((rows) => rows.filter((r) => r.id !== id));
      setPeek((p) => (p?.row.id === id ? null : p)); // never leave a deleted thread open
      try {
        await apiDeleteConversation(id);
      } catch (err) {
        setHistoryNotice((err as Error).message);
        void refreshHistory();
      }
    },
    [refreshHistory],
  );

  /** Promote a peek: the first message materializes the session (X-12). The
   *  server attaches to a live session on this conversation if one exists, so
   *  two tabs converge rather than forking the tree (the X-14 hazard). */
  const promotePeek = useCallback(async () => {
    const current = peek;
    const text = (current?.input ?? "").trim();
    if (!current || !text || current.sending) return;
    setPeek({ ...current, sending: true, error: null });
    try {
      const { sessionId } = await sendChat(null, text, { conversationId: current.row.id, leaf: current.leaf });
      focus(sessionId); // clears the peek; the slice arrives on the `added` frame
    } catch (err) {
      const message = (err as Error).message;
      // Pre-H-04 logs replay malformed signed reasoning and the provider refuses
      // the call. Nothing can repair it in place, so say so and offer the door.
      const unrecoverable = isUnresumable(message);
      setPeek((p) => (p?.row.id === current.row.id ? { ...p, sending: false, error: message, unrecoverable } : p));
    }
  }, [peek, focus]);

  // Which project am I looking at? (X-10) The workspace names the tab, so two
  // instances are tellable apart in a collapsed tab strip.
  useEffect(() => {
    void fetchConfig().then(setInstance).catch(() => {});
  }, []);
  const workspace = instance?.workingDir ? folderName(instance.workingDir) : null;
  const focusedTitle = (focusedId ? slices[focusedId]?.title : null) ?? null;
  useEffect(() => {
    // `<label> — <folder>`: the label is what changes as you work, the folder is
    // which project it belongs to (X-09 + X-10), behind the attention marker
    // when something wanted you while you were away (X-26).
    document.title = tabTitle(workspace, focusedTitle, attention);
  }, [workspace, focusedTitle, attention]);

  // ---- Attention: the blip + the tab marker (X-26). ----

  /**
   * Arm the audio for a preference remembered from *last* session.
   *
   * Browsers only hand out a running `AudioContext` inside a user gesture, so a
   * ticked box in `localStorage` buys nothing on its own. The first click or
   * keypress of the session is a gesture like any other — this listener spends
   * it and then removes itself. Nothing is created on load, which is the whole
   * point of X-26(b): the toggle's own click covers the same-session case.
   */
  useEffect(() => {
    if (!blipOn) return;
    const arm = () => blipper.current.arm();
    window.addEventListener("pointerdown", arm, { once: true });
    window.addEventListener("keydown", arm, { once: true });
    return () => {
      window.removeEventListener("pointerdown", arm);
      window.removeEventListener("keydown", arm);
    };
  }, [blipOn]);

  // A session crossed into wanting you. `stepAttention` owns the rules (prime on
  // first sight, ignore what you are already looking at, one blip per batch);
  // this only supplies the browser facts and spends the result.
  useEffect(() => {
    const step = stepAttention(attentionMemory.current, Object.values(slices), {
      focusedId,
      hidden: document.hidden,
      now: Date.now(),
    });
    attentionMemory.current = step.memory;
    if (step.blip && blipOn) blipper.current.blip();
    // The marker is *not* gated on the sound preference: it is free, silent, and
    // the only signal left for a tab you have not looked at in an hour.
    if (step.mark) setAttention(true);
  }, [slices, focusedId, blipOn]);

  // Looking at the tab is what clears the marker — it has already done its job,
  // and the rail's per-session dots say which one it was.
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) setAttention(false);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  /** The toggle is the gesture (X-26b). Turning it on arms the context *and*
   *  plays the blip once — a preview, and the proof that the browser will let it
   *  through, which is otherwise unknowable until the next time you look away. */
  const toggleBlip = useCallback(() => {
    const next = !blipOn;
    setBlipOn(next);
    writePref("notify.blip", String(next));
    if (next) {
      blipper.current.arm();
      // `resume()` is async; a beat later the context is running.
      window.setTimeout(() => blipper.current.blip(), 120);
    }
  }, [blipOn]);

  // ---- Auto-read: speak the reply when the turn comes back (X-13). ----

  // The speaker is the single source of truth for "something is being read", so
  // the button state follows it rather than the other way round.
  useEffect(() => {
    speaker.current.onChange((key) => setSpeakingId(key));
  }, []);

  /** Same arming story as the blip, and for the same reason — measured, not
   *  assumed (VISUAL-LOG X-13): a `speak()` with no gesture anywhere in the
   *  document's history fails with `not-allowed`, while **sticky** activation is
   *  enough, so one ordinary click buys every later utterance, including ones
   *  fired from a wire event minutes afterwards. Spend the session's first click
   *  on a preference carried over from last time; the toggle's own click covers
   *  the same-session case. */
  useEffect(() => {
    if (!autoReadOn) return;
    const arm = () => speaker.current.arm();
    window.addEventListener("pointerdown", arm, { once: true });
    window.addEventListener("keydown", arm, { once: true });
    return () => {
      window.removeEventListener("pointerdown", arm);
      window.removeEventListener("keydown", arm);
    };
  }, [autoReadOn]);

  // `stepAutoRead` owns the rules (focused pane only, prime on first sight and
  // on a tree that has only just loaded, never mid-turn); this spends the
  // result. Note the memory is folded even while the preference is **off**, so
  // switching auto-read on does not immediately read out a backlog.
  useEffect(() => {
    const step = stepAutoRead(autoReadMemory.current, Object.values(slices), {
      focusedId,
      enabled: autoReadOn,
    });
    autoReadMemory.current = step.memory;
    if (step.speak) speaker.current.speak(step.speak.key, step.speak.text);
  }, [slices, focusedId, autoReadOn]);

  /** What stops it mid-sentence. Typing is the honest signal that you are back
   *  and reading with your eyes — at that point the voice is competing with your
   *  own thinking rather than saving you a look. Deliberately *not* any keypress
   *  anywhere: a Cmd-Tab or a scroll is not an interruption. Focusing another
   *  session cancels for a different reason — one voice, and it would otherwise
   *  be reading the pane you just left. */
  const hushSpeech = useCallback(() => speaker.current.cancel(), []);

  /** Turning it on is the gesture, and it says one short line back — the same
   *  move as the blip's preview, and worth more here: it proves the browser will
   *  let this document speak *and* that a voice exists, neither of which is
   *  knowable until something is actually said (a machine with no voice
   *  installed fails at `speak()`, silently, exactly like a healthy one that has
   *  nothing to read). Turning it off stops anything in flight — otherwise the
   *  first thing "off" does is keep talking. */
  const toggleAutoRead = useCallback(() => {
    const next = !autoReadOn;
    setAutoReadOn(next);
    writePref("tts.autoRead", String(next));
    if (next) {
      speaker.current.arm();
      speaker.current.speak("preview", "Auto-read is on.");
    } else {
      speaker.current.cancel();
    }
  }, [autoReadOn]);

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

  const setInput = useCallback((id: string, input: string) => {
    speaker.current.cancel(); // you started typing — the reading has done its job (X-13)
    dispatch({ t: "patch", id, patch: { input } });
  }, []);

  const submit = useCallback(
    async (id: string) => {
      const text = (slices[id]?.input ?? "").trim();
      if (!text) return;
      const conversationId = slices[id]?.conversationId ?? undefined;
      dispatch({ t: "patch", id, patch: { input: "", notice: null } });
      try {
        // The conversation rides along as the revival fallback (X-12): if this
        // tab's session died with a previous process, the server resumes from
        // disk instead of 404ing. Costs nothing when the session is alive.
        const { sessionId } = await sendChat(id, text, { conversationId });
        if (sessionId !== id) focus(sessionId); // revived under a new id
      } catch (err) {
        notify(id, (err as Error).message);
      }
    },
    [slices, notify, focus],
  );

  /** Commit the todo list the user just finished editing (X-31). The server
   *  decides whether anything actually changed — and therefore whether the agent
   *  is told — so a no-op close of the editor stays a no-op. */
  const saveTodos = useCallback(
    async (id: string, items: { id?: string; text: string; done: boolean; note?: string }[]) => {
      try {
        await apiSetTodos(id, items);
      } catch (err) {
        notify(id, (err as Error).message);
      }
    },
    [notify],
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

  // Resume a turn paused on the tool-round budget (D-79). Optimistic: clear the
  // card and show working straight away, because the loop picks up at the model
  // call it paused before — there is nothing to replay and nothing to undo.
  const doContinue = useCallback(async (id: string) => {
    dispatch({ t: "patch", id, patch: { pendingStall: null, working: true } });
    try {
      await apiContinue(id);
    } catch (err) {
      dispatch({ t: "patch", id, patch: { notice: (err as Error).message, working: false } });
    }
  }, []);

  // Persistence recovery (D-46): retry the stalled writes, or discard them. The
  // session only leaves `awaiting-persistence` if the retry actually lands, so a
  // still-full disk keeps the banner up (with `retryFailed` set) rather than
  // pretending the records were saved.
  const [retryingPersistence, setRetryingPersistence] = useState(false);
  const resolvePersistence = useCallback(
    async (id: string, opts: { discard?: boolean } = {}) => {
      setRetryingPersistence(true);
      try {
        const state = await apiResolvePersistence(id, opts);
        if (state.recovered !== false || opts.discard) {
          dispatch({ t: "patch", id, patch: { persistenceFault: null } });
        }
        if (opts.discard && state.discarded) {
          dispatch({ t: "patch", id, patch: { notice: `Discarded ${state.discarded} unsaved record(s).` } });
        }
      } catch (err) {
        dispatch({ t: "patch", id, patch: { notice: (err as Error).message } });
      } finally {
        setRetryingPersistence(false);
      }
    },
    [],
  );

  const resolveApproval = useCallback(
    async (
      id: string,
      decision: {
        approve: boolean;
        editedArgs?: Record<string, unknown>;
        addRoot?: boolean | string;
        learned?: LearnAnswers;
      },
    ) => {
      // Anything sitting in the composer rides along with the decision (D-51):
      // the pause is an opening to say something, without the queue's wait.
      const note = (slices[id]?.input ?? "").trim();
      hushSpeech(); // you have answered the thing being read out (X-13)
      dispatch({ t: "patch", id, patch: { pendingApproval: null, working: true, ...(note ? { input: "" } : {}) } });
      try {
        await apiApprove(id, { ...decision, ...(note ? { note } : {}) });
      } catch (err) {
        dispatch({ t: "patch", id, patch: { notice: (err as Error).message, working: false } });
      }
    },
    [slices, hushSpeech],
  );

  // The card is cleared optimistically, so a rejected answer has to put it back
  // — otherwise the question is gone and the session sits awaiting-input with no
  // way to answer it. Only reachable since D-72 gave `answer()` a refusal at all
  // (a blank `required` question), which is what turned this up.
  const submitAnswer = useCallback(async (id: string, answers: AskAnswer[], asked: AskUserRequest) => {
    // Answering is one of the things that stops the reading (D-70e): the pause
    // was read aloud, and you have just dealt with it.
    hushSpeech();
    dispatch({ t: "patch", id, patch: { pendingAsk: null, working: true } });
    try {
      await apiAnswer(id, answers);
    } catch (err) {
      dispatch({ t: "patch", id, patch: { notice: (err as Error).message, working: false, pendingAsk: asked } });
    }
  }, [hushSpeech]);

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

  /**
   * Re-read the session's settled state and believe it over our own copy.
   *
   * The seam for every "my POST didn't land" recovery (X-21/D-57). A failed
   * request leaves the browser holding a guess: it may have been applied with
   * only the reply lost, or never have arrived at all, and the two are
   * indistinguishable from here. So don't reason about it — ask. The server's
   * settled state is the only honest answer, and restoring a *local* copy
   * instead would risk resurrecting a card the session already consumed.
   */
  const resync = useCallback(async (id: string) => {
    try {
      dispatch({ t: "state", id, state: await apiSessionState(id) });
    } catch {
      // The re-sync itself failed — the connection is properly down, and the SSE
      // bus will deliver a fresh roster when it returns. Leave the notice up.
    }
  }, []);

  // Re-attempt the current turn (D-57). Clearing the notice first matters: the
  // error we are retrying is the only thing on screen saying anything is wrong,
  // and leaving it up through a successful retry reads as a second failure.
  const retry = useCallback(
    async (id: string) => {
      dispatch({ t: "patch", id, patch: { notice: null, retryable: false } });
      try {
        await apiRetry(id);
      } catch (err) {
        notify(id, (err as Error).message);
        // We just cleared `retryable` optimistically. If the POST never landed,
        // that clear was a lie and it would take the button away with it.
        await resync(id);
      }
    },
    [notify, resync],
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
  //
  // The button no longer drives `speechSynthesis` itself (H-07): it asks the
  // speaker, and `speakingId` is whatever the speaker last said it was doing —
  // including when a watchdog decided the engine had gone quiet. The old shape
  // set `speakingId` here and cleared it from `onend` alone, which is a state
  // the engine is under no obligation to ever reach.
  const toggleSpeak = useCallback((entryId: string, text: string) => {
    // The click is itself the gesture browsers gate the first utterance on.
    speaker.current.arm();
    if (speaker.current.speaking() === entryId) {
      speaker.current.cancel();
      return;
    }
    speaker.current.speak(entryId, plainText(text));
  }, []);

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

  const rename = useCallback(
    async (id: string, title: string) => {
      try {
        await apiSetTitle(id, title); // the `title` event folds it into the slice
      } catch (err) {
        notify(id, (err as Error).message);
      }
    },
    [notify],
  );

  const openDrawer = useCallback(() => {
    void loadJournal();
    setDrawerOpen(true);
  }, [loadJournal]);

  const sessionList = Object.values(slices);
  const focused = focusedId ? slices[focusedId] : undefined;
  // LIVE and HISTORY are disjoint (X-12): a thread that is open above must not
  // also sit below as a stale copy of itself. Closing a session is what moves it
  // across, which is the whole "it's still recoverable" story told without words.
  const liveConversations = new Set(sessionList.map((s) => s.conversationId).filter((c): c is string => Boolean(c)));
  const pastConversations = history.filter((row) => !liveConversations.has(row.id));

  return (
    <div className="app-shell">
      <SessionRail
        sessions={sessionList}
        focusedId={focusedId}
        connected={connected}
        instance={instance}
        history={pastConversations}
        historyNotice={historyNotice}
        showAllDirs={showAllDirs}
        blipOn={blipOn}
        onToggleBlip={toggleBlip}
        autoReadOn={autoReadOn}
        onToggleAutoRead={toggleAutoRead}
        speaking={speakingId !== null}
        onHushSpeech={hushSpeech}
        peekId={peek?.row.id ?? null}
        onFocus={focus}
        onNew={() => void newSession()}
        onClose={(id) => void closeOne(id)}
        onRename={(id, title) => void rename(id, title)}
        onPeek={openPeek}
        onRenameHistory={(id, title) => void renameHistory(id, title)}
        onDeleteHistory={(id) => void deleteHistory(id)}
        onToggleAllDirs={toggleAllDirs}
        onRefreshHistory={() => void refreshHistory()}
      />
      {peek ? (
        <PeekPane
          key={peek.row.id}
          peek={peek}
          homeDir={instance?.homeDir}
          speakingId={speakingId}
          onSpeak={toggleSpeak}
          onInput={(input) => setPeek((p) => (p ? { ...p, input } : p))}
          onSwitchBranch={(leaf) => setPeek((p) => (p ? { ...p, leaf } : p))}
          onSubmit={() => void promotePeek()}
          onNewThread={() => void newSession()}
          onClose={() => setPeek(null)}
        />
      ) : focused ? (
        <ChatPane
          key={focused.id}
          slice={focused}
          journal={journal}
          drawerOpen={drawerOpen}
          speakingId={speakingId}
          onInput={setInput}
          onSubmit={submit}
          onQueue={queueMsg}
          onSaveTodos={saveTodos}
          onChangeMode={changeMode}
          onChangeTriggerMode={changeTriggerMode}
          onCompact={doCompact}
          onContinue={doContinue}
          onResolvePersistence={resolvePersistence}
          retryingPersistence={retryingPersistence}
          onResolveApproval={resolveApproval}
          onSubmitAnswer={submitAnswer}
          onChangeCap={changeCap}
          onStop={stop}
          onRetry={retry}
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

/** The left rail: **LIVE** (D-43) over **HISTORY** (X-12) — running loops above,
 *  persisted threads below, split by a draggable divider. One rail rather than a
 *  separate drawer because they are the same concept at two temperatures, and
 *  closing a session visibly moves it from one list to the other.
 *
 *  Each section scrolls independently, so a long history can never push the live
 *  cards off screen, and either collapses to its header when the other needs the
 *  room. The divider position persists per browser (X-12 prefs). */
function SessionRail({
  sessions,
  focusedId,
  connected,
  instance,
  history,
  historyNotice,
  showAllDirs,
  blipOn,
  onToggleBlip,
  autoReadOn,
  onToggleAutoRead,
  speaking,
  onHushSpeech,
  peekId,
  onFocus,
  onNew,
  onClose,
  onRename,
  onPeek,
  onRenameHistory,
  onDeleteHistory,
  onToggleAllDirs,
  onRefreshHistory,
}: {
  sessions: SessionSlice[];
  focusedId: string | null;
  connected: boolean;
  instance: InstanceConfig | null;
  history: ConversationRow[];
  historyNotice: string | null;
  showAllDirs: boolean;
  blipOn: boolean;
  onToggleBlip: () => void;
  autoReadOn: boolean;
  onToggleAutoRead: () => void;
  speaking: boolean;
  onHushSpeech: () => void;
  peekId: string | null;
  onFocus: (id: string) => void;
  onNew: () => void;
  onClose: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onPeek: (row: ConversationRow) => void;
  onRenameHistory: (id: string, title: string) => void;
  onDeleteHistory: (id: string) => void;
  onToggleAllDirs: () => void;
  onRefreshHistory: () => void;
}) {
  const [liveOpen, setLiveOpen] = useState(() => readBoolPref("rail.liveOpen", true));
  const [historyOpen, setHistoryOpen] = useState(() => readBoolPref("rail.historyOpen", true));
  const [liveHeight, setLiveHeight] = useState(() => readNumberPref("rail.liveHeight", 240, 80, 900));
  const sectionsRef = useRef<HTMLDivElement>(null);
  const liveListRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  // The divider only appears once the live list is actually capped. Dragging a
  // handle that can't move anything reads as broken, and with two sessions the
  // section shrinks to fit — so there is genuinely nothing to resize until it
  // doesn't. Measured rather than guessed: card heights vary.
  const [liveCapped, setLiveCapped] = useState(false);
  useEffect(() => {
    const el = liveListRef.current;
    setLiveCapped(!!el && el.scrollHeight > el.clientHeight + 1);
  }, [sessions.length, liveHeight, liveOpen, historyOpen]);

  const toggleLive = () => setLiveOpen((v) => (writePref("rail.liveOpen", String(!v)), !v));
  const toggleHistory = () => setHistoryOpen((v) => (writePref("rail.historyOpen", String(!v)), !v));

  // Drag the divider: track on the window so a fast drag that leaves the thin
  // handle keeps working, and clamp so neither section can be dragged away.
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragging.current || !sectionsRef.current) return;
      const top = sectionsRef.current.getBoundingClientRect().top;
      const max = Math.max(80, sectionsRef.current.clientHeight - 120); // leave history a strip
      setLiveHeight(Math.min(max, Math.max(80, e.clientY - top)));
    };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.classList.remove("row-resizing");
      setLiveHeight((h) => (writePref("rail.liveHeight", String(Math.round(h))), h));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  const statusLabel = (s: SessionSlice): string => {
    if (s.persistenceFault) return "can’t save"; // outranks everything (D-46)
    if (s.pendingApproval) return "needs approval";
    if (s.pendingAsk) return "needs answer";
    // A paused turn must never read as a finished one (D-79) — the rail badge is
    // the surface a person actually scans when a session goes quiet, and "idle"
    // there is what made the old silent stop look like the agent's own choice.
    if (s.pendingStall) return "continue?";
    if (s.capReached) return "cap reached";
    if (s.working || s.status === "running") return "working…";
    if (s.tasks.length > 0) return "task running";
    if (s.status === "halted") return "halted";
    // A pause this build has no card for — i.e. the server is newer than this
    // tab (D-80). Never call it `idle`: that is what makes a stopped session
    // look like a finished one, which is the whole of D-79.
    if (isAwaiting(s.status)) return "waiting…";
    return "idle";
  };
  const dotClass = (s: SessionSlice): string => {
    if (s.persistenceFault) return "halt"; // a stalled write stops the session (D-46)
    if (s.pendingApproval || s.pendingAsk || s.pendingStall || s.capReached) return "attn";
    if (isAwaiting(s.status)) return "attn"; // an unrecognized pause is still a pause (D-80)
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
      {/* The workspace this instance serves (X-10): abbreviated to stay readable
          in the narrow rail, full path on hover. Per instance, so it sits with
          the brand rather than on each session card. */}
      {instance?.workingDir ? (
        <div className="rail-workspace" title={instance.workingDir}>
          {abbreviatePath(instance.workingDir, instance.homeDir)}
        </div>
      ) : null}
      <button className="rail-new" onClick={onNew} title="new session">
        + New
      </button>
      <div className="rail-sections" ref={sectionsRef}>
        <section
          className={`rail-section ${liveOpen ? "" : "collapsed"}`}
          /* The drag sets a **cap**, not a fixed height: with two live cards the
             section shrinks to fit and history starts right below, instead of
             holding open a band of empty rail. Past the cap it scrolls. Only
             applies with both open — a collapsed neighbour should yield the rail. */
          style={liveOpen && historyOpen ? { maxHeight: liveHeight, flex: "0 1 auto" } : undefined}
        >
          <button className="rail-section-head" onClick={toggleLive} aria-expanded={liveOpen}>
            <span className="caret">{liveOpen ? "▾" : "▸"}</span>
            <span className="rail-section-title">live</span>
            <span className="rail-count">{sessions.length}</span>
          </button>
          {liveOpen && (
            <div className="rail-list" ref={liveListRef}>
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
                  <RailCardHead session={s} dotClass={dotClass(s)} onClose={onClose} onRename={onRename} />
                  <div className="rail-item-meta">
                    <span className={`rail-status ${dotClass(s)}`}>{statusLabel(s)}</span>
                    <span className="rail-spend">${s.spendUsd.toFixed(4)}</span>
                    <span className="rail-mode">{s.mode}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {liveOpen && historyOpen && liveCapped && (
          <div
            className="rail-divider"
            role="separator"
            aria-orientation="horizontal"
            title="drag to resize"
            onMouseDown={() => {
              dragging.current = true;
              document.body.classList.add("row-resizing");
            }}
          />
        )}

        <section className={`rail-section ${historyOpen ? "" : "collapsed"}`}>
          <button className="rail-section-head" onClick={toggleHistory} aria-expanded={historyOpen}>
            <span className="caret">{historyOpen ? "▾" : "▸"}</span>
            <span className="rail-section-title">history</span>
            <span className="rail-count">{history.length}</span>
          </button>
          {historyOpen && (
            <>
              <div className="rail-list">
                {history.length === 0 && (
                  <div className="rail-empty">{showAllDirs ? "no past conversations" : "none in this folder"}</div>
                )}
                {history.map((row) => (
                  <HistoryRow
                    key={row.id}
                    row={row}
                    active={row.id === peekId}
                    // Only worth showing across projects — in the filtered list
                    // every row has the same dir as the header already states.
                    showDir={showAllDirs}
                    homeDir={instance?.homeDir}
                    onOpen={() => onPeek(row)}
                    onRename={(title) => onRenameHistory(row.id, title)}
                    onDelete={() => onDeleteHistory(row.id)}
                  />
                ))}
              </div>
              {historyNotice && <div className="rail-notice">{historyNotice}</div>}
              <div className="rail-history-foot">
                <label className="all-dirs" title="show conversations from every folder (D-09)">
                  <input type="checkbox" checked={showAllDirs} onChange={onToggleAllDirs} /> all folders
                </label>
                <button className="icon" title="refresh history" onClick={onRefreshHistory}>
                  ⟳
                </button>
              </div>
            </>
          )}
        </section>
      </div>
      {/* NOTIFICATIONS (X-26c). One cluster, at the foot of the rail, deliberately
          *not* a checkbox scattered wherever its feature happens to live — X-13's
          auto-read and X-16's default-open reasoning are both told to add a key
          to `prefs.ts`, and three lone checkboxes in three corners is how a
          settings surface fails to exist. They join here.

          The two sound toggles read as a pair on purpose, quiet above loud: the
          blip says *look over here*, auto-read says *here is what it said*. They
          divide the sessions between them — a background session chirps, the one
          in front of you speaks — so ticking both is coherent rather than
          doubled. */}
      <div className="rail-notify">
        <div className="rail-notify-title">notifications</div>
        <label title="play a short tone when a session settles and you are looking elsewhere (X-26)">
          <input type="checkbox" checked={blipOn} onChange={onToggleBlip} /> blip on attention
        </label>
        <label title="read the reply out loud when the session in view hands the turn back (X-13)">
          <input type="checkbox" checked={autoReadOn} onChange={onToggleAutoRead} /> read replies aloud
        </label>
        {/* Only while something is actually being read. A reply lights up its own
            message's ◼, but a question or an approval has no message to light —
            and that is exactly when you most want a stop button you can find
            without hunting. */}
        {speaking ? (
          <button className="rail-hush" title="stop reading" onClick={onHushSpeech}>
            ◼ reading aloud
          </button>
        ) : null}
      </div>
    </aside>
  );
}

/** One persisted thread in the rail's history section (X-12). Clicking peeks; the
 *  ✎ and ✕ (X-12b) are the two writes a past thread accepts. The label is the
 *  X-09 title when there is one — older logs stay untitled and fall back to their
 *  short id, which is also why the confirm below names the thread the same way. */
function HistoryRow({
  row,
  active,
  showDir,
  homeDir,
  onOpen,
  onRename,
  onDelete,
}: {
  row: ConversationRow;
  active: boolean;
  showDir: boolean;
  homeDir?: string;
  onOpen: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState(false);
  const label = row.title || row.id.slice(0, 12);

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDraft(row.title ?? "");
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== row.title) onRename(next);
  };

  if (editing) {
    return (
      <div className="rail-item history" onClick={(e) => e.stopPropagation()}>
        <input
          className="rail-rename"
          value={draft}
          autoFocus
          spellCheck={false}
          placeholder="name this thread"
          onFocus={(e) => e.target.select()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
        />
      </div>
    );
  }

  // Confirm in the row rather than in a browser dialog: it names the thread (a
  // bare id makes for a reflexive confirm), and it keeps the decision where the
  // thing being deleted is, so you can still read the row you are acting on.
  if (confirming) {
    return (
      <div className="rail-item history confirming" onClick={(e) => e.stopPropagation()}>
        <div className="rail-confirm-text">
          Delete “{label}”? It leaves the list, but stays on disk.
        </div>
        <div className="rail-confirm-actions">
          <button
            className="danger"
            onClick={() => {
              setConfirming(false);
              onDelete();
            }}
          >
            Delete
          </button>
          <button className="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`rail-item history ${active ? "focused" : ""}`}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      title={row.title ? `${row.title} — ${row.workingDir}` : row.workingDir}
    >
      <div className="rail-item-top">
        <span className="rail-model">{label}</span>
        <button className="rail-icon" title="rename this thread" onClick={startEdit}>
          ✎
        </button>
        {/* Not offered on the row you are reading: deleting the thread open in
            the pane would pull it out from under you. Close the peek first. */}
        {!active && (
          <button
            className="rail-close"
            title="remove from history (the log stays on disk)"
            onClick={(e) => {
              e.stopPropagation();
              setConfirming(true);
            }}
          >
            ✕
          </button>
        )}
      </div>
      <div className="rail-item-meta">
        <span className="rail-when">{formatWhen(row.createdAt)}</span>
        {showDir && <span className="rail-dir">{folderName(abbreviatePath(row.workingDir, homeDir))}</span>}
      </div>
    </div>
  );
}

/** History timestamps, at the resolution you actually scan by: a time today, a
 *  weekday this week, a date beyond that. Falls back to the raw string rather
 *  than rendering "Invalid Date" for a row whose `createdAt` never got written. */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || "—";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const days = (now.getTime() - d.getTime()) / 86_400_000;
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "short" }) + " " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** A rail card's top line: status dot, the thread's label (X-09) — auto-titled
 *  after the first exchange, falling back to the model until then — with a
 *  pencil to rename in place, and the close button. A hand-edited label pins:
 *  the auto-title only ever runs when there is none. */
function RailCardHead({
  session,
  dotClass,
  onClose,
  onRename,
}: {
  session: SessionSlice;
  dotClass: string;
  onClose: (id: string) => void;
  onRename: (id: string, title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const label = session.title || session.model || "session";

  const start = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDraft(session.title ?? "");
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== session.title) onRename(session.id, next);
  };

  if (editing) {
    return (
      <div className="rail-item-top" onClick={(e) => e.stopPropagation()}>
        <input
          className="rail-rename"
          value={draft}
          autoFocus
          spellCheck={false}
          placeholder="name this thread"
          // Pre-selected: typing replaces the old name (renaming is the common
          // case), clicking still puts the caret where you clicked to edit it.
          onFocus={(e) => e.target.select()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
        />
      </div>
    );
  }
  return (
    <div className="rail-item-top">
      <span className={`sdot ${dotClass}`} />
      <span className="rail-model" title={session.title ? `${session.title} — ${session.model}` : session.model}>
        {label}
      </span>
      <button className="rail-icon" title="rename this thread" onClick={start}>
        ✎
      </button>
      <button
        className="rail-close"
        title="close session (stops it)"
        onClick={(e) => {
          e.stopPropagation();
          onClose(session.id);
        }}
      >
        ✕
      </button>
    </div>
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
  onSaveTodos,
  onChangeMode,
  onChangeTriggerMode,
  onCompact,
  onContinue,
  onResolvePersistence,
  retryingPersistence,
  onResolveApproval,
  onSubmitAnswer,
  onChangeCap,
  onStop,
  onRetry,
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
  onSaveTodos: (id: string, items: { id?: string; text: string; done: boolean; note?: string }[]) => void;
  onChangeMode: (id: string, patch: { mode?: Mode; approval?: ApprovalPolicy }) => void;
  onChangeTriggerMode: (id: string, mode: TriggerMode) => void;
  onCompact: (id: string, opts?: { skip?: boolean }) => void;
  onContinue: (id: string) => void;
  onResolvePersistence: (id: string, opts?: { discard?: boolean }) => void;
  retryingPersistence: boolean;
  onResolveApproval: (
    id: string,
    d: { approve: boolean; editedArgs?: Record<string, unknown>; addRoot?: boolean | string; learned?: LearnAnswers },
  ) => void;
  onSubmitAnswer: (id: string, answers: AskAnswer[], asked: AskUserRequest) => void;
  onChangeCap: (id: string, v: number | null) => void;
  onStop: (id: string, scope: "hard" | "soft") => void;
  onRetry: (id: string) => void;
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

  // "It looks hung" (D-57): a running turn that has emitted nothing for a long
  // stretch. Tick only while working — when the stream is healthy the tokens
  // themselves re-render us, and when it really is wedged a 2s tick costs
  // nothing. Gating the button on silence is the point: it can't be fat-fingered
  // into throwing away a stream that is busy answering.
  const [quietSince, setQuietSince] = useState(0);
  useEffect(() => {
    if (!slice.working) return setQuietSince(0);
    const t = setInterval(() => setQuietSince(Date.now() - slice.lastEventAt), 2000);
    return () => clearInterval(t);
  }, [slice.working, slice.lastEventAt]);
  const looksHung = slice.working && quietSince > HUNG_AFTER_MS;

  const path = pathToLeaf(slice.entries, slice.activeLeaf);
  // Tool results render in flow (X-11), between the turn that called them and the
  // turn that reasons about them — the approval card is gone by then, so this is
  // where you check the model's work. Silent assistant turns (a bare tool call)
  // still don't draw a bubble; their tool block carries the story.
  const rendered = path.filter(
    (e) =>
      e.type === "user" ||
      e.type === "tool" ||
      (e.type === "assistant" && (e.text || e.reasoningText)) ||
      (e.type === "todo" && e.by === "user"),
  );
  // Arguments live on the calling assistant entry, results on the tool entry;
  // `toolCallId` is the join.
  const argsByCall = new Map<string, string>();
  for (const e of path) {
    if (e.type !== "assistant") continue;
    for (const call of e.toolCalls ?? []) if (call.id) argsByCall.set(call.id, call.arguments);
  }

  // ---- Following the tail without stealing it (D-71, `scroll.ts`) ----------
  //
  // The state lives in a ref *and* in React state: the ref so the scroll
  // listener (which fires far more often than we want to render) can fold
  // against the current value without being re-created, the state so the jump
  // button re-renders. `stepFollow` returns the same object when nothing moved,
  // which is what keeps a stream of scroll events from re-rendering the pane.
  const followRef = useRef<FollowState>(newFollow());
  const [follow, setFollow] = useState<FollowState>(followRef.current);
  const applyFollow = useCallback((ev: FollowEvent) => {
    const next = stepFollow(followRef.current, ev);
    if (next !== followRef.current) {
      followRef.current = next;
      setFollow(next);
    }
    return next;
  }, []);
  const toBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
  }, []);

  // What the last commit was looking at. The leaf is the discriminator that
  // matters — and it is a **trap**: `activeLeaf` moves on every appended entry
  // (`reduceEvent` walks the tip forward whenever `entry.parent === activeLeaf`),
  // so reading a changed leaf as a changed *view* re-pins on every message. That
  // is the original defect wearing a new hat, and the first peek of this fix
  // caught it doing exactly that.
  const renderedCount = rendered.length;
  const onPath = new Set(path.map((e) => e.id));
  const viewRef = useRef<{ session: string; leaf: string | null; count: number }>({ session: id, leaf: null, count: 0 });

  // Everything that grows or replaces the thread: entries, stream tokens, and
  // the cards that appear below it. While pinned we ride the tail; while the
  // reader is elsewhere we only count, and a user turn re-pins wherever they were.
  useEffect(() => {
    const prev = viewRef.current;
    // A different session, or a leaf that has *left* the branch we now render, is
    // a different view: a branch switch (H-05), a session swap, a resumed thread
    // that renders at once. The tip merely advancing is not — that is new content
    // on the branch you were already reading.
    const switchedView = isViewSwitch(prev, { session: id, onPath });
    const added = Math.max(0, renderedCount - prev.count);
    const fromUser = added > 0 && rendered.slice(renderedCount - added).some((e) => e.type === "user");
    viewRef.current = { session: id, leaf: slice.activeLeaf, count: renderedCount };
    const next = switchedView ? applyFollow({ kind: "reset" }) : applyFollow({ kind: "content", added, fromUser });
    if (next.pinned) toBottom();
    // The render-scoped values above are read, not watched: this fires on the
    // things that move the thread and uses whatever came with them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, slice.entries, slice.activeLeaf, slice.live, slice.working, slice.pendingApproval, slice.pendingAsk, slice.pendingCompaction]);

  // Re-pinning is only half an answer — the view has to actually go there, after
  // the render that removed the jump button (which is itself in the scroll box).
  useEffect(() => {
    if (follow.pinned) toBottom();
  }, [follow.pinned, toBottom]);

  // Sending re-pins immediately rather than waiting for the turn to come back:
  // the message you just typed is the one you want to watch, and the entry that
  // proves it lands a round trip later. (`content`'s `fromUser` covers the same
  // ground for a turn typed in another tab.)
  const sendHere = useCallback(() => {
    applyFollow({ kind: "sent" });
    onSubmit(id);
  }, [applyFollow, onSubmit, id]);
  const queueHere = useCallback(() => {
    applyFollow({ kind: "sent" });
    onQueue(id);
  }, [applyFollow, onQueue, id]);

  const onThreadScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    applyFollow({
      kind: "scrolled",
      metrics: { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight },
    });
  }, [applyFollow]);

  // "Busy" = the agent can't take a fresh Send right now: the LLM is thinking, a
  // background command is running, or a prompt is open. While busy, the composer
  // queues (D-34) instead of sending.
  const blocked =
    slice.working ||
    slice.tasks.length > 0 ||
    slice.pendingApproval !== null ||
    slice.pendingAsk !== null ||
    slice.pendingCompaction !== null ||
    // A stalled write stops everything until it is retried or discarded (D-46).
    slice.persistenceFault !== null;

  return (
    <div className="pane">
      <header className="topbar">
        {/* Elided from the *front* when it doesn't fit (D-71): the vendor is what
            you can infer, and `:online` — the part you can't — lives at the end.
            The `title` always carries the id whole. */}
        <span className="pane-model" title={slice.model}>
          {fitModelLabel(slice.model) || "session"}
        </span>
        <div className="controls">
          <button className="ghost" title="debug journal (D-15)" onClick={onOpenDrawer}>
            journal
          </button>
          <McpButton />
          <ContextMeter
            tokens={slice.contextTokens}
            window={slice.contextWindow}
            threshold={slice.contextThreshold}
            source={slice.contextWindowSource}
          />
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

      <div className="thread" ref={scrollRef} onScroll={onThreadScroll}>
        {rendered.length === 0 && !slice.live && !slice.pendingApproval && !slice.pendingAsk && (
          <div className="empty">Say something to get started.</div>
        )}
        {rendered.map((entry) => {
          if (entry.type === "todo") {
            // Only the user's edits reach here (see the filter): an agent write
            // is already visible as its `todo_write` tool block, and marking it
            // twice would make striking six items look like twelve events.
            return (
              <div className="todo-mark" key={entry.id}>
                you edited the todo list
              </div>
            );
          }
          if (entry.type === "tool") {
            return <ToolBlock key={entry.id} entry={entry} args={entry.toolCallId ? argsByCall.get(entry.toolCallId) : undefined} />;
          }
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
              speakingId={speakingId}
              onSpeak={onSpeak}
            />
          );
        })}
        {/* Only on the branch the turn is pinned to (H-05) — navigating away
            mid-turn must not make the stream look like it grows on the sibling
            you switched to. */}
        {slice.live && slice.activeLeaf === slice.liveParent && <LiveMessage live={slice.live} />}
        {slice.working && <div className="working">{workWord}</div>}
        {slice.tasks.length > 0 && <TasksPanel tasks={slice.tasks} onKill={(taskId) => onKillTask(id, taskId)} />}
        {slice.pendingApproval && <ApprovalCard request={slice.pendingApproval} onResolve={(d) => onResolveApproval(id, d)} />}
        {slice.pendingAsk && <AskForm request={slice.pendingAsk} onSubmit={(answers) => onSubmitAnswer(id, answers, slice.pendingAsk!)} />}
        {/* Persistence fault outranks the other cards: nothing else can proceed
            until the disk problem is resolved (D-46). */}
        {slice.persistenceFault && (
          <PersistenceCard
            fault={slice.persistenceFault}
            busy={retryingPersistence}
            onRetry={() => onResolvePersistence(id)}
            onDiscard={() => onResolvePersistence(id, { discard: true })}
          />
        )}
        {slice.pendingCompaction && (
          <CompactionCard
            request={slice.pendingCompaction}
            onCompact={() => onCompact(id)}
            onSkip={() => onCompact(id, { skip: true })}
            windowSource={slice.contextWindowSource}
          />
        )}
        {slice.pendingStall && <StallCard request={slice.pendingStall} onContinue={() => onContinue(id)} />}
        {/* suggest mode: non-blocking nudge once the budget is crossed (D-27). */}
        {slice.triggerMode === "suggest" && slice.needsCompaction && !slice.pendingCompaction && (
          <CompactionBanner
            onCompact={() => onCompact(id)}
            window={slice.contextWindow}
            windowSource={slice.contextWindowSource}
          />
        )}
        {slice.capReached && <CapBanner spendUsd={slice.spendUsd} capUsd={slice.capUsd} onRaise={(v) => onChangeCap(id, v)} />}
        {/* A request that has gone quiet (D-57). Offered only after real silence,
            and it abandons just the model request — tasks and queue keep going. */}
        {looksHung && (
          <div className="notice hung">
            <span>No response for {Math.round(quietSince / 1000)}s. The request may be stuck.</span>
            <button className="ghost" onClick={() => onRetry(id)} title="abandon this request and send it again">
              ↻ Retry
            </button>
          </div>
        )}
        {/* `retryable` without a notice is a *reloaded* tab: the failure arrived
            as a live event this page never saw, but the settled state still says
            the turn is re-sendable. Offer it anyway with a generic line — the
            button is the point, and losing it to an F5 would be its own bug. */}
        {(slice.notice || slice.retryable) && (
          <div className="notice">
            <span>{slice.notice ?? "The last turn failed before it was answered."}</span>
            {/* Nothing was written, so this re-sends the same prefix — the fix
                for "I topped up my credits, now what?" (D-57). */}
            {slice.retryable && (
              <button className="ghost" onClick={() => onRetry(id)} title="send this turn again">
                ↻ Retry
              </button>
            )}
          </div>
        )}
        {/* The way back (D-71). Sticky *inside* the scroll box, so it rides the
            bottom edge of whatever you are reading rather than needing a new
            positioned wrapper around the transcript. Present only while the tail
            is not being followed — when it is, the latest is what you're looking
            at and a button saying so would be noise. */}
        {!follow.pinned && (
          <button
            className="jump-latest"
            onClick={() => {
              applyFollow({ kind: "jumped" });
              toBottom();
            }}
            title="follow the newest message again"
          >
            ↓ {follow.unseen > 0 ? <span className="jump-count">{follow.unseen} new</span> : "latest"}
          </button>
        )}
      </div>

      {/* The shared todo list (X-31), pinned between the thread and the composer
          so it stays put while you scroll back through the transcript. */}
      <TodoPanel items={slice.todos} onSave={(items) => onSaveTodos(id, items)} />

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
            slice.pendingApproval
              ? "Say something with your decision — it goes in with Approve/Deny…  (Enter queues it for later instead)"
              : slice.pendingAsk
                ? "Respond to the agent above…"
                  : blocked
                    ? "Queue a message for the next turn…  (Enter to queue)"
                    : "Message JLCode…  (Enter to send, Shift+Enter for newline)"
          }
          onChange={(e) => onInput(id, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (blocked) queueHere();
              else sendHere();
            }
          }}
          rows={2}
        />
        {blocked ? (
          <button onClick={queueHere} disabled={!slice.input.trim()}>
            Queue
          </button>
        ) : (
          <button onClick={sendHere} disabled={!slice.input.trim()}>
            Send
          </button>
        )}
      </footer>

      {drawerOpen && <JournalDrawer records={journal} entries={slice.entries} onClose={onCloseDrawer} onRefresh={onLoadJournal} />}
    </div>
  );
}

/** A past conversation, read from disk, rendered over the main pane (X-12).
 *
 *  Deliberately not a session: opening this creates no `Session`, no rail card,
 *  and no log record — the rail is untouched and a running turn keeps streaming
 *  behind it. The composer is simply present, and **typing in it is the
 *  promotion**: the first message materializes the session server-side. That is
 *  why there is no "Continue here" button; the thing you'd click it to get is
 *  the thing you already did.
 *
 *  Branch arrows move a *local* leaf — a peek writes nothing, not even an
 *  `active-leaf` record — and that leaf is what the first message continues
 *  from, so the branch you are looking at is the branch you resume. */
function PeekPane({
  peek,
  homeDir,
  speakingId,
  onSpeak,
  onInput,
  onSwitchBranch,
  onSubmit,
  onNewThread,
  onClose,
}: {
  peek: PeekState;
  homeDir?: string;
  speakingId: string | null;
  onSpeak: (entryId: string, text: string) => void;
  onInput: (text: string) => void;
  onSwitchBranch: (leaf: string) => void;
  onSubmit: () => void;
  onNewThread: () => void;
  onClose: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [journal, setJournal] = useState<JournalRecord[]>([]);
  const entries = peek.conv?.entries ?? [];

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [peek.conv, peek.leaf]);

  const loadJournal = useCallback(() => {
    void fetchJournal(peek.row.id).then(setJournal).catch(() => {});
  }, [peek.row.id]);

  const path = pathToLeaf(entries, peek.leaf);
  const rendered = path.filter(
    (e) => e.type === "user" || e.type === "tool" || (e.type === "assistant" && (e.text || e.reasoningText)),
  );
  const argsByCall = new Map<string, string>();
  for (const e of path) {
    if (e.type !== "assistant") continue;
    for (const call of e.toolCalls ?? []) if (call.id) argsByCall.set(call.id, call.arguments);
  }

  return (
    <div className="pane peek">
      <header className="topbar">
        <span className="peek-badge" title="read-only — nothing is running">
          history
        </span>
        <span className="pane-model" title={peek.row.workingDir}>
          {peek.row.title || peek.row.id.slice(0, 12)}
        </span>
        <div className="controls">
          <span className="peek-dir" title={peek.row.workingDir}>
            {abbreviatePath(peek.row.workingDir, homeDir)}
          </span>
          <button className="ghost" onClick={onClose} title="back to the live session">
            ✕ close
          </button>
        </div>
      </header>

      <div className="thread" ref={scrollRef}>
        {!peek.conv && !peek.error && <div className="empty">loading…</div>}
        {peek.conv && rendered.length === 0 && <div className="empty">This thread is empty.</div>}
        {rendered.map((entry) => {
          if (entry.type === "tool") {
            return <ToolBlock key={entry.id} entry={entry} args={entry.toolCallId ? argsByCall.get(entry.toolCallId) : undefined} />;
          }
          const siblings = childrenOf(entries, entry.parent);
          const branch =
            siblings.length > 1
              ? { index: siblings.findIndex((s) => s.id === entry.id), count: siblings.length, siblings }
              : null;
          return (
            <Message
              key={entry.id}
              entry={entry}
              branch={branch}
              // Local view move only — no session exists to rewind (X-12).
              onSwitch={(siblingId) => onSwitchBranch(leafOf(entries, siblingId))}
              // Edit-forking is a write, and a peek has nothing to write into;
              // the pencil is suppressed rather than left to fail.
              readOnly
              onEdit={() => {}}
              journal={journal.filter((r) => r.entryId === entry.id)}
              onNeedJournal={loadJournal}
              speakingId={speakingId}
              onSpeak={onSpeak}
            />
          );
        })}
        {peek.unrecoverable ? (
          <div className="notice unrecoverable">
            <strong>This thread can’t be resumed.</strong> It was recorded before the 2026-07-28 fix
            (H-04) and its stored reasoning is fragmented, which the model rejects on replay. The log
            is append-only, so nothing can repair it in place — you can still read it here.
            <button className="primary" onClick={onNewThread}>
              Start a fresh thread
            </button>
          </div>
        ) : peek.error ? (
          <div className="notice">{peek.error}</div>
        ) : null}
      </div>

      <footer className="composer">
        <textarea
          value={peek.input}
          placeholder="Continue this thread…  (sending picks it up where you’re looking)"
          onChange={(e) => onInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          rows={2}
          disabled={peek.unrecoverable}
        />
        <button onClick={onSubmit} disabled={!peek.input.trim() || peek.sending || peek.unrecoverable}>
          {peek.sending ? "…" : "Send"}
        </button>
      </footer>
    </div>
  );
}

/** How full the context window is, continuously (X-24).
 *
 *  The number is the same ground truth the compaction trigger runs on — the last
 *  turn's `prompt + completion` (D-44) — so it is **one round trip stale by
 *  construction**: it steps when a turn lands and does not creep while the model
 *  is thinking. That is deliberate (there is no tokenizer, and an estimate that
 *  disagreed with the trigger would be worse than a stale exact figure), but it
 *  has to be said out loud or it reads as a stuck widget, so the tooltip says it.
 *
 *  The percentage is of the **raw window**; the compaction threshold
 *  (`window − buffer`) is drawn as a mark on the bar rather than being what the
 *  percentage is *of* — X-24 left the choice open, and showing both is what makes
 *  "how full" and "when will it compact" separately legible. Past the mark the
 *  bar goes warm, which is the same moment the suggest banner / pause appears.
 *
 *  Two honest empty states, never a confident 0%: no window known at all renders
 *  `—`, and a window we had to guess at (`source: "fallback"`, H-06) is marked
 *  with `~`. A meter reading 0% because nothing was configured is worse than no
 *  meter — that is precisely how H-06 hid for a month. */
function ContextMeter({
  tokens,
  window: contextWindow,
  threshold,
  source,
}: {
  tokens: number;
  window: number | null;
  threshold: number | null;
  source: SessionSlice["contextWindowSource"];
}) {
  // No window → nothing to be a percentage of. Say so instead of drawing a bar.
  if (!contextWindow) {
    return (
      <div className="ctx" title="No context window is known for this model, so context usage can't be measured.">
        <span className="ctx-pct">ctx —</span>
      </div>
    );
  }
  // 0 = not measured yet (fresh branch, or just compacted): the real figure is
  // small but unknown, so show the empty bar with a dash rather than "0%".
  const measured = tokens > 0;
  const pct = Math.min(100, Math.round((tokens / contextWindow) * 100));
  const markPct = threshold ? Math.min(100, (threshold / contextWindow) * 100) : null;
  const over = threshold !== null && tokens > threshold;
  const assumed = source === "fallback";
  const title = [
    measured
      ? `context: ${tokens.toLocaleString()} of ${contextWindow.toLocaleString()} tokens (${pct}%)`
      : `context: not measured yet — the reading arrives when the next turn lands (window ${contextWindow.toLocaleString()} tokens)`,
    threshold ? `compacts above ${threshold.toLocaleString()} (the mark)` : null,
    "measured from the last turn's actual usage, so it steps once per round trip",
    assumed ? "⚠ this model isn't in the OpenRouter catalog — the window is an assumed default" : null,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <div className={`ctx ${over ? "over" : ""}`} title={title}>
      <div className="ctx-bar">
        <div className="ctx-fill" style={{ width: `${measured ? pct : 0}%` }} />
        {markPct !== null && <div className="ctx-mark" style={{ left: `${markPct}%` }} />}
      </div>
      <span className="ctx-pct">
        {assumed ? "~" : ""}
        {measured ? `${pct}%` : "—"}
      </span>
    </div>
  );
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
/**
 * The shared todo list (X-31) — the person's half of it.
 *
 * Two states, deliberately: **viewing** shows what the list says, **editing**
 * hands the whole list over as fields. Leaving edit mode is the commit, and the
 * only commit — which is what makes "the user changed it" a single event the
 * agent can be told about once, at a turn boundary, rather than a keystroke
 * stream nobody can act on.
 *
 * An item may carry a **note** — the outcome the agent recorded when it struck
 * the item (D-77). It shows under the text here, and is editable like the text,
 * but it is not a second list: leaving it alone is the normal case.
 *
 * A draft is local until saved, so the agent striking an item mid-edit cannot
 * yank a row out from under a cursor. The flip side is that saving replaces
 * what the agent wrote in the meantime, so when that happens the panel says so
 * out loud rather than letting the clobber be silent — the same principle as
 * the agent's own read barrier, pointed the other way.
 */
function TodoPanel({
  items,
  onSave,
}: {
  items: TodoItem[];
  onSave: (items: { id?: string; text: string; done: boolean; note?: string }[]) => void;
}) {
  const [open, setOpen] = useState(() => readBoolPref("todo.open", false));
  const [draft, setDraft] = useState<{ id?: string; text: string; done: boolean; note?: string }[] | null>(null);
  // What the list said when editing began — the comparison that spots an agent
  // write landing underneath the draft.
  const [base, setBase] = useState<TodoItem[]>([]);
  const editing = draft !== null;
  const undone = items.filter((i) => !i.done).length;
  const changedUnderneath =
    editing &&
    (items.length !== base.length ||
      items.some(
        (i, n) =>
          base[n]?.id !== i.id || base[n]?.text !== i.text || base[n]?.done !== i.done || (base[n]?.note ?? "") !== (i.note ?? ""),
      ));

  const toggle = () => {
    const next = !open;
    setOpen(next);
    writePref("todo.open", String(next));
    if (!next) setDraft(null); // collapsing abandons an untouched draft
  };
  const startEdit = () => {
    setBase(items);
    setDraft(items.map((i) => ({ id: i.id, text: i.text, done: i.done, note: i.note })));
  };
  const patch = (n: number, row: Partial<{ text: string; done: boolean; note: string }>) =>
    setDraft((d) => (d ? d.map((r, i) => (i === n ? { ...r, ...row } : r)) : d));

  if (items.length === 0 && !editing) {
    return (
      <div className="todo-bar empty">
        <span className="todo-label">todo</span>
        <span className="todo-census">no items</span>
        {/* Straight into a row with the cursor in it: "start a list" that hands
            you an empty editor and one more button to press is a step nobody
            wanted. */}
        <button className="ghost" onClick={() => setDraft([{ text: "", done: false }])}>
          start a list
        </button>
      </div>
    );
  }

  return (
    <div className={`todo-panel ${open || editing ? "open" : ""}`}>
      <div className="todo-bar">
        <button className="todo-toggle" onClick={toggle} aria-expanded={open || editing} title="the list you share with the agent">
          <span className="caret">{open || editing ? "▾" : "▸"}</span>
          <span className="todo-label">todo</span>
          <span className="todo-census">
            {undone} of {items.length} undone
          </span>
        </button>
        {(open || editing) &&
          (editing ? (
            <span className="todo-actions">
              <button className="primary" onClick={() => { onSave(draft!.filter((r) => r.text.trim() !== "")); setDraft(null); }}>
                Save
              </button>
              <button onClick={() => setDraft(null)}>Cancel</button>
            </span>
          ) : (
            <span className="todo-actions">
              <button className="ghost" onClick={startEdit}>
                edit
              </button>
            </span>
          ))}
      </div>
      {(open || editing) && (
        <div className="todo-items">
          {changedUnderneath && (
            <div className="todo-note">⚠ the agent changed the list while you were editing — Save replaces it, Cancel shows theirs.</div>
          )}
          {editing
            ? draft!.map((row, n) => (
                <div className="todo-item editing" key={row.id ?? `new-${n}`}>
                  <input type="checkbox" checked={row.done} onChange={(e) => patch(n, { done: e.target.checked })} />
                  <span className="todo-body">
                    <input
                      className="todo-text"
                      value={row.text}
                      spellCheck={false}
                      autoFocus={n === draft!.length - 1 && row.text === ""}
                      onChange={(e) => patch(n, { text: e.target.value })}
                    />
                    {/* The note field appears only where there is a note to show
                        or you asked for one — a second box on every row turns a
                        ten-item list into a wall. Emptying it clears the note. */}
                    {row.note !== undefined && (
                      <span className="todo-note-row">
                        {/* The same ↳ the view mode draws, so a note field never
                            reads as a second item. */}
                        <span className="todo-note-lead">↳</span>
                        <input
                          className="todo-text todo-note-input"
                          value={row.note}
                          placeholder="note — e.g. done, commit 6173b82"
                          spellCheck={false}
                          autoFocus={row.note === ""}
                          onChange={(e) => patch(n, { note: e.target.value })}
                        />
                      </span>
                    )}
                  </span>
                  {row.note === undefined && (
                    <button className="icon" title="add a note" onClick={() => patch(n, { note: "" })}>
                      ✎
                    </button>
                  )}
                  <button className="icon" title="remove" onClick={() => setDraft((d) => (d ? d.filter((_, i) => i !== n) : d))}>
                    ✕
                  </button>
                </div>
              ))
            : items.map((item) => (
                <div className={`todo-item ${item.done ? "done" : ""}`} key={item.id}>
                  <span className="todo-box">{item.done ? "☑" : "☐"}</span>
                  <span className="todo-body">
                    <span className="todo-text">{item.text}</span>
                    {item.note && <span className="todo-item-note">↳ {item.note}</span>}
                  </span>
                </div>
              ))}
          {editing && (
            <button className="ghost todo-add" onClick={() => setDraft((d) => [...(d ?? []), { text: "", done: false }])}>
              + item
            </button>
          )}
        </div>
      )}
    </div>
  );
}

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
/** The tool-round budget ran out (D-79). Deliberately *not* phrased as a failure:
 *  the common case is a long piece of work that is going fine, so the card asks
 *  rather than accuses, and says in as many words that nothing was lost — the
 *  bug it replaces silently dropped the pending tool call, which is exactly the
 *  way for work to look done without having happened. */
function StallCard({ request, onContinue }: { request: StallRequest; onContinue: () => void }) {
  return (
    <div className="card cap-banner">
      <div className="fence-note">
        ⏸ {request.rounds} model {request.rounds === 1 ? "turn" : "turns"} on this message without finishing — pausing
        to ask whether it is still getting somewhere. Nothing was lost: every tool call has run, and Continue picks up
        at the next model call.
      </div>
      <div className="actions">
        <button className="primary" onClick={onContinue}>
          Continue (budget → {request.nextBudget})
        </button>
      </div>
    </div>
  );
}

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
/** The blocking persistence-fault banner (D-46). A record could not be written,
 *  so everything stopped: this is the recoverable case — free the disk, hit
 *  Retry, and the stalled records land in order. Discarding is offered too, but
 *  never as the quiet default: it is the only path that loses data. */
function PersistenceCard({
  fault,
  busy,
  onRetry,
  onDiscard,
}: {
  fault: PersistenceFault;
  busy: boolean;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const file = fault.filePath.split("/").pop() ?? fault.filePath;
  // Node errors carry the full path ("EACCES: permission denied, open '/very/long/…'"),
  // which we already show as the filename above — drop it so the banner stays legible.
  const reason = fault.message.replace(/,\s*(open|write|mkdir)\s+'.*'\s*$/, "");
  return (
    <div className="card persistence-card">
      <div className="card-head">
        <span className="tool">⚠ can’t save this conversation</span>
        <span className="reason">{fault.retryFailed ? "retry failed" : "stopped"}</span>
      </div>
      <div className="fence-note">
        Writing to <code title={fault.filePath}>{file}</code> failed: <strong>{reason}</strong>
        {". "}
        {fault.pending === 1 ? "1 record is" : `${fault.pending} records are`} queued and unwritten, so the agent
        stopped rather than carry on with a conversation that wouldn’t survive a restart. Free up disk space (or fix
        the permissions), then retry — the queued records are written in order.
      </div>
      <div className="actions">
        <button className="primary" onClick={onRetry} disabled={busy}>
          {busy ? "Retrying…" : "Retry save"}
        </button>
        {confirmDiscard ? (
          <button className="danger" onClick={onDiscard} disabled={busy} title="permanently drop the unwritten records">
            Really discard {fault.pending}?
          </button>
        ) : (
          <button
            onClick={() => setConfirmDiscard(true)}
            disabled={busy}
            title="give up on the unwritten records and continue"
          >
            Continue without saving…
          </button>
        )}
      </div>
    </div>
  );
}

/** Name the window we are measuring against — and admit when it is a guess.
 *  A window nobody states is how H-06 went unnoticed for a month; a *wrong*
 *  window stated confidently would be the same bug wearing a number. */
function WindowNote({ source }: { source: SessionSlice["contextWindowSource"] }) {
  if (source !== "fallback") return null;
  return (
    <div className="fence-note window-assumed">
      ⚠ This model isn't in the OpenRouter catalog, so the window above is an assumed default. Set{" "}
      <code>compaction.contextLength</code> for this config (or <code>jlcode config set &lt;name&gt;
      --context-length &lt;n&gt;</code>) to measure against the real one.
    </div>
  );
}

function CompactionCard({
  request,
  onCompact,
  onSkip,
  windowSource,
}: {
  request: CompactionRequest;
  onCompact: () => void;
  onSkip: () => void;
  windowSource: SessionSlice["contextWindowSource"];
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
      <WindowNote source={windowSource} />
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
function CompactionBanner({
  onCompact,
  window,
  windowSource,
}: {
  onCompact: () => void;
  window: number | null;
  windowSource: SessionSlice["contextWindowSource"];
}) {
  return (
    <div className="card compaction-banner">
      <div className="fence-note">
        ◆ Context is getting large — compacting will keep replies fast and in-window.
        {window ? ` (window ${window.toLocaleString()} tokens)` : ""}
      </div>
      <WindowNote source={windowSource} />
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
  readOnly = false,
  journal,
  onNeedJournal,
  speakingId,
  onSpeak,
}: {
  entry: EntryView;
  branch: BranchNav | null;
  onSwitch: (siblingId: string) => void;
  onEdit: (entryId: string, text: string) => void;
  /** A history peek (X-12): reading and branch-walking work, but edit-forking is
   *  a write with no session to write into, so the pencil is not offered. */
  readOnly?: boolean;
  journal: JournalRecord[];
  onNeedJournal: () => void;
  /** The whole speaker key, not a boolean: a turn has **two** things that can be
   *  read — the reply and the planning above it — and they light up separately. */
  speakingId: string | null;
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
            {!readOnly && (
              <button className="icon" title="edit & fork" onClick={() => { setDraft(entry.text ?? ""); setEditing(true); }}>
                ✎
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // assistant
  //
  // Two readable things, and until now one dead button (Joshua, 2026-09-03). A
  // tool-calling turn often has *only* reasoning — it is rendered, so it got a
  // 🔊 that spoke `entry.text`, which is `""`. The speaker correctly refuses to
  // say nothing, so the click did nothing at all, which from the outside is
  // indistinguishable from a jam. Now the reply's button appears only when there
  // is a reply, and the planning has its own.
  const reasoningKey = `${entry.id}:reasoning`;
  const speakingReply = speakingId === entry.id;
  const speakingReasoning = speakingId === reasoningKey;
  const spokenReply = plainText(entry.text ?? "");
  return (
    <div className="msg assistant">
      {entry.reasoningText ? (
        <details className="reasoning">
          <summary>
            reasoning
            <button
              className={`icon ${speakingReasoning ? "on" : ""}`}
              title={speakingReasoning ? "stop" : "read the reasoning aloud"}
              // A button inside a `summary` would otherwise fold the block it is
              // asking to be read.
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onSpeak(reasoningKey, entry.reasoningText ?? "");
              }}
            >
              {speakingReasoning ? "◼" : "🔊"}
            </button>
          </summary>
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
        {spokenReply !== "" ? (
          <button
            className={`icon ${speakingReply ? "on" : ""}`}
            title={speakingReply ? "stop" : "read aloud"}
            onClick={() => onSpeak(entry.id, entry.text ?? "")}
          >
            {speakingReply ? "◼" : "🔊"}
          </button>
        ) : null}
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

/** A tool result in the transcript (X-11). Collapsed it's one scannable line —
 *  tool name, the gist of its arguments, and how much output is hiding — because
 *  a long `ls` or a stack trace shouldn't bury the conversation. Expanded it
 *  shows the full arguments and the **whole** output (the debug journal's 200-char
 *  preview is a journal concern, not a transcript one) in its own scroll box, so
 *  a wide line scrolls here instead of shoving the page sideways.
 *
 *  Images are the exception to collapsing (P8e): a picture *is* the result, not
 *  noise hiding behind a caret, so it shows whether or not the block is open —
 *  and this is the surface the whole phase exists for, since the person and the
 *  model should be looking at the same thing. */
function ToolBlock({ entry, args }: { entry: EntryView; args?: string }) {
  const [open, setOpen] = useState(false);
  const content = entry.content ?? "";
  const stats = outputStats(content);
  const gist = summarizeArgs(args);
  const images = entry.attachments ?? [];
  // A `write_file` call's args *are* a file (X-23) — show them as one, since
  // after the approval card is gone they are the only record of what was written.
  const file = fileArgs(entry.name, args);
  return (
    <div className={`tool-block ${entry.isError ? "err" : ""} ${open ? "open" : ""}`}>
      <button className="tool-head" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={open ? "hide output" : "show output"}>
        <span className="tool-caret">{open ? "▾" : "▸"}</span>
        <span className="tool-name">{entry.name}</span>
        {gist ? (
          <span className="tool-gist" title={args}>
            {gist}
          </span>
        ) : null}
        {entry.isError ? <span className="tool-badge">error</span> : null}
        <span className="tool-size">{stats.label}</span>
      </button>
      {images.length > 0 ? (
        <div className="tool-images">
          {images.map((img, i) => (
            // The bytes come down their own route, lazily and cached (D-78j) —
            // the link opens the same URL full size, which is the cheapest
            // possible "let me actually look at that".
            <a
              key={img.url}
              className="tool-image"
              href={img.url}
              target="_blank"
              rel="noreferrer"
              title={`${img.name ?? img.mime} · ${formatBytes(img.bytes)}`}
            >
              <img src={img.url} alt={img.name ?? `attachment ${i + 1}`} loading="lazy" />
              <span className="tool-image-cap">{img.name ?? img.mime}</span>
            </a>
          ))}
        </div>
      ) : null}
      {open ? (
        <div className="tool-body">
          {file ? (
            <div className="tool-file">
              <div className="tool-file-head">
                <code>{file.path}</code>
                <span>{outputStats(file.body).label} written</span>
              </div>
              <pre className="tool-out args">{file.body === "" ? "(empty file)" : file.body}</pre>
            </div>
          ) : args ? (
            <pre className="tool-out args">{prettyArgs(args)}</pre>
          ) : null}
          <pre className="tool-out">{content === "" ? "(no output)" : content}</pre>
        </div>
      ) : null}
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
  if (r.kind === "note") {
    return (
      <div className="jrow">
        <div className="jrow-head">
          <span className="jkind">note</span>
          <span className="jmeta">{r.message}</span>
        </div>
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

/**
 * MCP status (P7b): which servers came up, what they offer, and what JLCode has
 * learned about them (D-47d/D-48). Read-only on purpose — `mcp_settings.json`
 * stays the source of truth, edited by hand or with `jlcode mcp`. The servers
 * are per-instance (D-47e), not per-session, so this lives beside the pane
 * header rather than inside a conversation.
 */
function McpButton() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await fetchMcpStatus());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  return (
    <>
      <button className="ghost" title="MCP servers (D-47)" onClick={() => setOpen(true)}>
        mcp
      </button>
      {open ? (
        <>
          <div className="drawer-scrim" onClick={() => setOpen(false)} />
          <aside className="drawer mcp-drawer">
            <div className="drawer-head">
              <span className="drawer-title">MCP servers</span>
              <span className="drawer-sub">{status ? `${status.servers.length} configured` : "loading…"}</span>
              <button className="ghost" onClick={() => void load()}>
                refresh
              </button>
              <button className="ghost" onClick={() => setOpen(false)}>
                close
              </button>
            </div>
            <div className="drawer-body">
              {error ? <div className="json-err">{error}</div> : null}
              {status && !status.enabled ? <div className="mcp-empty">MCP is not wired into this server.</div> : null}
              {status?.problems.map((p) => (
                <div className="json-err" key={p}>
                  {p}
                </div>
              ))}
              {status?.servers.length === 0 ? (
                <div className="mcp-empty">
                  No servers configured. <code>jlcode mcp import</code> copies KiloCode's settings over.
                </div>
              ) : null}
              {status?.servers.map((s) => (
                <McpServerCard key={s.name} server={s} />
              ))}
              {status?.files ? (
                <div className="mcp-files">
                  <div>
                    global: <code>{status.files.global}</code>
                  </div>
                  <div>
                    workspace: <code>{status.files.workspace}</code>
                  </div>
                </div>
              ) : null}
            </div>
          </aside>
        </>
      ) : null}
    </>
  );
}

function McpServerCard({ server }: { server: McpServerStatus }) {
  const learned = server.learned;
  const learnedRows: [string, string[]][] = [
    ["paths", learned.pathFields],
    ["not paths", learned.notPathFields],
    ["writes", learned.writeTools],
    ["read-only", learned.readTools],
  ];
  return (
    <div className="mcp-server">
      <div className="mcp-head">
        <span className={`mcp-state ${server.state}`}>{server.state}</span>
        <span className="mcp-name">{server.name}</span>
        <span className="mcp-scope">{server.scope}</span>
      </div>
      {server.error ? <div className="json-err">{server.error}</div> : null}
      {server.toolInfo.map((t) => (
        <div className="mcp-tool" key={t.name} title={t.description ?? ""}>
          <code>{t.mcpName}</code>
          <span className={`kind ${t.kind}`}>{t.kind}</span>
          {/* A presumed class is JLCode's guess, settled at the next pause (D-48). */}
          {t.presumed ? <span className="mcp-flag presumed">presumed</span> : null}
          {t.alwaysAllow ? <span className="mcp-flag always">alwaysAllow</span> : null}
        </div>
      ))}
      {learnedRows.some(([, v]) => v.length > 0) ? (
        <div className="mcp-learned">
          {learnedRows
            .filter(([, v]) => v.length > 0)
            .map(([label, v]) => (
              <div key={label}>
                <span className="mcp-learned-label">{label}:</span> <code>{v.join(", ")}</code>
              </div>
            ))}
        </div>
      ) : null}
    </div>
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
/**
 * The unified diff an `apply_edits` batch would produce (D-53) — read-only, so
 * the raw-JSON box below stays the single editable truth (D-16). Computed
 * server-side against the real files, which means a batch that *cannot* apply
 * shows its reason here instead of failing after the user approves it.
 */
function DiffPreview({ preview }: { preview: ToolPreviewDiff }) {
  const totals = preview.files.reduce(
    (t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed, bad: t.bad + (f.error ? 1 : 0) }),
    { added: 0, removed: 0, bad: 0 },
  );
  // A whole-file write can be a no-op — the model rewriting what it just read.
  // `+0 −0` above an empty box reads as broken; say it instead (X-23).
  const noChange = totals.bad === 0 && totals.added === 0 && totals.removed === 0;
  return (
    <div className="diff-preview">
      <div className="diff-head">
        {preview.files.length} file{preview.files.length === 1 ? "" : "s"}
        <span className="add">+{totals.added}</span>
        <span className="del">−{totals.removed}</span>
        {noChange ? <span className="sites">identical — this changes nothing</span> : null}
        {totals.bad > 0 ? <span className="diff-bad">{totals.bad} cannot apply</span> : null}
      </div>
      {preview.files.map((f) => (
        <details key={f.path} className="diff-file" open={preview.files.length <= 3 || !!f.error}>
          <summary>
            <code>{f.path}</code>
            {f.error ? (
              <span className="diff-bad">cannot apply</span>
            ) : (
              <>
                <span className="add">+{f.added}</span>
                <span className="del">−{f.removed}</span>
                {f.sites === undefined ? null : (
                  <span className="sites">
                    {f.sites} site{f.sites === 1 ? "" : "s"}
                  </span>
                )}
              </>
            )}
          </summary>
          {f.error ? (
            <div className="diff-err">{f.error}</div>
          ) : f.patch === "" ? null : ( // an identical write says so in the head; an empty box reads as broken
            <pre className="diff-body">
              {f.patch.split("\n").map((line, i) => (
                <div
                  key={i}
                  className={
                    line.startsWith("+") ? "dl add" : line.startsWith("-") ? "dl del" : line.startsWith("@@") ? "dl hunk" : "dl"
                  }
                >
                  {line || " "}
                </div>
              ))}
            </pre>
          )}
        </details>
      ))}
    </div>
  );
}

/** Header wording per action — the card's whole framing, so it is spelled out
 *  rather than derived from a tool name. */
const FILE_ACTIONS: Record<ToolPreviewFile["action"], string> = {
  create: "new file",
  overwrite: "overwrite",
  delete: "delete",
};

/**
 * A whole file on the approval card (X-23): the body of one about to be
 * created, or the head of one about to be deleted. Used where a diff would be
 * dishonest — a create has no left-hand side and a delete no right-hand side,
 * and an all-green (or all-red) wall marks every line as changed, which is
 * decoration rather than information. Read-only, like the diff card: the
 * raw-JSON box below stays the single editable truth (D-16).
 */
function FilePreview({ preview }: { preview: ToolPreviewFile }) {
  return (
    <div className={`diff-preview file-preview ${preview.action}`}>
      <div className="diff-head">
        <span className={`file-action ${preview.action}`}>{FILE_ACTIONS[preview.action]}</span>
        <code className="file-path">{preview.path}</code>
        <span className="file-size">
          {preview.lines} line{preview.lines === 1 ? "" : "s"} · {formatBytes(preview.bytes)}
        </span>
      </div>
      {preview.note ? <div className="file-note">{preview.note}</div> : null}
      {preview.error ? (
        <div className="diff-err">{preview.error}</div>
      ) : (
        <pre className="diff-body file-body">{preview.body === "" ? "(empty file)" : preview.body}</pre>
      )}
      {preview.omitted ? (
        <div className="file-note">
          … {preview.omitted} more line{preview.omitted === 1 ? "" : "s"} not shown
        </div>
      ) : null}
    </div>
  );
}

function ApprovalCard({
  request,
  onResolve,
}: {
  request: ApprovalRequest;
  onResolve: (d: {
    approve: boolean;
    editedArgs?: Record<string, unknown>;
    addRoot?: boolean | string;
    learned?: LearnAnswers;
  }) => void;
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

  // Guesses this pause can settle (D-48). Answers ride along with the decision
  // and are kept even on a deny — they describe the tool, not this call.
  const learn = request.learn;
  const [answers, setAnswers] = useState<LearnAnswers>({});
  const setField = (field: string, isPath: boolean) =>
    setAnswers((a) => ({ ...a, fields: { ...a.fields, [field]: isPath } }));
  const learned = answers.writes !== undefined || answers.fields !== undefined ? answers : undefined;

  // A field the user just called prose stops being an escape, so it must not
  // widen the fence — the buttons follow the answers, live.
  const fenceAll = request.outOfFence;
  const liveEscapes = fenceAll
    ? fenceAll.paths.filter((_, i) => answers.fields?.[fenceAll.fields[i] ?? ""] !== false)
    : [];
  const fence = fenceAll && liveEscapes.length > 0 ? { ...fenceAll, paths: liveEscapes } : undefined;

  // The mode gate blocked this only because JLCode presumes the tool writes.
  // Answering settles it: read-only lets the call through, "it writes" makes the
  // block permanent (the session re-runs the gate, so it denies with its own
  // reason rather than as a user denial).
  if (learn?.modeBlocked) {
    return (
      <div className="card approval">
        <div className="card-head">
          <span className="tool">{request.tool}</span>
          <span className={`kind ${request.kind}`}>{request.kind}</span>
          <span className="reason">{learn.modeBlocked}</span>
        </div>
        <div className="learn">
          <div className="learn-note">
            JLCode assumes an MCP tool writes unless its server says otherwise, and that is the only reason this
            call was blocked. Does <code>{request.tool}</code> change anything?
          </div>
          <details>
            <summary>args (JSON)</summary>
            <pre className="raw-view">{JSON.stringify(request.args, null, 2)}</pre>
          </details>
          <div className="actions">
            <button className="primary" onClick={() => onResolve({ approve: true, learned: { writes: false } })}>
              No — it only reads
            </button>
            <button className="danger" onClick={() => onResolve({ approve: true, learned: { writes: true } })}>
              Yes — it writes
            </button>
          </div>
          <div className="learn-foot">Remembered in mcp_settings.json — asked once per tool.</div>
        </div>
      </div>
    );
  }

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

      {request.preview?.kind === "diff" ? <DiffPreview preview={request.preview} /> : null}
      {request.preview?.kind === "file" ? <FilePreview preview={request.preview} /> : null}

      <details open={rawOpen || (!primaryKey && !request.preview)} onToggle={(e) => setRawOpen((e.target as HTMLDetailsElement).open)}>
        <summary>raw args (JSON)</summary>
        <textarea className="raw" value={rawText} spellCheck={false} rows={Math.min(10, rawText.split("\n").length + 1)} onChange={(e) => onRaw(e.target.value)} />
        {jsonErr ? <div className="json-err">invalid JSON: {jsonErr}</div> : null}
      </details>

      {learn && (learn.askWrite || (learn.fields?.length ?? 0) > 0) ? (
        <div className="learn">
          <div className="learn-note">
            JLCode guessed conservatively here — settle it once and it won't ask again:
          </div>
          {learn.askWrite ? (
            <div className="learn-q">
              <span>
                Does <code>{request.tool}</code> write anything?
              </span>
              <div className="seg">
                <button
                  className={answers.writes === true ? "on" : ""}
                  onClick={() => setAnswers((a) => ({ ...a, writes: true }))}
                >
                  writes
                </button>
                <button
                  className={answers.writes === false ? "on" : ""}
                  onClick={() => setAnswers((a) => ({ ...a, writes: false }))}
                >
                  read-only
                </button>
              </div>
            </div>
          ) : null}
          {(learn.fields ?? []).map((f) => (
            <div className="learn-q" key={f.field}>
              <span>
                Is <code>{f.field}</code> a file path?
                <em className="learn-value" title={f.value}>
                  {f.value.length > 60 ? `${f.value.slice(0, 60)}…` : f.value}
                </em>
              </span>
              <div className="seg">
                <button className={answers.fields?.[f.field] === true ? "on" : ""} onClick={() => setField(f.field, true)}>
                  a path
                </button>
                <button className={answers.fields?.[f.field] === false ? "on" : ""} onClick={() => setField(f.field, false)}>
                  just text
                </button>
              </div>
            </div>
          ))}
          <div className="learn-foot">Remembered in mcp_settings.json — unanswered stays fenced.</div>
        </div>
      ) : null}

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
          {/* H-08: an MCP server can remember the path it is handed, so "once" is
              a promise the fence cannot keep. The button is not disabled — it is
              absent, with the reason stated, because a greyed control invites the
              question "why not?" at the moment the answer matters. */}
          {fence.requiresRoot ? (
            <div className="fence-note fence-once-unavailable">
              This goes to an MCP server, which can remember the location — so it cannot be allowed
              just once. Widen the workspace, or deny.
            </div>
          ) : null}
          <div className="actions">
            {fence.requiresRoot ? null : (
              <button className="primary" disabled={!!jsonErr} onClick={() => onResolve({ approve: true, editedArgs, learned })}>
                Allow once
              </button>
            )}
            <button
              className="primary"
              disabled={!!jsonErr}
              onClick={() => onResolve({ approve: true, editedArgs, addRoot: true, learned })}
            >
              Remember <code>{fence.suggestedRoot}</code>
            </button>
            <button className="danger" onClick={() => onResolve({ approve: false, learned })}>
              Deny
            </button>
          </div>
        </div>
      ) : (
        <div className="actions">
          <button className="primary" disabled={!!jsonErr} onClick={() => onResolve({ approve: true, editedArgs, learned })}>
            {changed ? "Approve edited" : "Approve"}
          </button>
          <button className="danger" onClick={() => onResolve({ approve: false, learned })}>
            Deny
          </button>
        </div>
      )}
    </div>
  );
}

/** The ask_user form (D-18): one field per question, options as buttons
 *  (single- or multi-select), and — D-72 — **a free-text box on every question,
 *  always**, plus a visible Skip. The options are the model's suggestions; they
 *  are never the only exit, because the whole point of asking is to hear what
 *  the model didn't anticipate. The gating logic lives in `ask-form.ts` so it
 *  can be tested. */
function AskForm({
  request,
  onSubmit,
}: {
  request: AskUserRequest;
  onSubmit: (answers: AskAnswer[]) => void;
}) {
  const [state, setState] = useState<QState[]>(() => request.questions.map(() => emptyQState()));

  const update = (i: number, fn: (q: QState) => QState) =>
    setState((s) => s.map((q, j) => (j === i ? fn(q) : q)));

  const acts = askActions(request.questions, state);
  const single = request.questions.length === 1;

  /** Submit and Skip post the same payload — blanks ride back as declines
   *  either way. Two buttons because "I don't want to pick any of these" has to
   *  be a thing you can *see*, not an empty form you have to reason about. */
  const submit = () => onSubmit(buildAnswers(request.questions, state));

  return (
    <div className="card ask">
      {request.questions.map((q, i) => (
        <div className="q" key={i}>
          <div className="q-head">
            {q.header ? <span className="q-header">{q.header}</span> : null}
            <span className="q-text">{q.question}</span>
            {q.multiSelect ? <span className="q-hint">choose any</span> : null}
            {q.required ? <span className="q-req">required</span> : null}
          </div>
          {q.options && q.options.length > 0 ? (
            <div className="opts">
              {q.options.map((opt) => (
                <button
                  key={opt}
                  className={state[i]!.selected.includes(opt) ? "opt on" : "opt"}
                  onClick={() => update(i, (s) => toggleOption(s, opt, q.multiSelect ?? false))}
                >
                  {opt}
                </button>
              ))}
            </div>
          ) : null}
          <input
            className="free"
            placeholder={
              q.options && q.options.length
                ? "…or say something else — you don't have to pick one"
                : "type your answer…"
            }
            value={state[i]!.text}
            onChange={(e) => update(i, (s) => ({ ...s, text: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && single && acts.canSubmit) {
                e.preventDefault();
                submit();
              }
            }}
          />
        </div>
      ))}
      {acts.blocked ? <div className="ask-blocked">{acts.blocked}</div> : null}
      <div className="actions">
        <button className="primary" disabled={!acts.canSubmit} onClick={submit}>
          {acts.submitLabel}
        </button>
        {acts.showSkip ? (
          <button
            className="ask-skip"
            disabled={!acts.canSkip}
            title="Send this back as “none of these” — the agent is told you declined, not that you agreed."
            onClick={submit}
          >
            {acts.skipLabel}
          </button>
        ) : null}
      </div>
      <div className="ask-foot">
        {acts.blanks > 0 && acts.canSkip
          ? `${acts.blanks === request.questions.length && single ? "Skipping" : `${acts.blanks} unanswered`} comes back as “declined” — the agent is told you chose none of the options.`
          : "You can type an answer instead of picking one."}
      </div>
    </div>
  );
}
