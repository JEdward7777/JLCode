/**
 * The dev HTTP endpoint for driving conversations (Phase 5 groundwork). Each
 * request is one-shot; the server retains threads by session id. With tools
 * wired in (Phase 3b), a turn can pause for **approval** (D-16) or **ask_user**
 * (D-18) — the response reports the awaiting state, and /approve or /answer
 * resumes. Streaming (SSE), the browser UI, and auth arrive with full Phase 5.
 */
import { Hono } from "hono";
import type { ModelConfig } from "../config/types.js";
import type { Entry } from "../conversation/types.js";
import { SessionManager } from "../session/manager.js";
import type { Session } from "../session/session.js";

export interface ServerDeps {
  /** Re-read the selected config on demand, so CLI edits are picked up live. */
  resolveConfig: () => ModelConfig | undefined;
  /** Build a fully-wired session (driver + tools + sandbox + gate) for a config. */
  newSession: (config: ModelConfig) => Session;
  version: string;
  /** Optional: called by POST /shutdown so a caller can stop the dev server. */
  onShutdown?: () => void;
}

function entryView(entry: Entry): Record<string, unknown> {
  switch (entry.type) {
    case "user":
      return { type: "user", text: entry.text };
    case "assistant":
      return {
        type: "assistant",
        text: entry.text,
        toolCalls: entry.toolCalls?.map((t) => ({ name: t.function.name, arguments: t.function.arguments })),
        reasoningText: entry.reasoningText,
        truncated: entry.truncated ?? false,
        finishReason: entry.finishReason,
      };
    case "tool":
      return { type: "tool", name: entry.name, content: entry.content, isError: entry.isError ?? false };
    case "compaction":
      return { type: "compaction", summary: entry.summary };
  }
}

/** Build the response describing the session's current settled state. */
function stateOf(session: Session): Record<string, unknown> {
  const entries = session.conversation.entries;
  const lastAssistant = [...entries].reverse().find((e) => e.type === "assistant");
  const base: Record<string, unknown> = {
    sessionId: session.id,
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
      entries: session.conversation.entries.map(entryView),
    });
  });

  app.post("/chat", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown; sessionId?: unknown };
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
      session = manager.add(deps.newSession(config));
    }

    try {
      await session.send(body.text);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409);
    }
    return c.json(stateOf(session));
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
    };
    await session.approve({
      approve: body.approve !== false,
      editedArgs:
        body.editedArgs && typeof body.editedArgs === "object"
          ? (body.editedArgs as Record<string, unknown>)
          : undefined,
      reason: typeof body.reason === "string" ? body.reason : undefined,
    });
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
    return c.json(stateOf(session));
  });

  return { app, manager };
}
