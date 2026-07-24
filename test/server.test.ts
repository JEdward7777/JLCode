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
import { askUserTool } from "../src/tools/ask-user";
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

  it("edit forks a sibling branch and rewind switches the active branch", async () => {
    const app = makeApp();
    const id = (await post(app, "/chat", { text: "q1" })).json.sessionId as string;

    type Row = { id: string; parent: string | null; type: string };
    const s1 = (await (await app.request(`/session/${id}`)).json()) as { entries: Row[] };
    const user1 = s1.entries.find((e) => e.type === "user")!;

    await post(app, `/session/${id}/edit`, { entryId: user1.id, text: "q2" });
    const s2 = (await (await app.request(`/session/${id}`)).json()) as { entries: Row[] };
    // Two user messages now branch off the root.
    expect(s2.entries.filter((e) => e.parent === null && e.type === "user")).toHaveLength(2);

    const assistant1 = s2.entries.find((e) => e.parent === user1.id && e.type === "assistant")!;
    const rw = await post(app, `/session/${id}/rewind`, { entryId: assistant1.id });
    expect(rw.json.status).toBe("idle");
    const s3 = (await (await app.request(`/session/${id}`)).json()) as { activeLeaf: string };
    expect(s3.activeLeaf).toBe(assistant1.id);
  });

  it("exposes conversationId on /session/:id for the debug-journal fetch (P5d)", async () => {
    const app = makeApp();
    const created = await post(app, "/chat", { text: "hi" });
    const id = created.json.sessionId as string;
    const s = (await (await app.request(`/session/${id}`)).json()) as { conversationId?: string };
    expect(s.conversationId).toBe(created.json.conversationId);
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
    expect(first.json.approvalRequest.tool).toBe("write_file");
    expect(fs.existsSync(path.join(root, "out.txt"))).toBe(false);

    const id = first.json.sessionId as string;
    const res = await post(app, `/session/${id}/approve`, { approve: true });
    expect(res.json.status).toBe("idle");
    expect(res.json.reply).toBe("Wrote it.");
    expect(fs.readFileSync(path.join(root, "out.txt"), "utf8")).toBe("from the agent");
  });
});

describe("dev server — mode/approval controls (D-07/D-08)", () => {
  function modeApp(persist?: (name: string, patch: { mode?: string; approval?: string }) => void) {
    return createServer({
      resolveConfig: () => config,
      store,
      workingDir: "/work/test",
      newSession: (c, conversation) =>
        new Session({
          config: c,
          driver: echoDriver(),
          tools: new ToolRegistry(fileTools()),
          sandbox: new Sandbox([storeDir]),
          mode: c.defaultMode,
          approval: c.defaultApproval,
          buildGate: (mode, approval) => new ModeApprovalGate(mode, approval),
          conversation,
        }),
      persistDefaults: persist as never,
      version: "0.0.0",
    }).app;
  }

  it("reports mode/approval and switches them, persisting the config default", async () => {
    const persisted: Array<{ name: string; patch: unknown }> = [];
    const app = modeApp((name, patch) => persisted.push({ name, patch }));
    const created = (await (await app.request("/session", { method: "POST" })).json()) as { sessionId: string };
    const id = created.sessionId;

    const before = (await (await app.request(`/session/${id}`)).json()) as { mode: string; approval: string };
    expect(before.mode).toBe("code");
    expect(before.approval).toBe("manual");

    const res = await post(app, `/session/${id}/mode`, { mode: "plan", approval: "auto-safe" });
    expect(res.status).toBe(200);
    expect(res.json.mode).toBe("plan");
    expect(res.json.approval).toBe("auto-safe");
    expect(persisted).toEqual([{ name: "Test", patch: { mode: "plan", approval: "auto-safe" } }]);
  });

  it("rejects an invalid mode and an empty change", async () => {
    const app = modeApp();
    const id = ((await (await app.request("/session", { method: "POST" })).json()) as { sessionId: string }).sessionId;
    expect((await post(app, `/session/${id}/mode`, { mode: "wizard" })).status).toBe(400);
    expect((await post(app, `/session/${id}/mode`, {})).status).toBe(400);
  });
});

describe("dev server — ask_user answers (D-18)", () => {
  function askDriver(): LlmDriver {
    let n = 0;
    return {
      async *streamChat(): AsyncGenerator<StreamEvent> {
        n++;
        if (n === 1) {
          yield {
            type: "tool_call",
            index: 0,
            id: "c1",
            name: "ask_user",
            argsDelta: JSON.stringify({
              questions: [
                { header: "Store", question: "Which store?", options: ["sqlite", "postgres"] },
                { header: "Env", question: "Which envs?", multiSelect: true },
              ],
            }),
          };
          yield { type: "finish", reason: "tool_calls" };
        } else {
          yield { type: "text", delta: "Configured." };
          yield { type: "finish", reason: "stop" };
        }
      },
    };
  }

  function askApp() {
    return createServer({
      resolveConfig: () => config,
      store,
      workingDir: "/work/test",
      newSession: (c, conversation) =>
        new Session({
          config: c,
          driver: askDriver(),
          tools: new ToolRegistry([...fileTools(), askUserTool()]),
          sandbox: new Sandbox([storeDir]),
          conversation,
        }),
      version: "0.0.0",
    }).app;
  }

  it("/chat pauses on a multi-question form; /answer with answers[] resumes", async () => {
    const app = askApp();
    const first = await post(app, "/chat", { text: "configure" });
    expect(first.json.status).toBe("awaiting-input");
    expect(first.json.question.questions).toHaveLength(2);

    const id = first.json.sessionId as string;
    const res = await post(app, `/session/${id}/answer`, {
      answers: [
        { header: "Store", question: "Which store?", answer: "postgres" },
        { header: "Env", question: "Which envs?", answer: "dev, prod" },
      ],
    });
    expect(res.json.status).toBe("idle");
    expect(res.json.reply).toBe("Configured.");
    const conv = (await (await app.request(`/session/${id}`)).json()) as { entries: Array<Record<string, any>> };
    const tool = conv.entries.find((e) => e.type === "tool")!;
    expect(tool.content).toContain("Store — Which store?: postgres");
  });
});
