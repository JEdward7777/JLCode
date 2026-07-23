/**
 * The dev HTTP endpoint for driving conversations (Phase 5 groundwork). Each
 * request is one-shot; the server retains threads by session id. With tools
 * wired in (Phase 3b), a turn can pause for **approval** (D-16) or **ask_user**
 * (D-18) — the response reports the awaiting state, and /approve or /answer
 * resumes. Streaming (SSE), the browser UI, and auth arrive with full Phase 5.
 */
import { Hono } from "hono";
import type { ModelConfig } from "../config/types.js";
import type { Conversation, Entry } from "../conversation/types.js";
import type { ConversationStore } from "../persist/conversation-store.js";
import { SessionManager } from "../session/manager.js";
import type { Session } from "../session/session.js";

export interface ServerDeps {
  /** Re-read the selected config on demand, so CLI edits are picked up live. */
  resolveConfig: () => ModelConfig | undefined;
  /** Build a fully-wired session (driver + tools + sandbox + gate); pass a
   *  loaded conversation to resume it. */
  newSession: (config: ModelConfig, conversation?: Conversation) => Session;
  /** Persistence for conversations (resume + history). */
  store: ConversationStore;
  /** The server's working directory (sandbox root + history filter default). */
  workingDir: string;
  version: string;
  /** Optional: called by POST /shutdown so a caller can stop the dev server. */
  onShutdown?: () => void;
}

function entryView(entry: Entry): Record<string, unknown> {
  const base = { id: entry.id, parent: entry.parent }; // ids for fork/rewind navigation
  switch (entry.type) {
    case "user":
      return { ...base, type: "user", text: entry.text };
    case "assistant":
      return {
        ...base,
        type: "assistant",
        text: entry.text,
        toolCalls: entry.toolCalls?.map((t) => ({ name: t.function.name, arguments: t.function.arguments })),
        reasoningText: entry.reasoningText,
        truncated: entry.truncated ?? false,
        finishReason: entry.finishReason,
      };
    case "tool":
      return { ...base, type: "tool", name: entry.name, content: entry.content, isError: entry.isError ?? false };
    case "compaction":
      return { ...base, type: "compaction", summary: entry.summary };
  }
}

/** Build the response describing the session's current settled state. */
function stateOf(session: Session): Record<string, unknown> {
  const entries = session.conversation.entries;
  const lastAssistant = [...entries].reverse().find((e) => e.type === "assistant");
  const base: Record<string, unknown> = {
    sessionId: session.id,
    conversationId: session.conversation.id,
    status: session.status,
    reply: lastAssistant && lastAssistant.type === "assistant" ? lastAssistant.text : "",
  };
  if (session.status === "awaiting-approval") base.approval = session.awaitingApproval;
  if (session.status === "awaiting-input") base.question = session.awaitingInput;
  return base;
}

export function createServer(deps: ServerDeps): { app: Hono; manager: SessionManager } {
  const app = new Hono();
  const manager = new SessionManager();

  /** Build a session, register it, and wire persistence. Pass a loaded
   *  conversation to resume; otherwise a fresh conversation log is created. */
  function startSession(config: ModelConfig, conversation?: Conversation): Session {
    const session = deps.newSession(config, conversation);
    if (!conversation) {
      void deps.store.create({ id: session.conversation.id, workingDir: deps.workingDir, configName: config.name });
    }
    session.onEvent((e) => {
      if (e.type === "entry") void deps.store.entry(session.conversation.id, e.entry);
      else if (e.type === "active-leaf") void deps.store.activeLeaf(session.conversation.id, e.leaf);
    });
    return manager.add(session);
  }

  app.get("/health", (c) => {
    const config = deps.resolveConfig();
    return c.json({
      ok: true,
      version: deps.version,
      pid: process.pid,
      config: config?.name ?? null,
      model: config?.model ?? null,
    });
  });

  // Dev convenience: stop the server cleanly (localhost only; auth arrives in P5).
  app.post("/shutdown", (c) => {
    if (!deps.onShutdown) return c.json({ error: "shutdown not supported" }, 404);
    deps.onShutdown();
    return c.json({ stopping: true });
  });

  app.get("/config", (c) => {
    const config = deps.resolveConfig();
    if (!config) return c.json({ error: "no config selected" }, 404);
    return c.json({
      name: config.name,
      model: config.model,
      mode: config.defaultMode,
      approval: config.defaultApproval,
      reasoningEffort: config.reasoningEffort ?? null,
      maxTokens: config.sampling?.maxTokens ?? null,
      hasKey: Boolean(config.openRouterKey),
    });
  });

  app.get("/sessions", (c) =>
    c.json({
      sessions: manager.list().map((s) => ({
        id: s.id,
        status: s.status,
        model: s.config.model,
        entries: s.conversation.entries.length,
      })),
    }),
  );

  app.get("/session/:id", (c) => {
    const session = manager.get(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    return c.json({
      id: session.id,
      status: session.status,
      model: session.config.model,
      activeLeaf: session.conversation.activeLeaf,
      entries: session.conversation.entries.map(entryView),
    });
  });

  // Rewind / switch branch: point the active leaf at an existing entry (D-10).
  app.post("/session/:id/rewind", async (c) => {
    const session = manager.get(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { entryId?: unknown };
    if (typeof body.entryId !== "string") return c.json({ error: "body must include 'entryId'" }, 400);
    try {
      session.setActiveLeaf(body.entryId);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    await deps.store.flush();
    return c.json(stateOf(session));
  });

  // Edit-and-fork a message: create a sibling with new text and run (D-17).
  app.post("/session/:id/edit", async (c) => {
    const session = manager.get(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { entryId?: unknown; text?: unknown };
    if (typeof body.entryId !== "string" || typeof body.text !== "string") {
      return c.json({ error: "body must include 'entryId' and 'text'" }, 400);
    }
    try {
      await session.editFork(body.entryId, body.text);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    await deps.store.flush();
    return c.json(stateOf(session));
  });

  app.post("/chat", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      text?: unknown;
      sessionId?: unknown;
      conversationId?: unknown;
    };
    if (typeof body.text !== "string" || body.text.trim() === "") {
      return c.json({ error: "body must include a non-empty 'text'" }, 400);
    }

    let session: Session;
    if (typeof body.sessionId === "string") {
      const found = manager.get(body.sessionId);
      if (!found) return c.json({ error: "no such session" }, 404);
      session = found;
    } else {
      const config = deps.resolveConfig();
      if (!config) return c.json({ error: "no model config selected for the server directory" }, 409);
      if (typeof body.conversationId === "string") {
        const loaded = deps.store.load(body.conversationId);
        if (!loaded) return c.json({ error: "no such conversation" }, 404);
        session = startSession(config, loaded); // resume from disk
      } else {
        session = startSession(config); // fresh
      }
    }

    try {
      await session.send(body.text);
      await deps.store.flush(); // read-your-writes: entries durable before we respond
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409);
    }
    return c.json(stateOf(session));
  });

  // History for a directory (default the server's dir; ?dir=all for everything).
  app.get("/conversations", (c) => {
    const dir = c.req.query("dir");
    const rows = dir === "all" ? deps.store.list() : deps.store.list(dir ?? deps.workingDir);
    return c.json({ conversations: rows });
  });

  // A persisted conversation, loaded from disk (distinct from a live /session).
  app.get("/conversation/:id", (c) => {
    const conv = deps.store.load(c.req.param("id"));
    if (!conv) return c.json({ error: "no such conversation" }, 404);
    return c.json({ id: conv.id, activeLeaf: conv.activeLeaf, entries: conv.entries.map(entryView) });
  });

  // Resolve a pending approval: {approve: bool, editedArgs?, reason?} (D-16).
  app.post("/session/:id/approve", async (c) => {
    const session = manager.get(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    if (session.status !== "awaiting-approval") return c.json({ error: "not awaiting approval" }, 409);
    const body = (await c.req.json().catch(() => ({}))) as {
      approve?: unknown;
      editedArgs?: unknown;
      reason?: unknown;
      addRoot?: unknown;
    };
    await session.approve({
      approve: body.approve !== false,
      editedArgs:
        body.editedArgs && typeof body.editedArgs === "object"
          ? (body.editedArgs as Record<string, unknown>)
          : undefined,
      reason: typeof body.reason === "string" ? body.reason : undefined,
      addRoot:
        typeof body.addRoot === "string" || typeof body.addRoot === "boolean" ? body.addRoot : undefined,
    });
    await deps.store.flush();
    return c.json(stateOf(session));
  });

  // Answer a pending ask_user: {text} (D-18).
  app.post("/session/:id/answer", async (c) => {
    const session = manager.get(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    if (session.status !== "awaiting-input") return c.json({ error: "not awaiting input" }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown };
    if (typeof body.text !== "string") return c.json({ error: "body must include 'text'" }, 400);
    await session.answer(body.text);
    await deps.store.flush();
    return c.json(stateOf(session));
  });

  return { app, manager };
}
