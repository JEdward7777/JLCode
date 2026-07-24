import { useCallback, useEffect, useRef, useState } from "react";
import { renderMarkdown } from "./markdown";
import {
  answer as apiAnswer,
  approve as apiApprove,
  setMode as apiSetMode,
  setCap as apiSetCap,
  stopSession as apiStop,
  killTask as apiKillTask,
  queueMessage as apiQueue,
  setQueue as apiSetQueue,
  createOrGetSession,
  loadSession,
  openEvents,
  sendChat,
  type ApprovalPolicy,
  type ApprovalRequest,
  type AskUserRequest,
  type Mode,
  type QueuedMessage,
  type SessionState,
  type TaskView,
  type UiMessage,
  type WireEvent,
} from "./api";

// Whimsical working-status words (SPEC §11 note: percolating…).
const WORKING = ["percolating…", "pondering…", "noodling…", "whirring…", "cogitating…", "ruminating…"];
const MODES: Mode[] = ["ask", "plan", "code"];
const POLICIES: ApprovalPolicy[] = ["manual", "auto-safe", "full-auto", "read-only"];

/** Replace the last message matching `role`, applying `fn`. */
function patchLast(list: UiMessage[], role: UiMessage["role"], fn: (m: UiMessage) => UiMessage): UiMessage[] {
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]!.role === role) {
      const copy = list.slice();
      copy[i] = fn(list[i]!);
      return copy;
    }
  }
  return list;
}

export function App() {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [working, setWorking] = useState(false);
  const [input, setInput] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setModeState] = useState<Mode>("code");
  const [approval, setApprovalState] = useState<ApprovalPolicy>("manual");
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);
  const [pendingAsk, setPendingAsk] = useState<AskUserRequest | null>(null);
  const [spendUsd, setSpendUsd] = useState(0);
  const [capUsd, setCapUsd] = useState<number | null>(null);
  const [capReached, setCapReached] = useState(false);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const sessionRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [workWord, setWorkWord] = useState(WORKING[0]!);

  // Apply a settled-state snapshot (SSE `ready` frame, or an action response).
  const applyState = useCallback((s: SessionState) => {
    if (s.mode) setModeState(s.mode);
    if (s.approval) setApprovalState(s.approval);
    setPendingApproval(s.approvalRequest ?? null);
    setPendingAsk(s.question ?? null);
    setWorking(s.status === "running");
    if (typeof s.spendUsd === "number") setSpendUsd(s.spendUsd);
    if (s.spendCapUsd !== undefined) setCapUsd(s.spendCapUsd);
    if (typeof s.capReached === "boolean") setCapReached(s.capReached);
    if (s.tasks) setTasks(s.tasks);
    if (s.queue) setQueue(s.queue);
  }, []);

  const onEvent = useCallback(
    (e: WireEvent) => {
      switch (e.type) {
        case "ready":
          setConnected(true);
          if (e.state) applyState(e.state as SessionState);
          break;
        case "mode":
          setModeState(e.mode as Mode);
          setApprovalState(e.approval as ApprovalPolicy);
          break;
        case "spend":
          setSpendUsd(e.totalUsd as number);
          break;
        case "cap":
          setCapUsd((e.capUsd as number | null) ?? null);
          setCapReached(false);
          break;
        case "cap-reached":
          setCapReached(true);
          setWorking(false);
          setNotice(`Spend cap reached ($${(e.spendUsd as number).toFixed(4)} / $${(e.capUsd as number).toFixed(2)}). Raise it to continue.`);
          break;
        case "stopped":
          setWorking(false);
          setNotice(e.scope === "hard" ? "Stopped — aborted the turn and killed all tasks." : "Stopping after the current work — no further turn.");
          break;
        case "queue":
          setQueue((e.queue as QueuedMessage[]) ?? []);
          break;
        case "task-start":
        case "task-update":
          setTasks((ts) => {
            const t = e.task as TaskView;
            const rest = ts.filter((x) => x.id !== t.id);
            return t.status === "running" ? [...rest, t] : rest;
          });
          break;
        case "task-end":
          setTasks((ts) => ts.filter((x) => x.id !== (e.task as TaskView).id));
          break;
        case "assistant-start":
          setWorking(true);
          setMessages((m) => [...m, { role: "assistant", text: "", reasoning: "", streaming: true }]);
          break;
        case "reasoning":
          setMessages((m) => patchLast(m, "assistant", (msg) => ({ ...msg, reasoning: (msg.reasoning ?? "") + (e.delta as string) })));
          break;
        case "text":
          setMessages((m) => patchLast(m, "assistant", (msg) => ({ ...msg, text: msg.text + (e.delta as string) })));
          break;
        case "assistant-end":
          setWorking(false);
          setMessages((m) => patchLast(m, "assistant", (msg) => ({ ...msg, streaming: false, truncated: e.truncated as boolean })));
          break;
        case "awaiting-approval":
          setWorking(false);
          setPendingApproval(e.request as ApprovalRequest);
          break;
        case "awaiting-input":
          setWorking(false);
          setPendingAsk(e.question as AskUserRequest);
          break;
        case "truncation":
          setNotice(e.message as string);
          break;
        case "error":
          setNotice(e.message as string);
          setWorking(false);
          break;
        case "halted":
          setNotice(`halted: ${e.reason as string}`);
          setWorking(false);
          break;
      }
    },
    [applyState],
  );

  // Connect: create/resume a session, load its transcript, subscribe to events.
  useEffect(() => {
    let es: EventSource | undefined;
    let cancelled = false;
    (async () => {
      try {
        const id = await createOrGetSession();
        if (cancelled) return;
        sessionRef.current = id;
        const url = new URL(window.location.href);
        url.searchParams.set("session", id);
        window.history.replaceState({}, "", url);
        const history = await loadSession(id);
        if (cancelled) return;
        if (history.length) setMessages(history);
        es = openEvents(id, onEvent);
      } catch (err) {
        if (!cancelled) setNotice((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      es?.close();
    };
  }, [onEvent]);

  // Rotate the working word while the agent is busy.
  useEffect(() => {
    if (!working) return;
    let i = 0;
    const t = setInterval(() => setWorkWord(WORKING[++i % WORKING.length]!), 1400);
    return () => clearInterval(t);
  }, [working]);

  // Keep the newest message / prompt in view.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, working, pendingApproval, pendingAsk]);

  // "Busy" = the agent can't take a fresh Send right now: the LLM is thinking, a
  // background command is running, or a prompt is open. While busy, the composer
  // queues (D-34) instead of sending.
  const blocked = working || tasks.length > 0 || pendingApproval !== null || pendingAsk !== null;

  const submit = useCallback(async () => {
    const text = input.trim();
    const id = sessionRef.current;
    if (!text || !id || blocked) return;
    setNotice(null);
    setInput("");
    setMessages((m) => [...m, { role: "user", text }]);
    try {
      await sendChat(id, text);
    } catch (err) {
      setNotice((err as Error).message);
    }
  }, [input, blocked]);

  const changeMode = useCallback(async (patch: { mode?: Mode; approval?: ApprovalPolicy }) => {
    const id = sessionRef.current;
    if (!id) return;
    if (patch.mode) setModeState(patch.mode); // optimistic; the `mode` event re-syncs
    if (patch.approval) setApprovalState(patch.approval);
    try {
      await apiSetMode(id, patch);
    } catch (err) {
      setNotice((err as Error).message);
    }
  }, []);

  const resolveApproval = useCallback(
    async (decision: { approve: boolean; editedArgs?: Record<string, unknown>; addRoot?: boolean | string }) => {
      const id = sessionRef.current;
      if (!id) return;
      setPendingApproval(null);
      setWorking(true);
      try {
        await apiApprove(id, decision);
      } catch (err) {
        setNotice((err as Error).message);
        setWorking(false);
      }
    },
    [],
  );

  const submitAnswer = useCallback(async (answers: Array<{ question: string; header?: string; answer: string }>) => {
    const id = sessionRef.current;
    if (!id) return;
    setPendingAsk(null);
    setWorking(true);
    try {
      await apiAnswer(id, answers);
    } catch (err) {
      setNotice((err as Error).message);
      setWorking(false);
    }
  }, []);

  // Queue the composer text for the next turn boundary (D-34).
  const queueMsg = useCallback(async () => {
    const text = input.trim();
    const id = sessionRef.current;
    if (!text || !id) return;
    setInput("");
    try {
      await apiQueue(id, text);
    } catch (err) {
      setNotice((err as Error).message);
    }
  }, [input]);

  const changeCap = useCallback(async (next: number | null) => {
    const id = sessionRef.current;
    if (!id) return;
    setNotice(null);
    try {
      await apiSetCap(id, next);
    } catch (err) {
      setNotice((err as Error).message);
    }
  }, []);

  const stop = useCallback(async (scope: "hard" | "soft") => {
    const id = sessionRef.current;
    if (!id) return;
    try {
      await apiStop(id, scope);
    } catch (err) {
      setNotice((err as Error).message);
    }
  }, []);

  const killOne = useCallback(async (taskId: string) => {
    const id = sessionRef.current;
    if (!id) return;
    try {
      await apiKillTask(id, taskId);
    } catch (err) {
      setNotice((err as Error).message);
    }
  }, []);

  // Cancel one queued message (drop it); editing = drop it back into the box.
  const cancelQueued = useCallback(
    async (qid: string) => {
      const id = sessionRef.current;
      if (!id) return;
      try {
        await apiSetQueue(id, queue.filter((m) => m.id !== qid).map((m) => ({ text: m.text })));
      } catch (err) {
        setNotice((err as Error).message);
      }
    },
    [queue],
  );

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">JLCode</span>
        <span className={`dot ${connected ? "on" : ""}`} title={connected ? "connected" : "connecting…"} />
        <div className="controls">
          <SpendChip spendUsd={spendUsd} capUsd={capUsd} capReached={capReached} onSetCap={changeCap} />
          <StopControl active={working || tasks.length > 0} onStop={stop} />
          <div className="seg" role="group" aria-label="mode">
            {MODES.map((m) => (
              <button key={m} className={m === mode ? "on" : ""} onClick={() => void changeMode({ mode: m })}>
                {m}
              </button>
            ))}
          </div>
          <select
            className="policy"
            value={approval}
            aria-label="approval policy"
            onChange={(e) => void changeMode({ approval: e.target.value as ApprovalPolicy })}
          >
            {POLICIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
      </header>

      <div className="thread" ref={scrollRef}>
        {messages.length === 0 && !pendingApproval && !pendingAsk && <div className="empty">Say something to get started.</div>}
        {messages.map((m, i) => (
          <Message key={i} m={m} />
        ))}
        {working && <div className="working">{workWord}</div>}
        {tasks.length > 0 && <TasksPanel tasks={tasks} onKill={killOne} />}
        {pendingApproval && <ApprovalCard request={pendingApproval} onResolve={resolveApproval} />}
        {pendingAsk && <AskForm request={pendingAsk} onSubmit={submitAnswer} />}
        {capReached && <CapBanner spendUsd={spendUsd} capUsd={capUsd} onRaise={changeCap} />}
        {notice && <div className="notice">{notice}</div>}
      </div>

      {queue.length > 0 && (
        <div className="queue">
          <span className="queue-label">queued</span>
          {queue.map((m) => (
            <button key={m.id} className="queued" title="cancel" onClick={() => void cancelQueued(m.id)}>
              <span className="queued-text">{m.text}</span>
              <span className="x">✕</span>
            </button>
          ))}
        </div>
      )}

      <footer className="composer">
        <textarea
          value={input}
          placeholder={
            pendingApproval || pendingAsk
              ? "Respond to the agent above…"
              : blocked
                ? "Queue a message for the next turn…  (Enter to queue)"
                : "Message JLCode…  (Enter to send, Shift+Enter for newline)"
          }
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (blocked) void queueMsg();
              else void submit();
            }
          }}
          rows={2}
        />
        {blocked ? (
          <button onClick={() => void queueMsg()} disabled={!input.trim()}>
            Queue
          </button>
        ) : (
          <button onClick={() => void submit()} disabled={!input.trim()}>
            Send
          </button>
        )}
      </footer>
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

function Message({ m }: { m: UiMessage }) {
  if (m.role === "user") {
    return (
      <div className="msg user">
        <div className="bubble">{m.text}</div>
      </div>
    );
  }
  // A tool-call-only turn has no text/reasoning — don't render an empty bubble.
  if (!m.text && !m.reasoning && !m.streaming) return null;
  return (
    <div className="msg assistant">
      {m.reasoning ? (
        <details className="reasoning">
          <summary>reasoning</summary>
          <pre>{m.reasoning}</pre>
        </details>
      ) : null}
      {m.text || m.streaming ? (
        <div className="bubble">
          <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text || "…") }} />
          {m.truncated ? <div className="truncated">⚠ output was truncated (max_tokens)</div> : null}
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
