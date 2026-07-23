/**
 * Thin browser client for the JLCode server: POST up (create session, send
 * message), SSE down (live session events). The event stream is the same one
 * the session emits (session/types.ts) and persistence projects (D-37) — the UI
 * is just another subscriber (§11).
 */

export interface UiMessage {
  role: "user" | "assistant";
  text: string;
  reasoning?: string;
  streaming?: boolean;
  truncated?: boolean;
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
    // tool/compaction entries aren't rendered in the P5a bare view.
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

/** Send a user message. Deltas arrive over SSE; this resolves at turn end. */
export async function sendChat(id: string, text: string): Promise<void> {
  const res = await fetch("/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: id, text }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `chat failed (${res.status})`);
  }
}
