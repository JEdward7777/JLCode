/**
 * Conversation labels (X-09). Three layers, all here: the cleanup of whatever
 * the model says back (`session/title.ts`), the append-only persistence of a
 * title and its renames (`ConversationStore`), and the session's **ephemeral**
 * auto-title — Joshua's design: after the first exchange, tag a question onto
 * the end of the live conversation, ask the active model, and never append it
 * to the tree. The last part is what the tests here guard hardest: the question
 * must not become history, and a nicety must never cost more than one call.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildTitleInstruction, sanitizeTitle } from "../src/session/title";
import { ConversationStore } from "../src/persist/conversation-store";
import { createServer } from "../src/server/server";
import { Session } from "../src/session/session";
import type { ChatRequest, LlmDriver, StreamEvent } from "../src/llm/types";
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

describe("title cleanup (X-09)", () => {
  it("keeps a plain title as-is", () => {
    expect(sanitizeTitle("Fix the SSE shutdown hang")).toBe("Fix the SSE shutdown hang");
  });

  it("strips the decoration models like to add", () => {
    expect(sanitizeTitle('Title: "Fixing the SSE hang."')).toBe("Fixing the SSE hang");
    expect(sanitizeTitle("**Debugging the append log**")).toBe("Debugging the append log");
    expect(sanitizeTitle("`compaction budget math`")).toBe("compaction budget math");
  });

  it("takes the first non-empty line when the model rambles", () => {
    expect(sanitizeTitle("\n\nMCP path fencing\n\nThat felt like a good summary.")).toBe("MCP path fencing");
  });

  it("collapses whitespace", () => {
    expect(sanitizeTitle("two   spaces\there")).toBe("two spaces here");
  });

  it("clamps a long title on a word boundary", () => {
    const long = sanitizeTitle("Investigating why the streamed reasoning details fail signature checks", 40);
    expect(long.length).toBeLessThanOrEqual(41); // 40 + the ellipsis
    expect(long.endsWith("…")).toBe(true);
    expect(long.startsWith("Investigating why the streamed")).toBe(true);
  });

  it("is empty when there is nothing usable — the thread just stays unnamed", () => {
    expect(sanitizeTitle("")).toBe("");
    expect(sanitizeTitle("\n \n")).toBe("");
    expect(sanitizeTitle('""')).toBe("");
  });

  it("asks for a title and nothing else", () => {
    const instruction = buildTitleInstruction();
    expect(instruction).toMatch(/short title/i);
    expect(instruction).toMatch(/nothing else/i);
  });
});

describe("titles on disk (append-only, X-09)", () => {
  let dir: string;
  let store: ConversationStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-title-"));
    store = new ConversationStore(dir);
  });
  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("names a conversation, and the newest name wins (a rename is just an append)", async () => {
    await store.create({ id: "cv_1", workingDir: "/w" });
    await store.title("cv_1", "First guess", "auto");
    await store.title("cv_1", "What I actually called it", "manual");
    await store.flush();

    expect(store.load("cv_1")!.title).toBe("What I actually called it");
    expect(store.list("/w")[0]!.title).toBe("What I actually called it");
  });

  it("leaves untitled threads untitled instead of inventing something", async () => {
    await store.create({ id: "cv_2", workingDir: "/w" });
    await store.flush();
    expect(store.load("cv_2")!.title).toBeUndefined();
    expect(store.list("/w")[0]!.title).toBeUndefined();
  });

  it("does not let a title record masquerade as a history row", async () => {
    await store.create({ id: "cv_3", workingDir: "/w" });
    await store.title("cv_3", "Named", "auto");
    await store.flush();
    const rows = store.list("/w");
    expect(rows).toHaveLength(1); // one conversation, not one + a phantom
    expect(rows[0]!.id).toBe("cv_3");
  });

  it("titles a thread the dir filter excludes without leaking it into the list", async () => {
    await store.create({ id: "cv_a", workingDir: "/w" });
    await store.create({ id: "cv_b", workingDir: "/elsewhere" });
    await store.title("cv_b", "Other project", "auto");
    await store.flush();
    expect(store.list("/w").map((r) => r.id)).toEqual(["cv_a"]);
  });
});

/** Records every request so the test can assert on the *ephemeral* one. */
function titlingDriver(titleText = "Reading the notes file"): { driver: LlmDriver; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let n = 0;
  const driver: LlmDriver = {
    async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent> {
      requests.push(req);
      n++;
      if (n === 1) {
        yield { type: "text", delta: "Here is my answer." };
        yield { type: "finish", reason: "stop" };
      } else {
        yield { type: "text", delta: titleText };
        yield { type: "finish", reason: "stop" };
      }
    },
  };
  return { driver, requests };
}

describe("auto-title after the first exchange (X-09)", () => {
  it("asks with an ephemeral question that never lands in the tree", async () => {
    const { driver, requests } = titlingDriver();
    const session = new Session({ config, driver, autoTitle: true });
    const titles: string[] = [];
    session.onEvent((e) => {
      if (e.type === "title") titles.push(e.title);
    });

    await session.send("what's in notes.txt?");

    expect(session.conversation.title).toBe("Reading the notes file");
    expect(titles).toEqual(["Reading the notes file"]);
    // The question was asked...
    expect(requests).toHaveLength(2);
    const last = requests[1]!.messages[requests[1]!.messages.length - 1]!;
    expect(String(last.content)).toMatch(/short title/i);
    expect(requests[1]!.tool_choice).toBe("none"); // it must not call tools
    // ...and left no trace: the tree holds the real exchange and nothing else.
    expect(session.conversation.entries.map((e) => e.type)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(session.conversation.entries)).not.toMatch(/short title/i);
  });

  it("asks once per session, not once per turn", async () => {
    const { driver, requests } = titlingDriver();
    const session = new Session({ config, driver, autoTitle: true });
    await session.send("first");
    await session.send("second");
    await session.send("third");
    // 3 real turns + exactly 1 title call.
    expect(requests).toHaveLength(4);
  });

  it("does not re-title a resumed conversation that already has a name", async () => {
    const { driver, requests } = titlingDriver();
    const session = new Session({
      config,
      driver,
      autoTitle: true,
      conversation: { id: "cv_1", title: "Named earlier", entries: [], activeLeaf: null, createdAt: "", updatedAt: "" },
    });
    await session.send("carry on");
    expect(requests).toHaveLength(1);
    expect(session.conversation.title).toBe("Named earlier");
  });

  it("keeps the turn when the title call fails — a label is a nicety", async () => {
    let n = 0;
    const driver: LlmDriver = {
      async *streamChat(): AsyncGenerator<StreamEvent> {
        if (++n === 1) {
          yield { type: "text", delta: "Answered." };
          yield { type: "finish", reason: "stop" };
          return;
        }
        throw new Error("provider exploded");
      },
    };
    const session = new Session({ config, driver, autoTitle: true });
    await expect(session.send("hello")).resolves.toBeUndefined();
    expect(session.conversation.title).toBeUndefined();
    expect(session.status).toBe("idle");
  });

  it("a hand-picked name pins — the auto-title never overwrites it", async () => {
    const { driver, requests } = titlingDriver();
    const session = new Session({ config, driver, autoTitle: true });
    session.setTitle("My name for it", "manual");
    await session.send("hello");
    expect(session.conversation.title).toBe("My name for it");
    expect(requests).toHaveLength(1); // no title call at all
  });

  it("cleans up a decorated answer before storing it", async () => {
    const { driver } = titlingDriver('  "Fixing the SSE hang."  ');
    const session = new Session({ config, driver, autoTitle: true });
    await session.send("hello");
    expect(session.conversation.title).toBe("Fixing the SSE hang");
  });

  it("refuses an empty rename", () => {
    const { driver } = titlingDriver();
    const session = new Session({ config, driver, autoTitle: true });
    expect(() => session.setTitle("   ")).toThrow(/empty/i);
  });
});

describe("titles over HTTP (X-09)", () => {
  let storeDir: string;
  let store: ConversationStore;
  beforeEach(() => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-title-srv-"));
    store = new ConversationStore(storeDir);
  });
  afterEach(async () => {
    await store.close();
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  function makeApp(driver: LlmDriver) {
    return createServer({
      resolveConfig: () => config,
      newSession: (c, conversation) => new Session({ config: c, driver, conversation, autoTitle: true }),
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

  it("auto-titles a live thread and persists it where the history list reads it", async () => {
    const { driver } = titlingDriver("Poking at the notes file");
    const app = makeApp(driver);
    const chat = await post(app, "/chat", { text: "hello" });
    expect(chat.json.title).toBe("Poking at the notes file");

    await store.flush();
    const rows = store.list("/work/test");
    expect(rows[0]!.title).toBe("Poking at the notes file");
    expect(store.load(chat.json.conversationId)!.title).toBe("Poking at the notes file");
  });

  it("renames on demand, and the hand-picked name survives a reload", async () => {
    const { driver } = titlingDriver();
    const app = makeApp(driver);
    const chat = await post(app, "/chat", { text: "hello" });
    const id = chat.json.sessionId as string;

    const renamed = await post(app, `/session/${id}/title`, { title: "  What I call it  " });
    expect(renamed.status).toBe(200);
    expect(renamed.json.title).toBe("What I call it");

    const view = (await (await app.request(`/session/${id}`)).json()) as { title: string };
    expect(view.title).toBe("What I call it");
    // Flushed before responding (read-your-writes), so the log already agrees.
    expect(store.load(chat.json.conversationId)!.title).toBe("What I call it");
  });

  it("rejects an empty rename and an unknown session", async () => {
    const { driver } = titlingDriver();
    const app = makeApp(driver);
    const chat = await post(app, "/chat", { text: "hello" });
    expect((await post(app, `/session/${chat.json.sessionId}/title`, { title: "   " })).status).toBe(400);
    expect((await post(app, "/session/nope/title", { title: "x" })).status).toBe(404);
  });
});
