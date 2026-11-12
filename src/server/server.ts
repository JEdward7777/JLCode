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
import { base64Bytes, classifyFile } from "../tools/media.js";
import { textMimeFor } from "../tools/file-url.js";
import { agentConversationId, splitConversationId, type ConversationStore } from "../persist/conversation-store.js";
import { governingSwitch } from "../conversation/tree.js";
import { groupConfigsByKey, keyFingerprint } from "../config/operations.js";
import { ModelConfigMissingError } from "../session/types.js";
import type { DebugJournal } from "../persist/debug-journal.js";
import { SessionManager } from "../session/manager.js";
import { AgentCoordinator } from "../session/agents.js";
import type { Session } from "../session/session.js";
import type { AuthGuard } from "./auth.js";
import type { Logger } from "../logger.js";

export interface ServerDeps {
  /** Re-read the selected config on demand, so CLI edits are picked up live. */
  resolveConfig: () => ModelConfig | undefined;
  /** Build a fully-wired session (driver + tools + sandbox + gate); pass a
   *  loaded conversation to resume it. */
  newSession: (config: ModelConfig, conversation?: Conversation) => Session;
  /** Re-point an **open** session at a different config (X-40, D-82a). Called at
   *  the top of a user turn, so `jlcode config model` reaches a thread that is
   *  already running without a restart and without the CLI knowing this server
   *  exists. Omitted in tests that don't exercise the switch; without it a
   *  running thread simply keeps the config it started on. */
  retargetSession?: (session: Session, config: ModelConfig) => boolean;
  /** Every model config in the live store (X-56, D-87) — what the per-thread
   *  picker lists, grouped by key. **Never serialized as-is**: the routes that
   *  use it send fingerprints, not keys. Omitted → no picker routes. */
  listConfigs?: () => ModelConfig[];
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

/** What a static file may be cached as (D-80).
 *
 * The two halves are opposites and both matter. Vite content-hashes everything
 * under `assets/`, so those files are **immutable** — a changed build is a
 * changed name, and a year-long cache is free correctness. `index.html` is the
 * one file whose name never changes and whose whole job is to *name the current
 * hashes*, so it must be revalidated every load.
 *
 * Serving both with **no** cache headers at all — which is what this did — is
 * the worst of the two: with no `Cache-Control`, no `ETag` and no
 * `Last-Modified`, a browser falls back to heuristic caching and may reuse
 * `index.html` for as long as it likes. That pins a tab to a *previous* build's
 * asset hashes, which is exactly how a session paused correctly on the server
 * and rendered as `idle` in a browser running last week's client.
 */
function cacheControlFor(file: string): string {
  return /[\\/]assets[\\/]/.test(file) && path.extname(file) !== ".html"
    ? "public, max-age=31536000, immutable"
    : "no-cache"; // revalidate every load — index.html names the current build
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
      // Who sent it, when an agent did (D-88): the transcript draws agent
      // traffic as a card rather than as the person's own message (P9e).
      return entry.inbound ? { ...base, type: "user", text: entry.text, inbound: entry.inbound } : { ...base, type: "user", text: entry.text };
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
    case "model-switch":
      // The transcript marker's whole content (X-56, P9b): the snapshot, so a
      // switch to a config deleted since still says what it switched *to*.
      return { ...base, type: "model-switch", configId: entry.configId, snapshot: entry.snapshot };
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
  // `agent` places a sub-agent under its parent (D-88) — the rail nests by it
  // (P9e). A child is linked just after it joins the bag, so its `added` frame
  // has none yet; the `agent` event that follows supplies it.
  return { id: session.id, model: session.config.model, agent: session.agentInfo ?? null, state: stateOf(session) };
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

/** A deleted-config refusal as the browser sees it — the typed error's `code`
 *  is what P9b keys the inline picker off, not the message text. */
function missingView(err: ModelConfigMissingError | undefined): Record<string, unknown> | null {
  return err ? { code: err.code, configId: err.configId, snapshot: err.snapshot, message: err.message } : null;
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
    // Sub-agents (X-56, D-88): where this session sits in its tree, how the
    // agents below it stand — `waiting > 0` is the parent's "waiting for you"
    // flag, since a child's approvals go to the human, never to its parent —
    // and the whole tree's spend, which is what the spend cap measures (D-33).
    agent: session.agentInfo ?? null,
    subtree: session.subtree ?? null,
    // How the last turn came to rest — a sub-agent's dot reads "finished"
    // rather than "idle" from this (P9e, X-56 Q18). Null mid-turn.
    restedAs: session.restedAs,
    // How it stands at rest, read from the log (P9f): interrupted / owes-reply
    // / quiescent, null when not at rest. The rail's dot and Wake go by it.
    rest: session.restState,
    treeSpendUsd: session.treeSpendUsd,
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
    // Per-thread model (X-56, D-87): what this thread runs under, a switch
    // picked while busy, and — when its switch names a deleted config — the
    // refusal its next send will hit, so the picker can open before then.
    configId: session.config.id,
    configName: session.config.name,
    model: session.config.model,
    pendingModelSwitch: session.pendingModelSwitch ?? null,
    modelMissing: missingView(session.modelMissing),
    // The config governing the branch **in view** (P9b) — what the picker marks
    // current. Not `configId`: mid-turn that is the running turn's config, and
    // the reader may have moved to a sibling (H-05). Null when that branch's
    // switch names a deleted config.
    inViewConfigId: session.inViewConfig?.id ?? null,
  };
  // `approval` is the policy (above); the pending request rides separately so the
  // two don't collide.
  if (session.status === "awaiting-approval") base.approvalRequest = session.awaitingApproval;
  if (session.status === "awaiting-input") base.question = session.awaitingInput;
  if (session.status === "awaiting-compaction") base.compactionRequest = session.awaitingCompaction;
  if (session.status === "awaiting-continue") base.stallRequest = session.awaitingContinue;
  if (session.status === "awaiting-persistence") base.persistenceFault = session.awaitingPersistence;
  return base;
}

export function createServer(deps: ServerDeps): { app: Hono; manager: SessionManager; agents: AgentCoordinator } {
  const app = new Hono();
  const manager = new SessionManager();
  const listConfigs = (): ModelConfig[] => {
    if (deps.listConfigs) return deps.listConfigs();
    const only = deps.resolveConfig();
    return only ? [only] : [];
  };

  /**
   * Every thread is the root of an agent tree (X-56, D-88); a spawn grows it.
   * Sub-agents are ordinary sessions in the bag, persisted into their root's
   * file — `startAgent` is the one place that difference is wired.
   */
  const agents = new AgentCoordinator({
    listConfigs,
    startAgent: ({ config, conversation, rootId, record }) => {
      // The agent's own row goes into its tree's file ahead of its first entry
      // (the store's one queue per file keeps that order, D-37). Not awaited and
      // its rejection swallowed, like every projection write here: a failed
      // write surfaces through the store's fault listener, which stops the
      // session on that file (D-46) — that, not this promise, is the signal.
      if (record) void deps.store.agent(rootId, record).catch(() => {});
      return startSession(config, conversation, { agent: true });
    },
    agentRecords: (rootId) => deps.store.agents(rootId),
    loadConversation: (convId) => deps.store.load(convId),
    // Closed is a flag in the tree's file (P9f), written like every projection.
    setClosed: (rootId, agentId, closed) => void deps.store.agentClosed(rootId, agentId, closed).catch(() => {}),
    // So is a mode a parent set (P9f2): a revival reads it back.
    setMode: (rootId, agentId, mode) => void deps.store.agentMode(rootId, agentId, mode).catch(() => {}),
    writesPending: (convId) => deps.store.writesPending(convId),
    // A close — the person's or an agent's (`close_agent`) — unloads (Q20).
    onUnloaded: (sessions) => {
      for (const s of sessions) {
        manager.remove(s.id);
        dropFaultListener(s.id);
      }
    },
    onError: (err) => deps.logger?.error("agent turn failed to start", { err }),
  });

  /**
   * Pick up a model-config switch at **the top of a user turn** (X-40, D-82a).
   *
   * The server is the one that notices; the CLI knows nothing about it, which is
   * what deleted a pidfile, a liveness check and a whole category of state from
   * this design. `resolveConfig` already re-reads per new thread — this is the
   * same read at the other boundary where nothing is half-finished.
   *
   * **Idle only.** An `ask_user` or an approval pauses *mid-cycle*, with an
   * assistant message above it carrying signed reasoning from the outgoing
   * model; adopting a new model there would hand model B model A's signed
   * thinking, which is the shape D-28/D-38 forbid. `adoptConfig` re-checks this
   * for itself — it is stated in both places because one of them is the reason
   * the feature is safe.
   */
  const adoptLatestConfig = (session: Session, leaf: string | null = session.conversation.activeLeaf): void => {
    // `atIdlePoint`, not `status === "idle"`: a cap-blocked turn reads idle
    // with its branch still pinned, and resumes on a raise (D-33).
    if (!deps.retargetSession || !session.atIdlePoint) return;
    // A branch with a model-switch entry is the thread's own choice, and the
    // binding never moves it again (D-87) — `leaf` is the branch about to be
    // sent on, which an edit-fork names before it has moved the pointer.
    if (governingSwitch(session.conversation, leaf)) return;
    const latest = deps.resolveConfig();
    if (!latest) return; // nothing selected now → keep running under what we have
    deps.retargetSession(session, latest);
  };

  /**
   * The OpenRouter key a branch runs under (X-56 Q3) — what a cross-key switch
   * is measured *from*. Computed for the branch the switch would land on, never
   * from `session.config`, which is only the config of the last turn **run** and
   * can belong to a sibling branch the reader has since left.
   *
   * Switched branch → its config's key, read live. Switched to a config since
   * deleted → undefined: whatever key the session last held for it may predate
   * a rotation, and "always confirm" is never wrong. No switch → the binding's
   * key. Undefined is treated by every caller as "a different key": a
   * confirmation nobody needed beats a key change nobody confirmed.
   */
  const branchKey = (session: Session, leaf: string | null = session.conversation.activeLeaf): string | undefined => {
    const sw = governingSwitch(session.conversation, leaf);
    if (!sw) return deps.resolveConfig()?.openRouterKey;
    const live = deps.listConfigs?.().find((m) => m.id === sw.configId);
    return live?.openRouterKey;
  };

  /**
   * The config id a branch runs under, resolved exactly as {@link branchKey}
   * resolves its key: the governing switch's id (even a deleted one — then no
   * row is current), else the folder binding **read fresh**. Not
   * `session.inViewConfig`, which on an unswitched branch is the *held* config
   * until the next turn top adopts a re-bind (D-82a) — the picker's "current"
   * must name what the next send will actually run (P9b).
   */
  const branchConfigId = (session: Session, leaf: string | null = session.conversation.activeLeaf): string | undefined => {
    const sw = governingSwitch(session.conversation, leaf);
    return sw ? sw.configId : deps.resolveConfig()?.id;
  };

  // Outward-bind auth (D-40): guard every route + expose /auth/login. Installed
  // first so the middleware wraps all handlers below (localhost bind = no auth).
  deps.auth?.install(app);

  /** Each live session's store fault subscription (D-46), dropped when the
   *  session leaves the bag — a close, an agent's `close_agent` — so a
   *  close/reopen cycle cannot pile up listeners that pause dead sessions. */
  const faultListeners = new Map<string, () => void>();
  const dropFaultListener = (id: string): void => {
    faultListeners.get(id)?.();
    faultListeners.delete(id);
  };

  /** Build a session, register it, and wire persistence. Pass a loaded
   *  conversation to resume; otherwise a fresh conversation log is created. */
  function startSession(config: ModelConfig, conversation?: Conversation, opts: { agent?: boolean } = {}): Session {
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
    // A sub-agent writes into its root's file (D-88), so "its own log" is that.
    const ownLog = path.basename(deps.store.filePath(session.conversation.id));
    const ours = (filePath: string): boolean => {
      const base = path.basename(filePath);
      return base === ownLog || base === "index.jsonl";
    };
    faultListeners.set(session.id, deps.store.onFault((fault) => {
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
    }));

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
      // An agent message is on disk the moment it is sent, before the receiver
      // takes it in (X-56 Q15) — and so is the fact that one never will be.
      else if (e.type === "inbox") settled(deps.store.inbox(session.conversation.id, e.message));
      else if (e.type === "inbox-dropped") settled(deps.store.inboxDropped(session.conversation.id, e.ids));
      // "Don't ask again in this thread" (P9d) must outlive the process (D-89).
      else if (e.type === "rounds-off") settled(deps.store.roundsOff(session.conversation.id));
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
    if (!opts.agent) agents.adoptRoot(session);
    manager.add(session);
    // A root back from history brings its open sub-agents with it, at rest:
    // nothing starts on its own (X-56 Q15) — the rail shows what each was
    // doing, and Wake resumes them (P9f).
    if (conversation && !opts.agent) agents.loadTree(session);
    return session;
  }

  /**
   * A conversation's live session: the one already in the bag (attach, never
   * duplicate — the X-14 hazard), or a root loaded from disk with its open
   * tree. A sub-agent is reached through its root, never on its own (D-88).
   */
  function materialize(convId: string): { session: Session; materialized: boolean } | { error: string; status: 404 | 409 } {
    const live = manager.list().find((s) => s.conversation.id === convId);
    if (live) return { session: live, materialized: false };
    if (splitConversationId(convId).agent !== undefined) {
      return { error: "that conversation is a sub-agent; open its root thread to reach it", status: 409 };
    }
    const config = deps.resolveConfig();
    if (!config) return { error: "no model config selected for the server directory", status: 409 };
    const loaded = deps.store.load(convId);
    if (!loaded) return { error: "no such conversation", status: 404 };
    return { session: startSession(config, loaded), materialized: true };
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

  // Every model config, grouped by key, for the per-thread picker (X-56 Q3,
  // D-87). **Fingerprints, names and models only — never key bytes**: the full
  // key stays on this side, and grouping is done here on it so the browser has
  // no reason to want it. `?session=` marks (and leads with) that thread's group.
  app.get("/configs", (c) => {
    if (!deps.listConfigs) return c.json({ error: "config listing not supported" }, 404);
    const sessionId = c.req.query("session");
    const session = sessionId ? manager.get(sessionId) : undefined;
    if (sessionId && !session) return c.json({ error: "no such session" }, 404);
    return c.json({
      groups: groupConfigsByKey(deps.listConfigs(), session ? branchKey(session) : undefined),
      // The single source of truth for the picker's "current" row (P9b): fresh
      // on every open, so a CLI re-bind (which emits nothing) is reflected.
      currentConfigId: session ? (branchConfigId(session) ?? null) : null,
    });
  });

  // Switch a thread's model (X-56, D-87): `{configId, acknowledgeKeyChange?}`.
  // A config under a **different key** is refused unless the request says the
  // person confirmed it — every time, no "don't ask again" (Q3); the refusal
  // names both fingerprints so the confirm can. Busy → recorded pending and
  // written at the next idle point (Q4).
  app.post("/session/:id/model", async (c) => {
    const session = manager.get(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    if (!deps.listConfigs) return c.json({ error: "model switching not supported" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      configId?: unknown;
      acknowledgeKeyChange?: unknown;
      expectFrom?: unknown;
    };
    if (typeof body.configId !== "string") return c.json({ error: "body must include 'configId'" }, 400);
    const target = deps.listConfigs().find((m) => m.id === body.configId);
    if (!target) return c.json({ error: `no such model config: ${body.configId}` }, 404);
    const fromKey = branchKey(session);
    const fromPrint = fromKey === undefined ? null : keyFingerprint(fromKey);
    const acknowledged = body.acknowledgeKeyChange === true;
    // `expectFrom` is the "from" fingerprint the confirm *showed* (null = the
    // unknown key of a deleted config). If the branch in view has moved to
    // another key since — a pending pick landed, another tab rewound — the
    // acknowledgement is for a key change nobody was shown, so it is refused
    // like an unconfirmed one and the confirm re-renders from this answer.
    const stale = acknowledged && "expectFrom" in body && body.expectFrom !== fromPrint;
    if (target.openRouterKey !== fromKey && (!acknowledged || stale)) {
      return c.json(
        {
          error: "that model config uses a different OpenRouter key; confirm the key change to switch",
          code: "cross-key",
          from: fromPrint,
          to: keyFingerprint(target.openRouterKey),
        },
        409,
      );
    }
    let result: "applied" | "pending";
    try {
      // A pick made while busy lands later, on whatever branch is then in view:
      // it is only written there if that branch's key is still the one this
      // request was checked against — or is already the target's own.
      result = await session.switchModel(target.id, {
        accepts: (leaf) => {
          const landing = branchKey(session, leaf);
          return landing === target.openRouterKey || (acknowledged && landing === fromKey);
        },
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409);
    }
    await flushDurable();
    return c.json({ ...stateOf(session), switch: result });
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
    // Written to the config governing the branch in view (D-87) — skipped when
    // that config is gone, rather than landing in an unrelated one.
    const modeTarget = session.inViewConfig;
    if (modeTarget) deps.persistDefaults?.(modeTarget.name, { mode, approval });
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
    const triggerTarget = session.inViewConfig; // the in-view branch's config, as above
    if (triggerTarget) deps.persistDefaults?.(triggerTarget.name, { triggerMode: mode });
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
      try {
        await session.compactNow();
      } catch (err) {
        if (err instanceof ModelConfigMissingError) return c.json({ error: err.message, ...missingView(err) }, 409);
        throw err;
      }
    }
    await flushDurable();
    return c.json(stateOf(session));
  });

  // Resume a turn paused on the tool-round budget (D-79). Continue means "keep
  // going on double the budget", and the loop picks up at the model call it was
  // about to make — nothing was dropped to replay. `{dontAskAgain: true}` is the
  // card's third button (P9d, D-89): continue, and switch the pause off for this
  // thread and its sub-agents, logged so it survives a restart.
  app.post("/session/:id/continue", async (c) => {
    const session = manager.get(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { dontAskAgain?: unknown };
    if (session.status !== "awaiting-continue") return c.json({ error: "not paused for continue" }, 409);
    await session.continueRun({ dontAskAgain: body.dontAskAgain === true });
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
    await agents.setCap(session, cap); // the tree's cap, on every member (D-33)
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
    agents.stop(session, scope); // and every sub-agent below it (D-34)
    return c.json(stateOf(session));
  });

  // Re-attempt the current turn (D-57) — the Retry button. Valid after a failed
  // turn, after the breaker tripped, and against a request that looks hung; the
  // session decides which and rejects the rest. Nothing is appended either way,
  // so this is safe to fire twice.
  app.post("/session/:id/retry", async (c) => {
    const session = manager.get(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    // No `adoptLatestConfig` here: a retry resumes a cycle, so a re-bound folder
    // must not reach it (D-82a). `retry()` itself replaces a config that belongs
    // to another branch (D-87) — the one case where keeping it would be wrong.
    try {
      await session.retry();
    } catch (err) {
      if (err instanceof ModelConfigMissingError) return c.json({ error: err.message, ...missingView(err) }, 409);
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
    // The subtree goes with it (D-34): a sub-agent with no parent left in the
    // bag would be unreachable. Its log stays, and a message revives it.
    // A sub-agent is marked closed and stays in its parent's list (P9f).
    agents.close(session); // `onUnloaded` drops each from the bag
    await flushDurable();
    return c.json({ closed: true });
  });

  // Reopen a closed sub-agent (P9f, X-56 Q18) — a click on its grey row under
  // `:id`, its parent. Loads it (and its own open subtree) at rest.
  app.post("/session/:id/agent/:agentId/reopen", async (c) => {
    const parent = manager.get(c.req.param("id"));
    if (!parent) return c.json({ error: "no such session" }, 404);
    let reopened: Session;
    try {
      reopened = agents.reopen(parent, c.req.param("agentId"));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
    await flushDurable();
    return c.json({ sessionId: reopened.id, ...stateOf(reopened) });
  });

  // Wake (P9f, X-56 Q14): resume the interrupted and owing agents in this
  // session's subtree — itself included — and leave the rest asleep.
  app.post("/session/:id/wake", (c) => {
    const session = manager.get(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    return c.json({ wake: agents.wake(session), ...stateOf(session) });
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
      // An enqueue on an idle session opens a turn immediately, so it is the
      // same boundary /chat is (D-82a); mid-turn it changes nothing, because
      // `adoptLatestConfig` declines on anything but idle.
      adoptLatestConfig(session);
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
    // Idle, the branch in view is the one the next turn runs on, so the session
    // reports — and holds — that branch's model (D-87): the binding when it has
    // no switch, its own switch's config when it does. Mid-turn (or cap-blocked,
    // with a turn still pinned) nothing moves.
    session.resyncModel();
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
    // An edit opens a user turn too (D-82a), on the edited entry's parent — and
    // an edit above a thread's first switch is how it goes back to following
    // the binding (D-87), so the adoption is checked against *that* branch.
    const edited = session.conversation.entries.find((e) => e.id === body.entryId);
    if (edited) adoptLatestConfig(session, edited.parent);
    try {
      await session.editFork(body.entryId, body.text);
    } catch (err) {
      if (err instanceof ModelConfigMissingError) return c.json({ error: err.message, ...missingView(err) }, 409);
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
      // A sub-agent is reached through its tree, never revived on its own —
      // standing alone it would be a root with someone else's history (D-88).
      const got = materialize(body.conversationId);
      if ("error" in got) return c.json({ error: got.error }, got.status);
      session = got.session;
      materialized = got.materialized;
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
    // **One deliberate exception (D-87):** a branch whose model config was
    // deleted is refused by `send()` *after* this move, and the pointer stays on
    // it. That is the right place: the refusal opens the picker, and the pick is
    // written on `activeLeaf` — the branch the person asked to continue.
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

    // The config may have been switched under us since this thread's last
    // message (D-82a). A user turn is the boundary where that is safe.
    adoptLatestConfig(session);

    try {
      await session.send(body.text);
      await flushDurable(); // read-your-writes: entries durable before we respond
    } catch (err) {
      // `sessionId` rides along because this refusal can come from a session
      // this very request materialized (a history peek's first message): the
      // browser has to land on it to open the picker there (X-56, P9b).
      if (err instanceof ModelConfigMissingError) {
        return c.json({ error: err.message, ...missingView(err), sessionId: session.id }, 409);
      }
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

  // Bring a thread from history back live without saying anything (P9f): its
  // open sub-agents load with it, at rest, so the rail can show what each was
  // doing and Wake can resume them. Attaches if it is already live.
  app.post("/conversation/:id/open", (c) => {
    const got = materialize(c.req.param("id"));
    if ("error" in got) return c.json({ error: got.error }, got.status);
    return c.json({ sessionId: got.session.id, ...stateOf(got.session) });
  });

  // A tree's agents as its file records them (P9f): what history nests under a
  // root. Closed flags folded.
  app.get("/conversation/:id/agents", (c) => {
    const rootId = c.req.param("id");
    if (splitConversationId(rootId).agent !== undefined) return c.json({ error: "not a root thread" }, 400);
    const agentsOf = deps.store.agents(rootId).map((r) => ({
      agentId: r.agentId,
      parentAgentId: r.parentAgentId,
      name: r.name,
      depth: r.depth,
      closed: r.closed === true,
      conversationId: agentConversationId(rootId, r.agentId),
    }));
    return c.json({ agents: agentsOf });
  });

  // A persisted conversation, loaded from disk (distinct from a live /session).
  app.get("/conversation/:id", (c) => {
    const conv = deps.store.load(c.req.param("id"));
    if (!conv) return c.json({ error: "no such conversation" }, 404);
    return c.json({ id: conv.id, activeLeaf: conv.activeLeaf, entries: conv.entries.map((e) => entryView(e, conv.id)) });
  });

  // One shared file's bytes (X-43, D-83) — the deliberate opposite of the
  // attachment route above it. That one serves a **snapshot** the model looked
  // at, immutable because the tree is append-only. This one serves a **pointer**
  // to a file that is still on disk and may have moved, changed or grown a new
  // type since the agent named it, so nothing here may be cached hard and every
  // check is made again now rather than trusted from mint time.
  app.get("/conversation/:id/file/:token/:index", async (c) => {
    const convId = c.req.param("id");
    const token = c.req.param("token");
    const live = manager.list().find((sn) => sn.conversation.id === convId);
    const entries = live ? live.conversation.entries : deps.store.load(convId)?.entries;
    if (!entries) return c.json({ error: "no such conversation" }, 404);
    const index = Number(c.req.param("index"));
    if (!Number.isInteger(index) || index < 0) return c.json({ error: "no such file" }, 404);
    // A token addresses one `file_url` call; every file it minted carries it.
    const entry = entries.find((e) => e.type === "tool" && e.files?.some((f) => f.token === token));
    const file = entry && entry.type === "tool" ? entry.files?.[index] : undefined;
    if (!file || file.token !== token) return c.json({ error: "no such file" }, 404);

    // **Re-fence.** The mint happened in a session that may be long gone; a URL
    // must not outlive the workspace that authorized it, and a symlink swapped
    // in afterwards must not carry it outside either — hence realpath now, not
    // the string recorded then.
    let real: string;
    try {
      real = fs.realpathSync(file.resolved);
    } catch {
      return c.json({ error: "file is gone" }, 404);
    }
    const root = file.fenceRoot;
    if (real !== root && !real.startsWith(root + path.sep)) return c.json({ error: "outside the workspace" }, 404);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(real);
    } catch {
      return c.json({ error: "file is gone" }, 404);
    }
    if (!stat.isFile()) return c.json({ error: "not a regular file" }, 404);

    // The bytes decide what this is *now* (D-78b). A file that has become a
    // binary since it was shared is refused rather than served under the mime it
    // used to have — which is also what keeps a swapped-in SVG on the text path.
    const kind = await classifyFile(real);
    if (kind.kind === "binary") return c.json({ error: "no longer a viewable file" }, 404);
    const mime = kind.kind === "image" ? kind.mime : textMimeFor(real);

    const bytes = await fs.promises.readFile(real);
    return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
      headers: {
        "content-type": mime,
        "content-length": String(bytes.byteLength),
        // Not `immutable`: the file can change under a URL that stays valid.
        "cache-control": "private, no-cache",
        "x-content-type-options": "nosniff",
      },
    });
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

  // Answer a pending question (D-18) — the `ask` tool, `ask_user` before P9d:
  // either {text} for a single-question form, or {answers:[{question, answer,
  // header?}]} for a multi-question form. The person answers any question, one
  // a sub-agent addressed to its parent agent included: they outrank every
  // agent (X-56 Q16).
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
      return new Response(data, {
        headers: {
          "content-type": STATIC_TYPES[path.extname(file)] ?? "application/octet-stream",
          "cache-control": cacheControlFor(file),
        },
      });
    });
  }

  return { app, manager, agents };
}
