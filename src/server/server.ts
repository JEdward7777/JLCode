/**
 * A minimal synchronous HTTP endpoint for driving conversations (Phase 5
 * groundwork). Unlike the terminal REPL, each request is one-shot and the
 * server retains the thread by session id — so an external caller (curl, tests,
 * an agent) can hold a multi-turn conversation without interactive stdin.
 *
 * This is the dev/test slice: request→full-reply JSON. Streaming (SSE), the
 * browser UI, approvals, and auth arrive with the full Phase 5 frontend (D-18).
 */
import { Hono } from "hono";
import type { ModelConfig } from "../config/types.js";
import type { LlmDriver } from "../llm/types.js";
import type { Entry } from "../conversation/types.js";
import { SessionManager } from "../session/manager.js";
import type { Session } from "../session/session.js";

export interface ServerDeps {
  /** Re-read the selected config on demand, so CLI edits are picked up live. */
  resolveConfig: () => ModelConfig | undefined;
  /** Build a driver for a config (OpenRouter, or a fake for offline tests). */
  makeDriver: (config: ModelConfig) => LlmDriver;
  version: string;
}

function entryView(entry: Entry): Record<string, unknown> {
  switch (entry.type) {
    case "user":
      return { type: "user", text: entry.text };
    case "assistant":
      return {
        type: "assistant",
        text: entry.text,
        reasoningText: entry.reasoningText,
        truncated: entry.truncated ?? false,
        finishReason: entry.finishReason,
      };
    case "tool":
      return { type: "tool", name: entry.name, content: entry.content };
    case "compaction":
      return { type: "compaction", summary: entry.summary };
  }
}

/** Send a message and collect the resulting assistant turn + any notices. */
async function sendAndCollect(session: Session, text: string) {
  const errors: string[] = [];
  let truncation: string | undefined;
  const off = session.onEvent((ev) => {
    if (ev.type === "error") errors.push(ev.message);
    if (ev.type === "truncation") truncation = ev.message;
  });
  await session.send(text);
  off();
  const entries = session.conversation.entries;
  const last = entries[entries.length - 1];
  const assistant = last && last.type === "assistant" ? last : undefined;
  return { assistant, errors, truncation };
}

export function createServer(deps: ServerDeps): { app: Hono; manager: SessionManager } {
  const app = new Hono();
  const manager = new SessionManager();

  app.get("/health", (c) => {
    const config = deps.resolveConfig();
    return c.json({
      ok: true,
      version: deps.version,
      config: config?.name ?? null,
      model: config?.model ?? null,
    });
  });

  // What a *new* thread would use right now (reflects live CLI config changes).
  app.get("/config", (c) => {
    const config = deps.resolveConfig();
    if (!config) return c.json({ error: "no config selected" }, 404);
    return c.json({
      name: config.name,
      model: config.model,
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

  // Send a message. Omit sessionId to start a new thread; pass it to continue.
  app.post("/chat", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown; sessionId?: unknown };
    if (typeof body.text !== "string" || body.text.trim() === "") {
      return c.json({ error: "body must include a non-empty 'text'" }, 400);
    }

    let session: Session | undefined;
    if (typeof body.sessionId === "string") {
      session = manager.get(body.sessionId);
      if (!session) return c.json({ error: "no such session" }, 404);
    } else {
      // A new thread resolves the *current* config, so CLI switches take effect.
      const config = deps.resolveConfig();
      if (!config) return c.json({ error: "no model config selected for the server directory" }, 409);
      session = manager.create({ config, driver: deps.makeDriver(config) });
    }

    const { assistant, errors, truncation } = await sendAndCollect(session, body.text);
    return c.json({
      sessionId: session.id,
      reply: assistant?.text ?? "",
      reasoningText: assistant?.reasoningText,
      truncated: assistant?.truncated ?? false,
      finishReason: assistant?.finishReason,
      status: session.status,
      ...(errors.length > 0 ? { errors } : {}),
      ...(truncation ? { truncation } : {}),
    });
  });

  return { app, manager };
}
