/**
 * The dev HTTP endpoint for driving conversations (Phase 5 groundwork). Each
 * request is one-shot; the server retains threads by session id. With tools
 * wired in (Phase 3b), a turn can pause for **approval** (D-16) or **ask_user**
 * (D-18) — the response reports the awaiting state, and /approve or /answer
 * resumes. Streaming (SSE), the browser UI, and auth arrive with full Phase 5.
 */
import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ApprovalPolicy, Mode, ModelConfig } from "../config/types.js";
import { APPROVAL_POLICIES, MODES } from "../config/types.js";
import type { AskUserAnswer } from "../session/types.js";
import type { Conversation, Entry } from "../conversation/types.js";
import type { ConversationStore } from "../persist/conversation-store.js";
import type { DebugJournal } from "../persist/debug-journal.js";
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
  /** Optional verbose per-turn debug journal (D-15). */
  debugJournal?: DebugJournal;
  /** The server's working directory (sandbox root + history filter default). */
  workingDir: string;
  version: string;
  /** Optional: called by POST /shutdown so a caller can stop the dev server. */
  onShutdown?: () => void;
  /** Optional: persist a mode/approval change as the config's new default, so a
   *  live switch (D-07/D-08) sticks for the next session in this folder. */
  persistDefaults?: (configName: string, patch: { mode?: Mode; approval?: ApprovalPolicy }) => void;
  /** Optional: directory of the built browser client (dist/web). When set, a
   *  catch-all serves it (SPA fallback to index.html). Omitted in tests. */
  staticDir?: string;
}

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

/** Resolve a URL path to a file under `root`, guarding against traversal, with
 *  SPA fallback to index.html. Returns null only if index.html itself is gone. */
function resolveStatic(root: string, urlPath: string): string | null {
  const base = path.resolve(root);
  const index = path.join(base, "index.html");
  let rel = decodeURIComponent(urlPath);
  if (rel === "/" || rel === "") rel = "/index.html";
  const candidate = path.resolve(base, "." + rel);
  const inside = candidate === base || candidate.startsWith(base + path.sep);
  if (inside && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  return fs.existsSync(index) ? index : null; // SPA fallback (and traversal → index)
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
    mode: session.mode,
    approval: session.approval,
    spendUsd: session.spendUsd,
    spendCapUsd: session.spendCapUsd ?? null,
    capReached: session.capReached,
    reply: lastAssistant && lastAssistant.type === "assistant" ? lastAssistant.text : "",
  };
  // `approval` is the policy (above); the pending request rides separately so the
  // two don't collide.
  if (session.status === "awaiting-approval") base.approvalRequest = session.awaitingApproval;
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
      else if (e.type === "debug" && deps.debugJournal) {
        void deps.debugJournal.record(session.conversation.id, e.record);
      }
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

  // Create an empty live session up front, so the browser can subscribe to its
  // event stream (below) before sending the first message (POST up / SSE down).
  app.post("/session", (c) => {
    const config = deps.resolveConfig();
    if (!config) return c.json({ error: "no model config selected for the server directory" }, 409);
    const session = startSession(config);
    return c.json({ sessionId: session.id, conversationId: session.conversation.id });
  });

  // SSE down: the session's live event stream (§11) — the same events the
  // persistence projections consume (D-37); the browser is just one subscriber.
  // A first `ready` frame confirms the listener is attached (safe to send).
  app.get("/session/:id/events", (c) => {
    const session = manager.get(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    return streamSSE(c, async (stream) => {
      const queue: unknown[] = [];
      let wake: (() => void) | null = null;
      const bump = () => {
        const w = wake;
        wake = null;
        w?.();
      };
      const unsub = session.onEvent((e) => {
        queue.push(e);
        bump();
      });
      stream.onAbort(() => {
        unsub();
        bump();
      });
      queue.push({ type: "ready", state: stateOf(session) }); // listener attached
      try {
        while (!stream.aborted) {
          while (queue.length > 0) await stream.writeSSE({ data: JSON.stringify(queue.shift()) });
          if (stream.aborted) break;
          await new Promise<void>((resolve) => (wake = resolve));
        }
      } finally {
        unsub();
      }
    });
  });

  app.get("/session/:id", (c) => {
    const session = manager.get(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    return c.json({
      id: session.id,
      status: session.status,
      model: session.config.model,
      mode: session.mode,
      approval: session.approval,
      activeLeaf: session.conversation.activeLeaf,
      entries: session.conversation.entries.map(entryView),
    });
  });

  // Switch capability mode / approval policy for a live session (D-07/D-08). The
  // session re-gates immediately; the change is also persisted as the config's
  // new default (per Joshua's call) so it sticks for the next session here.
  app.post("/session/:id/mode", async (c) => {
    const session = manager.get(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { mode?: unknown; approval?: unknown };
    const mode = body.mode === undefined ? undefined : (body.mode as Mode);
    const approval = body.approval === undefined ? undefined : (body.approval as ApprovalPolicy);
    if (mode !== undefined && !MODES.includes(mode)) return c.json({ error: `invalid mode: ${String(body.mode)}` }, 400);
    if (approval !== undefined && !APPROVAL_POLICIES.includes(approval)) {
      return c.json({ error: `invalid approval policy: ${String(body.approval)}` }, 400);
    }
    if (mode === undefined && approval === undefined) return c.json({ error: "nothing to change" }, 400);
    session.setModeApproval(mode, approval);
    deps.persistDefaults?.(session.config.name, { mode, approval });
    return c.json(stateOf(session));
  });

  // Set / raise / clear the whole-tree spend cap (D-33). Body: {capUsd: number|null}.
  // Raising above current spend after a breach resumes the paused loop.
  app.post("/session/:id/cap", async (c) => {
    const session = manager.get(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { capUsd?: unknown };
    let cap: number | null;
    if (body.capUsd === null) cap = null;
    else if (typeof body.capUsd === "number" && body.capUsd >= 0 && Number.isFinite(body.capUsd)) cap = body.capUsd;
    else return c.json({ error: "body must include 'capUsd' as a non-negative number or null" }, 400);
    await session.setSpendCap(cap);
    await deps.store.flush();
    return c.json(stateOf(session));
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

  // The verbose debug journal for a conversation — the "Halp!" record (D-15).
  app.get("/conversation/:id/journal", (c) => {
    if (!deps.debugJournal) return c.json({ error: "no debug journal" }, 404);
    return c.json({ records: deps.debugJournal.read(c.req.param("id")) });
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

  // Answer a pending ask_user (D-18): either {text} for a single-question form,
  // or {answers:[{question, answer, header?}]} for a multi-question form.
  app.post("/session/:id/answer", async (c) => {
    const session = manager.get(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    if (session.status !== "awaiting-input") return c.json({ error: "not awaiting input" }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown; answers?: unknown };
    let payload: string | AskUserAnswer[];
    if (typeof body.text === "string") {
      payload = body.text;
    } else if (Array.isArray(body.answers)) {
      const answers = body.answers
        .filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === "object")
        .map((a) => ({
          question: typeof a.question === "string" ? a.question : "",
          answer: typeof a.answer === "string" ? a.answer : "",
          ...(typeof a.header === "string" ? { header: a.header } : {}),
        }));
      if (answers.length === 0) return c.json({ error: "'answers' must be a non-empty array" }, 400);
      payload = answers;
    } else {
      return c.json({ error: "body must include 'text' or 'answers'" }, 400);
    }
    await session.answer(payload);
    await deps.store.flush();
    return c.json(stateOf(session));
  });

  // Serve the built browser client last, so API routes always win. SPA fallback
  // routes unknown paths to index.html (client-side deep-links like ?session=).
  if (deps.staticDir) {
    const root = deps.staticDir;
    app.get("*", async (c) => {
      const file = resolveStatic(root, new URL(c.req.url).pathname);
      if (!file) return c.text("client not built (run `npm run build`)", 404);
      const data = await fs.promises.readFile(file);
      return new Response(data, { headers: { "content-type": STATIC_TYPES[path.extname(file)] ?? "application/octet-stream" } });
    });
  }

  return { app, manager };
}
