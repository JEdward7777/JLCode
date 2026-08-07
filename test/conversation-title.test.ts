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
import {
  buildTitleInstruction,
  driftedEnough,
  sanitizeTitle,
  RETITLE_GROWTH,
  RETITLE_MIN_TURNS,
} from "../src/session/title";
import { ConversationStore } from "../src/persist/conversation-store";
import { createServer } from "../src/server/server";
import { Session } from "../src/session/session";
import type { ChatRequest, LlmDriver, StreamEvent } from "../src/llm/types";
import type { ModelConfig } from "../src/config/types";
import { createSessionFactory } from "../src/server/session-factory";
import { ModelCatalog } from "../src/llm/models";
import { resolvePaths } from "../src/paths";
import { runConfig } from "../src/config/commands";
import { addModelConfig } from "../src/config/operations";
import { loadConfig, saveConfig } from "../src/config/store";
import type { JlcodePaths } from "../src/paths";

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

  it("remembers *who* named a thread, so a hand-rename survives a restart (X-17)", async () => {
    await store.create({ id: "cv_p", workingDir: "/w" });
    await store.title("cv_p", "Auto guess", "auto");
    await store.title("cv_p", "What I call it", "manual");
    await store.flush();
    // Without this the drift re-title would resume and quietly undo the rename.
    expect(store.load("cv_p")!.titleSource).toBe("manual");

    await store.title("cv_p", "Renamed by the machine", "auto");
    await store.flush();
    expect(store.load("cv_p")!.titleSource).toBe("auto"); // newest record wins, source and all
  });

  it("reads a pre-X-17 log — no source recorded — as auto, not as pinned", async () => {
    await store.create({ id: "cv_q", workingDir: "/w" });
    await store.title("cv_q", "Named the old way", "auto");
    await store.flush();
    expect(store.load("cv_q")!.titleSource).toBe("auto");
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

// ---- X-17: re-titling as a thread drifts -------------------------------------

/** A driver that answers turns normally and hands back the next scripted title
 *  whenever it sees the ephemeral title question, so a test can tell the two
 *  kinds of call apart — which is the whole point when the cost of the feature
 *  is the number of title calls. */
function driftDriver(titles: string[]): { driver: LlmDriver; requests: ChatRequest[]; titleCalls: () => number } {
  const requests: ChatRequest[] = [];
  const isTitleAsk = (req: ChatRequest): boolean =>
    /Name this conversation/i.test(String(req.messages[req.messages.length - 1]!.content));
  let asked = 0;
  const driver: LlmDriver = {
    async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent> {
      requests.push(req);
      if (isTitleAsk(req)) {
        const text = titles[Math.min(asked, titles.length - 1)]!;
        asked++;
        yield { type: "text", delta: text };
      } else {
        yield { type: "text", delta: "Sure, done." };
      }
      yield { type: "finish", reason: "stop" };
    },
  };
  return { driver, requests, titleCalls: () => requests.filter(isTitleAsk).length };
}

describe("drift policy (X-17) — the part that costs money", () => {
  const at = (turns: number, folds = 0) => ({ turns, folds });

  it("waits for the thread to roughly double, and for a floor of new turns", () => {
    expect(driftedEnough(at(1), at(1 + RETITLE_MIN_TURNS - 1))).toBe(false); // floor not met
    expect(driftedEnough(at(1), at(1 + RETITLE_MIN_TURNS))).toBe(true);
    // Past the floor, growth is what gates it: +6 on a 40-turn thread is nothing.
    expect(driftedEnough(at(40), at(40 + RETITLE_MIN_TURNS))).toBe(false);
    expect(driftedEnough(at(40), at(40 * RETITLE_GROWTH))).toBe(true);
  });

  it("treats a fold as drift — the topic just changed by definition", () => {
    expect(driftedEnough(at(40, 0), at(41, 1))).toBe(true);
    expect(driftedEnough(at(40, 1), at(41, 1))).toBe(false); // the same fold, twice, is not drift
  });

  it("costs a logarithmic number of calls over a long thread, not one per turn", () => {
    let mark = at(1);
    let calls = 0;
    for (let turns = 2; turns <= 200; turns++) {
      if (driftedEnough(mark, at(turns))) {
        calls++;
        mark = at(turns);
      }
    }
    expect(calls).toBeLessThanOrEqual(8); // ~log2(200); the D-58/D-59 lesson, asserted
  });

  it("offers the current name back and lets the model keep it", () => {
    const instruction = buildTitleInstruction("Compaction budget math");
    expect(instruction).toContain("Compaction budget math");
    expect(instruction).toMatch(/reply with exactly that name/i);
    expect(instruction).toMatch(/only rename it/i);
    // The first-title question is unchanged — it has no name to offer.
    expect(buildTitleInstruction()).not.toMatch(/currently named/i);
  });
});

describe("auto-re-title on drift (X-17)", () => {
  async function sendTurns(session: Session, n: number, from = 1): Promise<void> {
    for (let i = 0; i < n; i++) await session.send(`turn ${from + i}`);
  }

  it("re-titles once the thread has grown, and not before", async () => {
    const { driver, titleCalls } = driftDriver(["Reading the notes file", "Rewriting the append log"]);
    const session = new Session({ config, driver, autoTitle: true });

    await session.send("what's in notes.txt?");
    expect(session.conversation.title).toBe("Reading the notes file");
    expect(titleCalls()).toBe(1);

    // One turn short of the floor: the thread has changed subject, and we still
    // don't pay for it — drift is measured in growth, not in vibes.
    await sendTurns(session, RETITLE_MIN_TURNS - 1, 2);
    expect(titleCalls()).toBe(1);
    expect(session.conversation.title).toBe("Reading the notes file");

    await session.send("one more");
    expect(titleCalls()).toBe(2);
    expect(session.conversation.title).toBe("Rewriting the append log");
  });

  it("re-asks straight after a compaction — a fold is the topic changing", async () => {
    const { driver, titleCalls } = driftDriver(["First topic", "What it became"]);
    const session = new Session({ config, driver, autoTitle: true, contextWindow: 200_000 });

    await session.send("start");
    expect(titleCalls()).toBe(1);
    expect(await session.compact()).toBe(true);
    await session.send("carry on");

    expect(titleCalls()).toBe(2); // no waiting for the growth floor
    expect(session.conversation.title).toBe("What it became");
  });

  it("writes nothing when the model keeps the name — no index churn, no blinking card", async () => {
    const { driver, titleCalls } = driftDriver(["Reading the notes file"]); // same answer every time
    const session = new Session({ config, driver, autoTitle: true });
    const titles: string[] = [];
    session.onEvent((e) => {
      if (e.type === "title") titles.push(e.title);
    });

    await session.send("hello");
    await sendTurns(session, RETITLE_MIN_TURNS, 2);

    expect(titleCalls()).toBe(2); // it was re-asked…
    expect(titles).toEqual(["Reading the notes file"]); // …and answered with the same name
  });

  it("never overwrites a name a person chose — in this session…", async () => {
    const { driver, titleCalls } = driftDriver(["Auto guess", "Auto second guess"]);
    const session = new Session({ config, driver, autoTitle: true });

    await session.send("hello");
    session.setTitle("What I call it", "manual");
    await sendTurns(session, RETITLE_MIN_TURNS * 3, 2);

    expect(session.conversation.title).toBe("What I call it");
    expect(titleCalls()).toBe(1); // only the pre-rename first title
  });

  it("…and in one resumed from disk, where the pin lives in the log", async () => {
    const { driver, titleCalls } = driftDriver(["Something else entirely"]);
    const session = new Session({
      config,
      driver,
      autoTitle: true,
      conversation: {
        id: "cv_m",
        title: "What I call it",
        titleSource: "manual",
        entries: [],
        activeLeaf: null,
        createdAt: "",
        updatedAt: "",
      },
    });
    await sendTurns(session, RETITLE_MIN_TURNS * 3);
    expect(session.conversation.title).toBe("What I call it");
    expect(titleCalls()).toBe(0);
  });

  it("measures drift from where a resume found the thread, not from turn one", async () => {
    const { driver, titleCalls } = driftDriver(["A fresh name"]);
    const entries = Array.from({ length: 20 }, (_, i) => ({
      id: `e${i}`,
      parent: i === 0 ? null : `e${i - 1}`,
      ts: "",
      ...(i % 2 === 0 ? { type: "user" as const, text: "q" } : { type: "assistant" as const, text: "a" }),
    }));
    const session = new Session({
      config,
      driver,
      autoTitle: true,
      conversation: {
        id: "cv_r",
        title: "Named earlier",
        entries,
        activeLeaf: "e19",
        createdAt: "",
        updatedAt: "",
      },
    });
    // The log doesn't say when that name was chosen, so the first settle after a
    // resume must not spend a call on the assumption that it has drifted.
    await session.send("carry on");
    expect(titleCalls()).toBe(0);
    expect(session.conversation.title).toBe("Named earlier");
  });

  it("stops at the opening name when the config opts out", async () => {
    const { driver, titleCalls } = driftDriver(["First topic", "Would have re-titled"]);
    const session = new Session({ config, driver, autoTitle: true, autoRetitle: false });

    await session.send("hello");
    await sendTurns(session, RETITLE_MIN_TURNS * 2, 2);

    expect(session.conversation.title).toBe("First topic");
    expect(titleCalls()).toBe(1);
  });

  it("still gets a name later when the very first title call failed", async () => {
    let calls = 0;
    const driver: LlmDriver = {
      async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent> {
        if (/Name this conversation/i.test(String(req.messages[req.messages.length - 1]!.content))) {
          if (++calls === 1) throw new Error("provider exploded");
          yield { type: "text", delta: "Named on the second try" };
        } else {
          yield { type: "text", delta: "Sure." };
        }
        yield { type: "finish", reason: "stop" };
      },
    };
    // Opting out of *re*-titling pins a name that landed; it must not pin a
    // failure into a permanently unnamed thread.
    const session = new Session({ config, driver, autoTitle: true, autoRetitle: false });
    await session.send("hello");
    expect(session.conversation.title).toBeUndefined();
    for (let i = 0; i < RETITLE_MIN_TURNS; i++) await session.send(`turn ${i}`);
    expect(session.conversation.title).toBe("Named on the second try");
    expect(calls).toBe(2); // backed off to the drift schedule, not once per turn
  });
});

describe("a re-title lands in the history index too (X-17 × X-12b)", () => {
  let storeDir: string;
  let store: ConversationStore;
  beforeEach(() => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-retitle-srv-"));
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

  it("updates the history row and the live session's own state", async () => {
    const { driver } = driftDriver(["Poking at the notes file", "Rewriting the append log"]);
    const app = makeApp(driver);
    const first = await post(app, "/chat", { text: "hello" });
    const sessionId = first.json.sessionId as string;
    const convId = first.json.conversationId as string;
    expect(first.json.title).toBe("Poking at the notes file");

    for (let i = 0; i < RETITLE_MIN_TURNS; i++) await post(app, "/chat", { text: `turn ${i}`, sessionId });

    // The rail card's source of truth — routed through the live session, so it
    // is the same title event X-12b's endpoint leans on.
    const view = (await (await app.request(`/session/${sessionId}`)).json()) as { title: string };
    expect(view.title).toBe("Rewriting the append log");

    // …and the index the history list reads, plus the log a resume reads.
    await store.flush();
    const rows = (await (await app.request("/conversations")).json()) as { conversations: { title?: string }[] };
    expect(rows.conversations[0]!.title).toBe("Rewriting the append log");
    expect(store.list("/work/test")[0]!.title).toBe("Rewriting the append log");
    expect(store.load(convId)!.title).toBe("Rewriting the append log");
    expect(store.load(convId)!.titleSource).toBe("auto");
  });

  it("leaves a name renamed from a history row alone, however far the thread runs", async () => {
    const { driver, titleCalls } = driftDriver(["Poking at the notes file", "Would have re-titled"]);
    const app = makeApp(driver);
    const first = await post(app, "/chat", { text: "hello" });
    const sessionId = first.json.sessionId as string;
    const convId = first.json.conversationId as string;

    // X-12b's conversation-scoped rename, which routes through the live session.
    const renamed = await post(app, `/conversation/${convId}/title`, { title: "What I call it" });
    expect(renamed.status).toBe(200);

    for (let i = 0; i < RETITLE_MIN_TURNS * 2; i++) await post(app, "/chat", { text: `turn ${i}`, sessionId });

    await store.flush();
    expect(titleCalls()).toBe(1); // the pre-rename auto title, and nothing since
    expect(store.list("/work/test")[0]!.title).toBe("What I call it");
    expect(store.load(convId)!.titleSource).toBe("manual");
    const view = (await (await app.request(`/session/${sessionId}`)).json()) as { title: string };
    expect(view.title).toBe("What I call it");
  });
});

describe("serve's session factory carries the drift setting (X-17)", () => {
  let dir: string;
  let paths: JlcodePaths;
  let catalog: ModelCatalog;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-retitle-factory-"));
    paths = resolvePaths({ JLCODE_CONFIG_DIR: path.join(dir, "config"), JLCODE_DATA_DIR: path.join(dir, "data") });
    fs.mkdirSync(paths.configDir, { recursive: true });
    catalog = new ModelCatalog({
      file: paths.modelsCacheFile,
      fetch: (async () =>
        new Response(JSON.stringify({ data: [{ id: "m", context_length: 200000 }] }), {
          status: 200,
        })) as unknown as typeof fetch,
    });
    await catalog.refresh();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** Built the way `serve` builds them — the level H-06 proved a `Session` test
   *  cannot see, and where an option that never reaches production would hide. */
  const build = (driver: LlmDriver, over: Partial<ModelConfig> = {}): Session =>
    createSessionFactory({ paths, cwd: dir, makeDriver: () => driver, mcpTools: () => [], catalog })({
      ...config,
      ...over,
    });

  it("re-titles by default", async () => {
    const { driver, titleCalls } = driftDriver(["First topic", "What it became"]);
    const session = build(driver);
    for (let i = 0; i <= RETITLE_MIN_TURNS; i++) await session.send(`turn ${i}`);
    expect(titleCalls()).toBe(2);
    expect(session.conversation.title).toBe("What it became");
  });

  it("obeys `autoRetitle: false` in the config", async () => {
    const { driver, titleCalls } = driftDriver(["First topic", "Would have re-titled"]);
    const session = build(driver, { autoRetitle: false });
    for (let i = 0; i <= RETITLE_MIN_TURNS; i++) await session.send(`turn ${i}`);
    expect(titleCalls()).toBe(1);
    expect(session.conversation.title).toBe("First topic");
  });
});

describe("reaching the opt-out from the CLI (X-17)", () => {
  let dir: string;
  let paths: JlcodePaths;
  const saved = { config: process.env.JLCODE_CONFIG_DIR, data: process.env.JLCODE_DATA_DIR };
  let restoreOut = () => {};
  let out: string[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-retitle-cli-"));
    process.env.JLCODE_CONFIG_DIR = path.join(dir, "config");
    process.env.JLCODE_DATA_DIR = path.join(dir, "data");
    paths = resolvePaths(process.env);
    fs.mkdirSync(paths.configDir, { recursive: true });
    const { config: withOne } = addModelConfig(loadConfig(paths), {
      name: "Opus",
      model: "m",
      openRouterKey: "sk",
      defaultMode: "code",
      defaultApproval: "manual",
    });
    saveConfig(withOne, paths);
    out = [];
    const realOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => (out.push(String(s)), true)) as typeof process.stdout.write;
    restoreOut = () => {
      process.stdout.write = realOut;
    };
  });
  afterEach(() => {
    restoreOut();
    process.env.JLCODE_CONFIG_DIR = saved.config;
    process.env.JLCODE_DATA_DIR = saved.data;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const stored = () => loadConfig(paths).modelConfigs[0]!;

  it("turns drift re-titling off and back on without hand-editing JSON", async () => {
    expect(await runConfig(["set", "Opus", "--auto-retitle", "off"])).toBe(0);
    expect(stored().autoRetitle).toBe(false);
    await runConfig(["use", "Opus"]);
    await runConfig(["which", "--offline"]);
    expect(out.join("")).toContain("auto re-title off");

    await runConfig(["set", "Opus", "--auto-retitle", "on"]);
    expect(stored().autoRetitle).toBeUndefined(); // back to the default, unwritten
  });

  it("refuses anything but on/off", async () => {
    await expect(runConfig(["set", "Opus", "--auto-retitle", "maybe"])).rejects.toThrow(/"on" or "off"/);
  });
});
