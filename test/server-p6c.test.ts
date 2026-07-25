/**
 * P6c server surface — the trigger-mode switch + compaction control endpoints
 * (D-27). Tier-0: an offline scripted driver forces a budget crossing so the
 * cancelable pause is reachable over HTTP, and the settled state exposes the
 * live trigger mode + the pending compaction request.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createServer } from "../src/server/server";
import { ConversationStore } from "../src/persist/conversation-store";
import { Session } from "../src/session/session";
import type { ModelConfig } from "../src/config/types";
import type { LlmDriver, StreamEvent, Usage } from "../src/llm/types";

const config: ModelConfig = {
  id: "cfg_x",
  name: "Test",
  openRouterKey: "sk",
  model: "m",
  defaultMode: "code",
  defaultApproval: "manual",
  compaction: { auto: false, triggerModes: ["cancelable"], bufferTokens: 100 },
  createdAt: "",
  updatedAt: "",
};

function turn(text: string, usage: Usage): StreamEvent[] {
  return [{ type: "text", delta: text }, { type: "finish", reason: "stop" }, { type: "usage", usage }];
}

/** Plays a fixed script of turns/summaries in order across calls. */
function scriptDriver(steps: StreamEvent[][]): LlmDriver {
  let i = 0;
  return {
    async *streamChat(): AsyncGenerator<StreamEvent> {
      const step = steps[i++] ?? turn("ok", { promptTokens: 5, completionTokens: 5 });
      for (const ev of step) yield ev;
    },
  };
}

let storeDir: string;
let store: ConversationStore;
beforeEach(() => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-p6c-"));
  store = new ConversationStore(storeDir);
});
afterEach(async () => {
  await store.close();
  fs.rmSync(storeDir, { recursive: true, force: true });
});

let persisted: Array<{ configName: string; patch: Record<string, unknown> }> = [];

function makeApp(steps: StreamEvent[][]) {
  persisted = [];
  return createServer({
    resolveConfig: () => config,
    newSession: (c, conversation) =>
      new Session({ config: c, driver: scriptDriver(steps), conversation, contextWindow: 1_000 }),
    store,
    workingDir: "/work/test",
    version: "0.0.0",
    persistDefaults: (configName, patch) => persisted.push({ configName, patch }),
  }).app;
}

async function post(app: ReturnType<typeof makeApp>, url: string, body: unknown) {
  const res = await app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

async function newSession(app: ReturnType<typeof makeApp>): Promise<string> {
  const res = await post(app, "/session", {});
  return res.json.sessionId as string;
}

describe("P6c server surface (D-27)", () => {
  it("exposes the live trigger mode in the settled state", async () => {
    const app = makeApp([turn("hi", { promptTokens: 5, completionTokens: 5 })]);
    const id = await newSession(app);
    const s = await post(app, "/chat", { sessionId: id, text: "hi" });
    expect(s.json.triggerMode).toBe("cancelable");
  });

  it("switches the trigger mode, persists it, and rejects an invalid one", async () => {
    const app = makeApp([]);
    const id = await newSession(app);
    const ok = await post(app, `/session/${id}/trigger-mode`, { mode: "suggest" });
    expect(ok.status).toBe(200);
    expect(ok.json.triggerMode).toBe("suggest");
    expect(persisted).toContainEqual({ configName: "Test", patch: { triggerMode: "suggest" } });
    const bad = await post(app, `/session/${id}/trigger-mode`, { mode: "nonsense" });
    expect(bad.status).toBe(400);
  });

  it("reaches the cancelable pause over HTTP, then Compact resolves it", async () => {
    const app = makeApp([
      turn("first", { promptTokens: 950, completionTokens: 100 }), // crosses the budget
      turn("## Goal\nsummary.\n", { promptTokens: 500, completionTokens: 40 }), // compaction call
      turn("second", { promptTokens: 20, completionTokens: 5 }), // held turn
    ]);
    const id = await newSession(app);
    await post(app, "/chat", { sessionId: id, text: "one" });
    const paused = await post(app, "/chat", { sessionId: id, text: "two" });
    expect(paused.json.status).toBe("awaiting-compaction");
    expect(paused.json.compactionRequest).toMatchObject({ cancelable: true, mode: "cancelable" });

    const resolved = await post(app, `/session/${id}/compact`, {});
    expect(resolved.status).toBe(200);
    expect(resolved.json.status).toBe("idle");
    // The compaction summary is now on the branch.
    const view = await (await makeReq(app, `/session/${id}`)).json();
    expect(view.entries.some((e: any) => e.type === "compaction")).toBe(true);
  });

  it("Skip on a cancelable pause proceeds without compacting", async () => {
    const app = makeApp([
      turn("first", { promptTokens: 950, completionTokens: 100 }),
      turn("second", { promptTokens: 950, completionTokens: 100 }),
    ]);
    const id = await newSession(app);
    await post(app, "/chat", { sessionId: id, text: "one" });
    await post(app, "/chat", { sessionId: id, text: "two" });
    const resolved = await post(app, `/session/${id}/compact`, { skip: true });
    expect(resolved.json.status).toBe("idle");
    const view = await (await makeReq(app, `/session/${id}`)).json();
    expect(view.entries.some((e: any) => e.type === "compaction")).toBe(false);
  });
});

function makeReq(app: ReturnType<typeof makeApp>, url: string) {
  return app.request(url);
}
