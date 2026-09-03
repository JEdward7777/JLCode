/**
 * The dev HTTP endpoint for driving conversations (Phase 5 groundwork). Each
 * request is one-shot; the server retains threads by session id. With tools
 * wired in (Phase 3b), a turn can pause for **approval** (D-16) or **ask_user**
 * (D-18) — the response reports the awaiting state, and /approve or /answer
 * resumes. Streaming (SSE), the browser UI, and auth arrive with full Phase 5.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ApprovalPolicy, CompactionTrigger, Mode, ModelConfig } from "../config/types.js";
import { APPROVAL_POLICIES, MODES } from "../config/types.js";

/** The five compaction trigger modes (D-27). Validated on the mode-switch route. */
const TRIGGER_MODES: readonly CompactionTrigger[] = ["auto", "manual", "suggest", "cancelable", "hard"];
import type { AskUserAnswer, LearnAnswers, SessionEvent } from "../session/types.js";
import type { McpServerStatus } from "../mcp/client.js";
import type { Conversation, Entry } from "../conversation/types.js";
import { base64Bytes } from "../tools/media.js";
import type { ConversationStore } from "../persist/conversation-store.js";
import type { DebugJournal } from "../persist/debug-journal.js";
import { SessionManager } from "../session/manager.js";
import type { Session } from "../session/session.js";
import type { AuthGuard } from "./auth.js";
import type { Logger } from "../logger.js";

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
  persistDefaults?: (
    configName: string,
    patch: { mode?: Mode; approval?: ApprovalPolicy; triggerMode?: CompactionTrigger },
  ) => void;
  /** Optional: directory of the built browser client (dist/web). When set, a
   *  catch-all serves it (SPA fallback to index.html). Omitted in tests. */
  staticDir?: string;
  /** Optional: an auth guard installed ahead of every route (D-40). Present when
   *  bound outward (non-loopback); absent on a localhost bind = no auth. */
  auth?: AuthGuard;
  /** Optional diagnostic logger (D-11). Persistence faults are logged at ERROR
   *  here as well as surfaced in the UI, so a dropped write leaves a trace (D-46). */
  logger?: Pick<Logger, "error" | "warn">;
  /** Optional: live MCP server status for `GET /mcp` (P7b). Read-only — the
   *  settings files stay the source of truth, edited by hand or by `jlcode mcp`. */
  mcpStatus?: () => { servers: McpServerStatus[]; problems: string[]; files: { global: string; workspace: string } };
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

/**
 * Where the browser fetches one attachment's bytes (P8e, D-78j).
 *
 * Addressed by **conversation**, not by session, because history is read
 * straight from disk with no session in sight — one route then serves a live
 * thread and an old one identically, which is the X-11 property that a live
 * entry and a loaded one must render the same way.
 */
function attachmentUrl(convId: string, entryId: string, index: number): string {
  return `/conversation/${encodeURIComponent(convId)}/attachment/${encodeURIComponent(entryId)}/${index}`;
}

/** The browser's view of an entry. `convId` is only needed to address
 *  attachments; an entry with none renders exactly as it always did. */
function entryView(entry: Entry, convId?: string): Record<string, unknown> {
  const base = { id: entry.id, parent: entry.parent }; // ids for fork/rewind navigation
  switch (entry.type) {
    case "user":
      return { ...base, type: "user", text: entry.text };
    case "assistant":
      return {
        ...base,
        type: "assistant",
        text: entry.text,
        // The call `id` rides along so the transcript can pair a tool result with
        // the arguments it was called on (X-11) — the args live only here.
        toolCalls: entry.toolCalls?.map((t) => ({ id: t.id, name: t.function.name, arguments: t.function.arguments })),
        reasoningText: entry.reasoningText,
        truncated: entry.truncated ?? false,
        finishReason: entry.finishReason,
      };
    case "tool":
      return {
        ...base,
        type: "tool",
        toolCallId: entry.toolCallId,
        name: entry.name,
        content: entry.content,
        isError: entry.isError ?? false,
        // **Metadata and a URL, never the bytes** (D-78j). A data URI here would
        // ride the multiplexed bus (D-43) to every open tab on every entry
        // frame, re-ship on every reload, and be uncacheable — for a blob the
        // browser can fetch once, lazily, and keep. The size travels so the
        // transcript can say what is loading before it has loaded.
        ...(entry.attachments && entry.attachments.length > 0 && convId
          ? {
              attachments: entry.attachments.map((a, i) => ({
                mime: a.mime,
                bytes: base64Bytes(a.data),
                ...(a.name ? { name: a.name } : {}),
                url: attachmentUrl(convId, entry.id, i),
              })),
            }
          : {}),
      };
    case "compaction":
      return { ...base, type: "compaction", summary: entry.summary };
    case "todo":
      // The transcript marks *that* the list changed and who changed it (X-31);
      // the list itself is a panel, not a message, and ships on the state frame.
      return { ...base, type: "todo", by: entry.by };
  }
}

/** Project a session event for the browser. `entry` events carry the **raw** tree
 *  node because the persistence projection needs it verbatim (D-37) — but the
 *  wire should ship the same trimmed shape as `GET /session/:id`, so a live entry
 *  and a loaded one render identically (X-11), and the opaque signed reasoning
 *  blobs (D-14) stay server-side instead of being pushed to every tab. */
function wireEvent(e: SessionEvent, convId: string): unknown {
  return e.type === "entry" ? { ...e, entry: entryView(e.entry, convId) } : e;
}

/** A session's roster descriptor for the multiplexed bus (D-43): identity + its
 *  current settled state, so the rail can draw a badge without loading the tree. */
function sessionDescriptor(session: Session): Record<string, unknown> {
  return { id: session.id, model: session.config.model, state: stateOf(session) };
}


/** Answers to the questions an approval pause carried (D-48), off the wire. */
function parseLearned(raw: unknown): LearnAnswers | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const body = raw as { writes?: unknown; fields?: unknown };
  const out: LearnAnswers = {};
  if (typeof body.writes === "boolean") out.writes = body.writes;
  if (typeof body.fields === "object" && body.fields !== null) {
    const fields: Record<string, boolean> = {};
    for (const [field, value] of Object.entries(body.fields as Record<string, unknown>)) {
      if (typeof value === "boolean") fields[field] = value;
    }
    if (Object.keys(fields).length > 0) out.fields = fields;
  }
  return out.writes === undefined && out.fields === undefined ? undefined : out;
}

/** Build the response describing the session's current settled state. */
function stateOf(session: Session): Record<string, unknown> {
  const entries = session.conversation.entries;
  const lastAssistant = [...entries].reverse().find((e) => e.type === "assistant");
  const budget = session.compactionBudget();
  const base: Record<string, unknown> = {
    sessionId: session.id,
    conversationId: session.conversation.id,
    title: session.conversation.title ?? null, // the thread's label (X-09)
    status: session.status,
    mode: session.mode,
    approval: session.approval,
    spendUsd: session.spendUsd,
    spendCapUsd: session.spendCapUsd ?? null,
    capReached: session.capReached,
    tasks: session.taskList,
    queue: session.queuedMessages,
    todos: session.todos, // the shared list, folded from this branch's ops (X-31)
    triggerMode: session.triggerMode, // live compaction trigger mode (D-27, P6c)
    needsCompaction: session.needsCompaction, // budget crossed (drives the suggest banner)
    // The window compaction is measured against, and where it came from (D-44c).
    // `source` rides along so the UI can mark an assumed window as a guess
    // rather than presenting it as looked-up (H-06).
    contextWindow: budget?.window ?? null,
    contextThreshold: budget?.threshold ?? null,
    contextWindowSource: session.contextWindowSource ?? null,
    // How full the window is right now, for the context meter (X-24). 0 means
    // "not measured yet" (fresh / just-compacted branch), not "empty".
    contextTokens: session.contextTokens,
    retryable: session.retryable, // the last turn failed and can be re-sent as-is (D-57)
    reply: lastAssistant && lastAssistant.type === "assistant" ? lastAssistant.text : "",
  };
  // `approval` is the policy (above); the pending request rides separately so the
  // two don't collide.
  if (session.status === "awaiting-approval") base.approvalRequest = session.awaitingApproval;
  if (session.status === "awaiting-input") base.question = session.awaitingInput;
  if (session.status === "awaiting-compaction") base.compactionRequest = session.awaitingCompaction;
  if (session.status === "awaiting-persistence") base.persistenceFault = session.awaitingPersistence;
  return base;
}

export function createServer(deps: ServerDeps): { app: Hono; manager: SessionManager } {
  const app = new Hono();
  const manager = new SessionManager();

  // Outward-bind auth (D-40): guard every route + expose /auth/login. Installed
  // first so the middleware wraps all handlers below (localhost bind = no auth).
  deps.auth?.install(app);

  /** Build a session, register it, and wire persistence. Pass a loaded
   *  conversation to resume; otherwise a fresh conversation log is created. */
  function startSession(config: ModelConfig, conversation?: Conversation): Session {
    const session = deps.newSession(config, conversation);

    /** A stalled write is reported by the store's fault listener, **not** by the
     *  append promise: on failure the record stays queued at the head (so a retry
     *  preserves order), leaving that promise pending until it lands or is
     *  discarded. So `settled` exists only to keep an explicit discard from
     *  surfacing as an unhandled rejection — the real signal is below (D-46). */
    const settled = (p: Promise<void>): void => {
      void p.catch(() => {});
    };

    // Stop this session on a write failure to its own log — or to the shared
    // index, where a full disk means nothing can be trusted to persist (D-46).
    const ours = (filePath: string): boolean => {
      const base = path.basename(filePath);
      return base === `${session.conversation.id}.jsonl` || base === "index.jsonl";
    };
    deps.store.onFault((fault) => {
      if (!ours(fault.filePath)) return;
      deps.logger?.error("persistence write failed", {
        conversationId: session.conversation.id,
        filePath: fault.filePath,
        pending: fault.pending,
        err: fault.error,
      });
      session.raisePersistenceFault({
        filePath: fault.filePath,
        message: fault.error.message,
        pending: fault.pending,
      });
    });

    // The conversation log is created **lazily, on first content** (X-12b).
    // Creating it eagerly meant opening a session and never typing into it still
    // wrote an index row, so history filled with untitled stubs that have nothing
    // to peek at and nothing to auto-title from. Deferring is the honest fix —
    // an abandoned thread leaves no trace at all, rather than a row we then hide.
    //
    // Safe because nothing reads the index during the live-but-silent window: the
    // browser filters live conversations *out* of its HISTORY list, and both the
    // peek and `/chat`'s revival fallback read the conversation **log**, not the
    // index. Any entry implies a user entry above it, so "first entry" and the
    // agreed definition of empty (no user and no assistant entries) coincide.
    let created = Boolean(conversation); // a resumed conversation is already on disk
    const ensureCreated = (): void => {
      if (created) return;
      created = true;
      settled(deps.store.create({ id: session.conversation.id, workingDir: deps.workingDir, configName: config.name }));
    };
    session.onEvent((e) => {
      if (e.type === "entry") {
        ensureCreated(); // issued first, so the header leads the log
        settled(deps.store.entry(session.conversation.id, e.entry));
      } else if (e.type === "active-leaf") settled(deps.store.activeLeaf(session.conversation.id, e.leaf));
      else if (e.type === "title") {
        // A hand-rename can land before the first message. Records fold by id
        // rather than by order, so this only has to make the row exist.
        ensureCreated();
        settled(deps.store.title(session.conversation.id, e.title, e.source));
      } else if (e.type === "debug" && deps.debugJournal) {
        // The journal is diagnostic and never replayed to a model, so a failure
        // here is a warning — not worth stopping the session over (D-46).
        void deps.debugJournal.record(session.conversation.id, e.record).catch((err: unknown) => {
          deps.logger?.warn("debug journal write failed", { conversationId: session.conversation.id, err });
        });
      }
    });
    return manager.add(session);
  }

  /** Read-your-writes flush. `store.flush()` now rejects when a write is stalled
   *  (D-46) rather than resolving green — swallow that here so the route still
   *  answers: the session has already been put into `awaiting-persistence` by the
   *  fault listener, and the response carries that state, which is more useful to
   *  the client than a bare 500. */
  async function flushDurable(): Promise<void> {
    await deps.store.flush().catch(() => {});
  }

  /** Recover from a stalled write (D-46). `{discard: true}` gives up on the
   *  unwritten records and accepts the loss; otherwise the writes are retried and
   *  the session resumes only if they land. */
  app.post("/session/:id/persistence", async (c) => {
    const session = manager.get(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    if (session.status !== "awaiting-persistence") return c.json({ error: "no pending persistence fault" }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { discard?: unknown };
    if (body.discard === true) {
      const discarded = session.discardPersistence(() => deps.store.discardPending());
      deps.logger?.warn("persistence records discarded by the user", {
        conversationId: session.conversation.id,
        discarded,
      });
      return c.json({ ...stateOf(session), discarded });
    }
    const ok = await session.retryPersistence(() => deps.store.retry());
    return c.json({ ...stateOf(session), recovered: ok });
  });

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
      // The workspace this instance serves (X-10). Per *instance*, not per
      // conversation — which is why it rides on /config. `homeDir` lets the
      // browser abbreviate it to `~/…`; only this side knows the home path.
      workingDir: deps.workingDir,
      homeDir: os.homedir(),
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
        queue.push(wireEvent(e, session.conversation.id));
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

  // SSE down, multiplexed (D-43): every session's events on one connection,
  // tagged with `sessionId`, plus added/removed lifecycle frames. This is the
  // instance-level bus the multi-session UI subscribes to (and the shape the
  // future fleet aggregator, §18, will fan in). A first `roster` frame lists all
  // live sessions with their settled state; subscribe before snapshotting so no
  // add is missed (the client dedupes by id).
  app.get("/events", (c) => {
    return streamSSE(c, async (stream) => {
      const queue: unknown[] = [];
      let wake: (() => void) | null = null;
      const bump = () => {
        const w = wake;
        wake = null;
        w?.();
      };
      const unsub = manager.subscribe((frame) => {
        if (frame.kind === "event")
          queue.push({
            type: "session-event",
            sessionId: frame.sessionId,
            // The conversation id is only needed to address attachments; a
            // session that has just been removed has no entries left to ship.
            event: wireEvent(frame.event, manager.get(frame.sessionId)?.conversation.id ?? ""),
          });
        else if (frame.kind === "added") queue.push({ type: "session-added", session: sessionDescriptor(frame.session) });
        else queue.push({ type: "session-removed", sessionId: frame.sessionId });
        bump();
      });
      stream.onAbort(() => {
        unsub();
        bump();
      });
      queue.push({ type: "roster", sessions: manager.list().map(sessionDescriptor) });
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
      conversationId: session.conversation.id, // for the debug-journal fetch (D-15)
      title: session.conversation.title ?? null, // thread label (X-09)
      status: session.status,
      model: session.config.model,
      mode: session.mode,
      approval: session.approval,
      activeLeaf: session.conversation.activeLeaf,
      entries: session.conversation.entries.map((e) => entryView(e, session.conversation.id)),
    });
  });

  // The session's settled state on demand — the same shape every action response
  // and roster frame carries, pauses included. `GET /session/:id` deliberately
  // answers with the *tree* (entries + leaf) and omits the pending request, so it
  // cannot be used to re-sync a browser that has lost track of a pause: folding
  // it through `applyState` would clear the very card you are trying to recover.
  // This is that seam — one authoritative answer to "what is actually true?",
  // for a client whose POST failed and no longer trusts its own copy (X-21/D-57).
  app.get("/session/:id/state", (c) => {
    const session = manager.get(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    return c.json(stateOf(session));
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

  // Rename the thread (X-09): {title}. The auto-title runs once after the first
  // exchange; this is the hand-edit, and it pins — auto never overwrites it.
  app.post("/session/:id/title", async (c) => {
    const session = manager.get(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { title?: unknown };
    if (typeof body.title !== "string" || body.title.trim() === "") return c.json({ error: "title is required" }, 400);
    try {
      session.setTitle(body.title, "manual"); // the event drives persistence
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    await deps.store.flush(); // read-your-writes, like the other mutating routes
    return c.json(stateOf(session));
  });

  // Switch the live compaction trigger mode (D-27, P6c): {mode}. Re-resolves the
  // session's mode immediately and persists it as the config default (like
  // mode/approval). Body must name one of the five modes.
  app.post("/session/:id/trigger-mode", async (c) => {
    const session = manager.get(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { mode?: unknown };
    const mode = body.mode as CompactionTrigger;
    if (!TRIGGER_MODES.includes(mode)) return c.json({ error: `invalid trigger mode: ${String(body.mode)}` }, 400);
    session.setTriggerMode(mode);
    deps.persistDefaults?.(session.config.name, { triggerMode: mode });
    return c.json(stateOf(session));
  });

  // Compaction control (D-27, P6c): resolve a pending pre-send pause, or compact
  // on demand. Body {skip:true} skips a `cancelable` pause; otherwise it compacts
  // (a pause resolution, or an out-of-band manual/suggest "Compact now").
  app.post("/session/:id/compact", async (c) => {
    const session = manager.get(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { skip?: unknown };
    const skip = body.skip === true;
    if (session.status === "awaiting-compaction") {
      await session.resolveCompaction(skip);
    } else {
      await session.compactNow();
    }
    await flushDurable();
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
    await flushDurable();
    return c.json(stateOf(session));
  });

  // Global stop (D-34): {scope: "hard"|"soft"}. hard = abort LLM + kill tasks +
  // clear queue; soft = let running commands finish but take no further LLM turn.
  app.post("/session/:id/stop", async (c) => {
    const session = manager.get(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { scope?: unknown };
    const scope = body.scope === "soft" ? "soft" : "hard"; // default to the big red button
    session.stop(scope);
    return c.json(stateOf(session));
  });

  // Re-attempt the current turn (D-57) — the Retry button. Valid after a failed
  // turn, after the breaker tripped, and against a request that looks hung; the
  // session decides which and rejects the rest. Nothing is appended either way,
  // so this is safe to fire twice.
  app.post("/session/:id/retry", async (c) => {
    const session = manager.get(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    try {
      await session.retry();
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409);
    }
    return c.json(stateOf(session));
  });

  // Close a session (D-43): hard-stop it (abort the LLM, kill tasks, clear the
  // queue) and drop it from the bag so it stops appearing in the roster. The
  // conversation stays on disk (recoverable from history); the manager emits a
  // `removed` frame so every subscribed browser drops its tab.
  app.post("/session/:id/close", async (c) => {
    const session = manager.get(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    session.stop("hard");
    manager.remove(session.id);
    await flushDurable();
    return c.json({ closed: true });
  });

  // Kill one background task (D-34) — the per-task Kill button.
  app.post("/session/:id/task/:taskId/kill", (c) => {
    const session = manager.get(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const killed = session.killTask(c.req.param("taskId"));
    if (!killed) return c.json({ error: "no such running task" }, 404);
    return c.json(stateOf(session));
  });

  // Queued message (D-34): {text} enqueues; {queue:[{text}]} replaces the whole
  // pending list (the edit/cancel affordance).
  app.post("/session/:id/queue", async (c) => {
    const session = manager.get(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown; queue?: unknown };
    if (Array.isArray(body.queue)) {
      const msgs = body.queue
        .filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === "object")
        .map((m) => ({ text: typeof m.text === "string" ? m.text : "" }))
        .filter((m) => m.text.trim() !== "");
      session.setQueue(msgs);
    } else if (typeof body.text === "string" && body.text.trim() !== "") {
      await session.enqueue(body.text);
    } else {
      return c.json({ error: "body must include a non-empty 'text' or a 'queue' array" }, 400);
    }
    await flushDurable();
    return c.json(stateOf(session));
  });

  // The person's todo-list commit (X-31) — the whole list as they left edit
  // mode, not a keystroke stream: that is what "leaving edit mode" means, and it
  // is the one moment they are the authority on what the list says. An unchanged
  // list is a no-op down to the queued nudge, so opening the editor and closing
  // it again costs the agent nothing.
  app.put("/session/:id/todos", async (c) => {
    const session = manager.get(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { items?: unknown };
    if (!Array.isArray(body.items)) return c.json({ error: "body must include an 'items' array" }, 400);
    const rows = body.items
      .filter((i): i is Record<string, unknown> => Boolean(i) && typeof i === "object")
      .map((i) => ({
        id: typeof i.id === "string" ? i.id : undefined,
        text: typeof i.text === "string" ? i.text : "",
        done: i.done === true,
        // Absent means "leave the note alone" — a client that knows nothing of
        // notes must not erase them by saving (D-77).
        note: typeof i.note === "string" ? i.note : undefined,
      }));
    const changed = await session.setTodos(rows);
    await flushDurable();
    return c.json({ ...stateOf(session), changed });
  });

  // Rewind / switch branch: point the active leaf at an existing entry (D-10).
  // Passive by design (SPEC §27) and safe mid-turn — the running turn appends to
  // the branch it started on, not to whatever this points at (H-05).
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
    await flushDurable();
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
    await flushDurable();
    return c.json(stateOf(session));
  });

  app.post("/chat", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      text?: unknown;
      sessionId?: unknown;
      conversationId?: unknown;
      leaf?: unknown;
    };
    if (typeof body.text !== "string" || body.text.trim() === "") {
      return c.json({ error: "body must include a non-empty 'text'" }, 400);
    }

    let session: Session | undefined;
    let materialized = false; // did this request revive the conversation?
    if (typeof body.sessionId === "string") session = manager.get(body.sessionId);

    // Fall back to the conversation when the session id misses (X-12). This is
    // what makes a history peek's first message materialize a session — and what
    // heals a stale browser tab whose session died with a previous process.
    if (!session && typeof body.conversationId === "string") {
      // **Attach, don't duplicate.** A conversation already live in the bag is
      // reused: two Session objects over independent in-memory copies of one
      // tree, both appending to one log, is the X-14 hazard. Attaching also
      // makes revival idempotent, so two stale tabs converge instead of forking.
      session = manager.list().find((s) => s.conversation.id === body.conversationId);
      if (!session) {
        const config = deps.resolveConfig();
        if (!config) return c.json({ error: "no model config selected for the server directory" }, 409);
        const loaded = deps.store.load(body.conversationId);
        if (!loaded) return c.json({ error: "no such conversation" }, 404);
        session = startSession(config, loaded); // resume from disk
        materialized = true;
      }
    }

    if (!session) {
      if (typeof body.sessionId === "string") return c.json({ error: "no such session" }, 404);
      const config = deps.resolveConfig();
      if (!config) return c.json({ error: "no model config selected for the server directory" }, 409);
      session = startSession(config); // fresh
    }

    // Continue from a chosen branch rather than the persisted leaf (X-12): the
    // peek's branch arrows are how you find the point you want to continue from,
    // so the leaf you were *looking at* has to be the one you continue. Moving
    // the leaf is safe under a running turn now (H-05 pins the turn to its own
    // branch), but *sending* is not — `send()` would refuse below, and a refused
    // send must not leave the pointer moved. So check before touching it.
    if (typeof body.leaf === "string" && body.leaf !== session.conversation.activeLeaf) {
      if (!materialized && session.status !== "idle") {
        return c.json({ error: "session is busy; queue the message instead" }, 409);
      }
      try {
        session.setActiveLeaf(body.leaf);
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }
    }

    try {
      await session.send(body.text);
      await flushDurable(); // read-your-writes: entries durable before we respond
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
    return c.json({ id: conv.id, activeLeaf: conv.activeLeaf, entries: conv.entries.map((e) => entryView(e, conv.id)) });
  });

  // One attachment's bytes (P8e, D-78j) — the door images come through, kept
  // deliberately separate from the transcript JSON they are named in.
  //
  // **Live session first, disk second.** Persistence is asynchronous off the
  // `entry` event, so a browser that has just been told about a tool result over
  // SSE can ask for its image before the log has been written; the in-memory
  // tree always has it. History has no session at all, which is the other half.
  //
  // Immutable by construction — the tree is append-only (D-37) and an entry is
  // never rewritten — so the response says so and the browser stops asking.
  app.get("/conversation/:id/attachment/:entryId/:index", (c) => {
    const convId = c.req.param("id");
    const live = manager.list().find((sn) => sn.conversation.id === convId);
    const entries = live ? live.conversation.entries : deps.store.load(convId)?.entries;
    if (!entries) return c.json({ error: "no such conversation" }, 404);
    const entry = entries.find((e) => e.id === c.req.param("entryId"));
    if (!entry || entry.type !== "tool") return c.json({ error: "no such entry" }, 404);
    const index = Number(c.req.param("index"));
    const att = Number.isInteger(index) ? entry.attachments?.[index] : undefined;
    if (!att) return c.json({ error: "no such attachment" }, 404);
    const bytes = Buffer.from(att.data, "base64");
    return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
      headers: {
        "content-type": att.mime,
        "content-length": String(bytes.byteLength),
        "cache-control": "private, max-age=31536000, immutable",
        // The mime is our own sniff (D-78b), not the producer's claim — but a
        // browser that re-sniffs could still find HTML in a crafted polyglot, so
        // it is told not to.
        "x-content-type-options": "nosniff",
      },
    });
  });

  // Rename a thread from its history row (X-12b): {title}. The rail's rename is
  // `/session/:id/title` and needs a live session; this one is addressed by
  // *conversation*, so a thread nobody has open can still be named.
  //
  // **Route through the session when one holds this conversation.** Writing
  // straight to the store would leave that session's in-memory title stale and
  // its rail card showing the old name until a reload.
  app.post("/conversation/:id/title", async (c) => {
    const convId = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { title?: unknown };
    if (typeof body.title !== "string" || body.title.trim() === "") return c.json({ error: "title is required" }, 400);
    const live = manager.list().find((s) => s.conversation.id === convId);
    if (live) {
      try {
        live.setTitle(body.title, "manual"); // the event drives persistence
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }
    } else {
      if (!deps.store.load(convId)) return c.json({ error: "no such conversation" }, 404);
      await deps.store.title(convId, body.title, "manual");
    }
    await flushDurable(); // read-your-writes: the next /conversations sees it
    return c.json({ id: convId, title: body.title });
  });

  // Delete a thread from history (X-12b) — a **reversible masking flag** in the
  // index, never an unlink (see `store.setDeleted`). `DELETE` names what the user
  // is doing; that it is implemented by masking is ours to keep, and it is what
  // makes an oops recoverable by hand-flipping one line in `index.jsonl`.
  //
  // Restoring has no route on purpose: the agreed recovery path is editing that
  // file, so a second endpoint would be a surface with no caller.
  app.delete("/conversation/:id", async (c) => {
    const convId = c.req.param("id");
    if (!deps.store.load(convId)) return c.json({ error: "no such conversation" }, 404);
    await deps.store.setDeleted(convId);
    await flushDurable();
    return c.json({ id: convId, deleted: true });
  });

  // The verbose debug journal for a conversation — the "Halp!" record (D-15).
  // MCP servers as they stand right now (P7b): state, discovered tools with
  // their live gate class, and what the user has taught JLCode (D-47d/D-48).
  app.get("/mcp", (c) => {
    if (!deps.mcpStatus) return c.json({ servers: [], problems: [], files: null, enabled: false });
    return c.json({ ...deps.mcpStatus(), enabled: true });
  });

  app.get("/conversation/:id/journal", (c) => {
    if (!deps.debugJournal) return c.json({ error: "no debug journal" }, 404);
    return c.json({ records: deps.debugJournal.read(c.req.param("id")) });
  });

  // Resolve a pending approval: {approve: bool, editedArgs?, reason?, note?} (D-16/D-51).
  app.post("/session/:id/approve", async (c) => {
    const session = manager.get(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    if (session.status !== "awaiting-approval") return c.json({ error: "not awaiting approval" }, 409);
    const body = (await c.req.json().catch(() => ({}))) as {
      approve?: unknown;
      editedArgs?: unknown;
      reason?: unknown;
      note?: unknown;
      addRoot?: unknown;
      learned?: unknown;
    };
    await session.approve({
      approve: body.approve !== false,
      note: typeof body.note === "string" ? body.note : undefined,
      learned: parseLearned(body.learned),
      editedArgs:
        body.editedArgs && typeof body.editedArgs === "object"
          ? (body.editedArgs as Record<string, unknown>)
          : undefined,
      reason: typeof body.reason === "string" ? body.reason : undefined,
      addRoot:
        typeof body.addRoot === "string" || typeof body.addRoot === "boolean" ? body.addRoot : undefined,
    });
    await flushDurable();
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
        .map((a) => {
          // `chosen`/`typed`/`declined` are D-72 provenance: which of the offered
          // options was picked, what was typed instead, or that nothing was said.
          // All optional — a plain-text frontend still posts `answer` alone, and a
          // blank one reads as a decline rather than as the empty string.
          const chosen = Array.isArray(a.chosen) ? a.chosen.filter((o): o is string => typeof o === "string") : [];
          const typed = typeof a.typed === "string" ? a.typed : "";
          const answer = typeof a.answer === "string" ? a.answer : "";
          const declined = a.declined === true || (chosen.length === 0 && !typed.trim() && !answer.trim());
          return {
            question: typeof a.question === "string" ? a.question : "",
            answer,
            ...(typeof a.header === "string" ? { header: a.header } : {}),
            ...(chosen.length > 0 ? { chosen } : {}),
            ...(typed ? { typed } : {}),
            ...(declined ? { declined: true } : {}),
          };
        });
      if (answers.length === 0) return c.json({ error: "'answers' must be a non-empty array" }, 400);
      payload = answers;
    } else {
      return c.json({ error: "body must include 'text' or 'answers'" }, 400);
    }
    try {
      await session.answer(payload);
    } catch (err) {
      // A `required` question left blank (D-72) — the only refusal `answer()` has.
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    await flushDurable();
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
