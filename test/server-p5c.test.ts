import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createServer } from "../src/server/server";
import { ConversationStore } from "../src/persist/conversation-store";
import { echoDriver } from "../src/session/fake";
import { Session } from "../src/session/session";
import type { ModelConfig } from "../src/config/types";

const config: ModelConfig = {
  id: "cfg_x",
  name: "Test",
  openRouterKey: "sk",
  model: "m",
  defaultMode: "code",
  defaultApproval: "manual",
  createdAt: "",
  updatedAt: "",
};

let storeDir: string;
let store: ConversationStore;
beforeEach(() => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-p5c-"));
  store = new ConversationStore(storeDir);
});
afterEach(async () => {
  await store.close();
  fs.rmSync(storeDir, { recursive: true, force: true });
});

function makeApp() {
  return createServer({
    resolveConfig: () => config,
    newSession: (c, conversation) => new Session({ config: c, driver: echoDriver(), conversation }),
    store,
    workingDir: "/work/test",
    version: "0.0.0",
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

describe("P5c server surface (D-33/D-34)", () => {
  it("exposes spend + cap + tasks + queue in the settled state", async () => {
    const app = makeApp();
    const id = await newSession(app);
    const s = await post(app, "/chat", { sessionId: id, text: "hi" });
    expect(s.json.spendUsd).toBe(0); // echo driver has no cost/pricing
    expect(s.json.spendCapUsd).toBeNull();
    expect(s.json.capReached).toBe(false);
    expect(s.json.tasks).toEqual([]);
    expect(s.json.queue).toEqual([]);
  });

  it("sets and clears the spend cap; rejects a bad value", async () => {
    const app = makeApp();
    const id = await newSession(app);
    const set = await post(app, `/session/${id}/cap`, { capUsd: 1.5 });
    expect(set.status).toBe(200);
    expect(set.json.spendCapUsd).toBe(1.5);
    const cleared = await post(app, `/session/${id}/cap`, { capUsd: null });
    expect(cleared.json.spendCapUsd).toBeNull();
    const bad = await post(app, `/session/${id}/cap`, { capUsd: -1 });
    expect(bad.status).toBe(400);
  });

  it("replaces the queue via {queue:[...]}", async () => {
    const app = makeApp();
    const id = await newSession(app);
    const q = await post(app, `/session/${id}/queue`, { queue: [{ text: "later A" }, { text: "later B" }] });
    expect(q.status).toBe(200);
    expect(q.json.queue.map((m: any) => m.text)).toEqual(["later A", "later B"]);
    // Clearing with an empty array leaves nothing queued.
    const cleared = await post(app, `/session/${id}/queue`, { queue: [] });
    expect(cleared.json.queue).toEqual([]);
  });

  it("rejects an empty queue body and a missing task", async () => {
    const app = makeApp();
    const id = await newSession(app);
    const bad = await post(app, `/session/${id}/queue`, { text: "   " });
    expect(bad.status).toBe(400);
    const noTask = await post(app, `/session/${id}/task/nope/kill`, {});
    expect(noTask.status).toBe(404);
  });

  it("accepts a global stop and reports idle", async () => {
    const app = makeApp();
    const id = await newSession(app);
    const hard = await post(app, `/session/${id}/stop`, { scope: "hard" });
    expect(hard.status).toBe(200);
    expect(hard.json.status).toBe("idle");
    const soft = await post(app, `/session/${id}/stop`, {});
    expect(soft.status).toBe(200); // defaults to hard when scope omitted
  });
});
