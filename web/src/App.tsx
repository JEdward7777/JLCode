import { useCallback, useEffect, useRef, useState } from "react";
import { renderMarkdown } from "./markdown";
import {
  answer as apiAnswer,
  approve as apiApprove,
  setMode as apiSetMode,
  createOrGetSession,
  loadSession,
  openEvents,
  sendChat,
  type ApprovalPolicy,
  type ApprovalRequest,
  type AskUserRequest,
  type Mode,
  type SessionState,
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

  const blocked = working || pendingApproval !== null || pendingAsk !== null;

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

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">JLCode</span>
        <span className={`dot ${connected ? "on" : ""}`} title={connected ? "connected" : "connecting…"} />
        <div className="controls">
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
        {pendingApproval && <ApprovalCard request={pendingApproval} onResolve={resolveApproval} />}
        {pendingAsk && <AskForm request={pendingAsk} onSubmit={submitAnswer} />}
        {notice && <div className="notice">{notice}</div>}
      </div>

      <footer className="composer">
        <textarea
          value={input}
          placeholder={
            pendingApproval || pendingAsk ? "Respond to the agent above…" : "Message JLCode…  (Enter to send, Shift+Enter for newline)"
          }
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={2}
        />
        <button onClick={() => void submit()} disabled={blocked || !input.trim()}>
          Send
        </button>
      </footer>
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
