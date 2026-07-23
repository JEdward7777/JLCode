import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createServer } from "../src/server/server";
import { ConversationStore } from "../src/persist/conversation-store";
import { echoDriver } from "../src/session/fake";
import { Session } from "../src/session/session";
import { Sandbox } from "../src/tools/sandbox";
import { ToolRegistry } from "../src/tools/registry";
import { fileTools } from "../src/tools/file-tools";
import { ModeApprovalGate } from "../src/tools/mode-gate";
import type { LlmDriver, StreamEvent } from "../src/llm/types";
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
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-srvstore-"));
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

async function post(app: ReturnType<typeof makeApp>, path: string, body: unknown) {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

describe("dev server", () => {
  it("reports health", async () => {
    const res = await makeApp().request("/health");
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("starts a thread and retains it across calls", async () => {
    const app = makeApp();
    const first = await post(app, "/chat", { text: "hello" });
    expect(first.status).toBe(200);
    expect(first.json.reply).toBe("You said: hello");
    const id = first.json.sessionId as string;

    const second = await post(app, "/chat", { text: "again", sessionId: id });
    expect(second.json.sessionId).toBe(id);

    const view = await app.request(`/session/${id}`);
    const entries = (await view.json()).entries as Array<{ type: string }>;
    // user, assistant, user, assistant — the thread was retained.
    expect(entries.map((e) => e.type)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("rejects an empty message and an unknown session", async () => {
    const app = makeApp();
    expect((await post(app, "/chat", { text: "" })).status).toBe(400);
    expect((await post(app, "/chat", { text: "hi", sessionId: "nope" })).status).toBe(404);
  });

  it("resumes a conversation by id in a fresh server ('restart')", async () => {
    const first = await post(makeApp(), "/chat", { text: "remember me" });
    const convId = first.json.conversationId as string;
    expect(convId).toBeTruthy();
    await store.flush();

    // A brand-new server = a fresh (empty) SessionManager; resume must come from disk.
    const app2 = makeApp();
    const resumed = await post(app2, "/chat", { text: "still here?", conversationId: convId });
    expect(resumed.json.conversationId).toBe(convId);
    await store.flush();

    const conv = (await (await app2.request(`/conversation/${convId}`)).json()) as {
      entries: Array<{ type: string }>;
    };
    expect(conv.entries.map((e) => e.type)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("lists conversations by working directory", async () => {
    const r = await post(makeApp(), "/chat", { text: "hi" });
    await store.flush();
    const here = (await (await makeApp().request("/conversations")).json()) as { conversations: Array<{ id: string }> };
    expect(here.conversations.some((row) => row.id === r.json.conversationId)).toBe(true);
    const elsewhere = (await (await makeApp().request("/conversations?dir=/nope")).json()) as {
      conversations: unknown[];
    };
    expect(elsewhere.conversations.length).toBe(0);
  });
});

describe("dev server — approval flow", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-srv-appr-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function toolDriver(): LlmDriver {
    let n = 0;
    return {
      async *streamChat(): AsyncGenerator<StreamEvent> {
        n++;
        if (n === 1) {
          yield {
            type: "tool_call",
            index: 0,
            id: "c1",
            name: "write_file",
            argsDelta: JSON.stringify({ path: "out.txt", content: "from the agent" }),
          };
          yield { type: "finish", reason: "tool_calls" };
        } else {
          yield { type: "text", delta: "Wrote it." };
          yield { type: "finish", reason: "stop" };
        }
      },
    };
  }

  function toolApp() {
    return createServer({
      resolveConfig: () => config,
      store,
      workingDir: root,
      newSession: (c, conversation) =>
        new Session({
          config: c,
          driver: toolDriver(),
          tools: new ToolRegistry(fileTools()),
          sandbox: new Sandbox([root]),
          gate: new ModeApprovalGate("code", "manual"),
          conversation,
        }),
      version: "0.0.0",
    }).app;
  }

  it("/chat pauses for approval, /approve resumes and runs the tool", async () => {
    const app = toolApp();
    const first = await post(app, "/chat", { text: "write out.txt" });
    expect(first.json.status).toBe("awaiting-approval");
    expect(first.json.approval.tool).toBe("write_file");
    expect(fs.existsSync(path.join(root, "out.txt"))).toBe(false);

    const id = first.json.sessionId as string;
    const res = await post(app, `/session/${id}/approve`, { approve: true });
    expect(res.json.status).toBe("idle");
    expect(res.json.reply).toBe("Wrote it.");
    expect(fs.readFileSync(path.join(root, "out.txt"), "utf8")).toBe("from the agent");
  });
});
