import { useCallback, useEffect, useRef, useState } from "react";
import { renderMarkdown } from "./markdown";
import { createOrGetSession, loadSession, openEvents, sendChat, type UiMessage, type WireEvent } from "./api";

// Whimsical working-status words (SPEC §11 note: percolating…).
const WORKING = ["percolating…", "pondering…", "noodling…", "whirring…", "cogitating…", "ruminating…"];

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
  const sessionRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [workWord, setWorkWord] = useState(WORKING[0]!);

  const onEvent = useCallback((e: WireEvent) => {
    switch (e.type) {
      case "ready":
        setConnected(true);
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
      case "awaiting-approval":
        setNotice("The agent wants to run a tool — approval UI arrives in P5b. Resolve it via the API for now.");
        setWorking(false);
        break;
      case "awaiting-input":
        setNotice("The agent is asking a question — the ask_user UI arrives in P5b.");
        setWorking(false);
        break;
    }
  }, []);

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

  // Keep the newest message in view.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, working]);

  const submit = useCallback(async () => {
    const text = input.trim();
    const id = sessionRef.current;
    if (!text || !id || working) return;
    setNotice(null);
    setInput("");
    setMessages((m) => [...m, { role: "user", text }]);
    try {
      await sendChat(id, text);
    } catch (err) {
      setNotice((err as Error).message);
    }
  }, [input, working]);

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">JLCode</span>
        <span className={`dot ${connected ? "on" : ""}`} title={connected ? "connected" : "connecting…"} />
      </header>

      <div className="thread" ref={scrollRef}>
        {messages.length === 0 && <div className="empty">Say something to get started.</div>}
        {messages.map((m, i) => (
          <Message key={i} m={m} />
        ))}
        {working && <div className="working">{workWord}</div>}
        {notice && <div className="notice">{notice}</div>}
      </div>

      <footer className="composer">
        <textarea
          value={input}
          placeholder="Message JLCode…  (Enter to send, Shift+Enter for newline)"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={2}
        />
        <button onClick={() => void submit()} disabled={working || !input.trim()}>
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
  return (
    <div className="msg assistant">
      {m.reasoning ? (
        <details className="reasoning">
          <summary>reasoning</summary>
          <pre>{m.reasoning}</pre>
        </details>
      ) : null}
      <div className="bubble">
        <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text || (m.streaming ? "…" : "")) }} />
        {m.truncated ? <div className="truncated">⚠ output was truncated (max_tokens)</div> : null}
      </div>
    </div>
  );
}
