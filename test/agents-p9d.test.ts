/**
 * P9d — addressed questions, stricter children, the tool-rounds off switch
 * (X-56 Q8/Q10/Q16, D-88/D-89).
 *
 *   - `ask` with no `to` goes to whoever opened the current turn; `parent` on a
 *     root is refused;
 *   - a question to the parent agent is answered by the parent's reply, and by
 *     nobody else's — anyone else's message queues — while the person can always
 *     answer;
 *   - `spawn_agent`'s `mode` may only tighten, and a stricter child stays
 *     stricter across a revival;
 *   - `--tool-rounds off` (root governs) and the card's "don't ask again"
 *     switch the pause off; the second is logged and survives a restart; the
 *     spend cap still stops the run.
 *
 * Tier 0: the fake driver plus a parent stand-in that answers questions; waits
 * are on events and the coordinator's in-flight work, never on a clock.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createServer } from "../src/server/server";
import { createSessionFactory } from "../src/server/session-factory";
import { ConversationStore } from "../src/persist/conversation-store";
import { ModelCatalog } from "../src/llm/models";
import { loadConfig, saveConfig, defaultConfig } from "../src/config/store";
import { addModelConfig, resolveForCwd, setBinding, deriveModelConfig, toolRoundsOff } from "../src/config/operations";
import { resolvePaths, type JlcodePaths } from "../src/paths";
import { fakeAgentDriver } from "../src/session/fake";
import { stripEnvironmentDetails } from "../src/conversation/wire";
import { Session, type AgentHost } from "../src/session/session";
import { ToolRegistry } from "../src/tools/registry";
import { fileTools } from "../src/tools/file-tools";
import { Sandbox } from "../src/tools/sandbox";
import { askTool } from "../src/tools/ask-user";
import { agentTools } from "../src/tools/agent-tools";
import { nonDefaultSettings } from "../src/config/model-command";
import { runConfig } from "../src/config/commands";
import type { ChatMessage, ChatRequest, LlmDriver, StreamEvent } from "../src/llm/types";
import type { ModelConfig } from "../src/config/types";
import type { Entry } from "../src/conversation/types";
import type { SessionManager } from "../src/session/manager";

const OPUS = "anthropic/claude-opus-5";
const SONNET = "anthropic/claude-sonnet-5";
const KEY_A = "sk-or-v1-client-a-0000000000aaaa";

const CATALOG = {
  fetchedAt: "2099-01-01T00:00:00.000Z",
  windows: { [OPUS]: 1_000_000, [SONNET]: 200_000 },
  modalities: { [OPUS]: ["text"], [SONNET]: ["text"] },
  prices: {},
  limits: {},
};

let dir: string;
let paths: JlcodePaths;
let workspace: string;
let convDir: string;
let store: ConversationStore;
let catalog: ModelCatalog;
let seeded: { opus: ModelConfig; sonnet: ModelConfig };
let requests: ChatRequest[];
const saved = { config: process.env.JLCODE_CONFIG_DIR, data: process.env.JLCODE_DATA_DIR };

function reply(t: string): StreamEvent[] {
  return [
    { type: "text", delta: t },
    { type: "finish", reason: "stop" },
    { type: "usage", usage: { promptTokens: 1000, completionTokens: 10 } },
  ];
}

/**
 * The fake agent driver, plus a parent that answers a sub-agent's question:
 * a `[Question from your sub-agent "agent-N" …]` message gets `send_message(to:
 * agent-N, text: "blue")` — unless the question says `noreply`, when the parent
 * just says something and leaves it to the person.
 */
function treeDriver(): LlmDriver {
  const fake = fakeAgentDriver();
  return {
    async *streamChat(req, opts): AsyncGenerator<StreamEvent> {
      requests.push(req);
      const last = req.messages[req.messages.length - 1];
      const said = last?.role === "user" && typeof last.content === "string" ? stripEnvironmentDetails(last.content).trim() : "";
      const q = /^\[Question from your sub-agent "([^"]+)"[\s\S]*?\]\n\n([\s\S]*)$/.exec(said);
      if (q) {
        if (q[2]!.includes("noreply")) {
          yield* reply("I will leave that one to the person.");
          return;
        }
        yield { type: "tool_call", index: 0, id: `ans_${requests.length}`, name: "send_message", argsDelta: JSON.stringify({ to: q[1], text: "blue" }) };
        yield { type: "finish", reason: "tool_calls" };
        yield { type: "usage", usage: { promptTokens: 1000, completionTokens: 10 } };
        return;
      }
      yield* fake.streamChat(req, opts);
    },
  };
}

function seed(over: { opus?: Partial<ModelConfig>; sonnet?: Partial<ModelConfig> } = {}) {
  const base = {
    defaultMode: "code" as const,
    defaultApproval: "full-auto" as const,
    compaction: { auto: true },
    pricing: { promptPerMTok: 1, completionPerMTok: 1 },
    environment: { turnTimestamps: false },
  };
  let cfg = defaultConfig();
  const a = addModelConfig(cfg, { ...base, name: "opus", model: OPUS, openRouterKey: KEY_A, ...over.opus });
  const b = addModelConfig(a.config, { ...base, name: "sonnet", model: SONNET, openRouterKey: KEY_A, ...over.sonnet });
  cfg = setBinding(b.config, workspace, a.added.id);
  saveConfig(cfg, paths);
  seeded = { opus: a.added, sonnet: b.added };
}

function makeServer() {
  const deps = { paths, cwd: workspace, makeDriver: treeDriver, mcpTools: () => [], catalog };
  return createServer({
    resolveConfig: () => resolveForCwd(loadConfig(paths), workspace),
    newSession: createSessionFactory(deps),
    listConfigs: () => loadConfig(paths).modelConfigs,
    store,
    workingDir: workspace,
    version: "0.0.0",
  });
}
type Server = ReturnType<typeof makeServer>;

async function post(app: Server["app"], url: string, body: unknown) {
  const res = await app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

function until(manager: SessionManager, pred: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (pred()) return resolve();
    const unsub = manager.subscribe(() => {
      if (pred()) {
        unsub();
        resolve();
      }
    });
  });
}

const named = (manager: SessionManager, name: string) => manager.list().find((s) => s.agentInfo?.name === name);
const toolResults = (s: Session) => s.conversation.entries.filter((e): e is Extract<Entry, { type: "tool" }> => e.type === "tool");
const inbound = (s: Session) =>
  s.conversation.entries.filter((e): e is Extract<Entry, { type: "user" }> => e.type === "user" && e.inbound !== undefined);

/** Every `tool_calls` message on the wire is answered before anything else (D-84). */
function everyCallAnswered(messages: ChatMessage[]): boolean {
  for (let i = 0; i < messages.length; i++) {
    const ids = (messages[i]!.tool_calls ?? []).map((c) => c.id);
    for (let j = 0; j < ids.length; j++) {
      const m = messages[i + 1 + j];
      if (m?.role !== "tool" || !ids.includes(m.tool_call_id ?? "")) return false;
    }
  }
  return true;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-p9d-"));
  process.env.JLCODE_CONFIG_DIR = path.join(dir, "config");
  process.env.JLCODE_DATA_DIR = path.join(dir, "data");
  paths = resolvePaths();
  fs.mkdirSync(path.dirname(paths.modelsCacheFile), { recursive: true });
  fs.writeFileSync(paths.modelsCacheFile, JSON.stringify(CATALOG), "utf8");
  workspace = path.join(dir, "work");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "notes.txt"), "the notes\n");
  convDir = path.join(dir, "conversations");
  store = new ConversationStore(convDir);
  catalog = new ModelCatalog({ file: paths.modelsCacheFile });
  requests = [];
});

afterEach(async () => {
  await store.close();
  process.env.JLCODE_CONFIG_DIR = saved.config;
  process.env.JLCODE_DATA_DIR = saved.data;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the question tool", () => {
  it("is offered as `ask`, takes `to`, and still understands `ask_user` from older logs", async () => {
    const def = askTool().def.function;
    expect(def.name).toBe("ask");
    expect((def.parameters as any).properties.to.enum).toEqual(["user", "parent"]);
    seed();
    // A model that calls the old name (it is all over pre-P9d history) still
    // gets the question card, not "unknown tool".
    const s = new Session({
      config: { ...seeded.opus },
      driver: {
        async *streamChat() {
          yield { type: "tool_call", index: 0, id: "old_1", name: "ask_user", argsDelta: JSON.stringify({ question: "Old name?" }) };
          yield { type: "finish", reason: "tool_calls" };
        },
      },
      tools: new ToolRegistry([...fileTools(), askTool()]),
      sandbox: new Sandbox([workspace]),
    });
    await s.send("go");
    expect(s.status).toBe("awaiting-input");
    expect(s.awaitingInput?.questions[0]!.question).toBe("Old name?");
  });
});

describe("the default addressee is whoever opened the current turn", () => {
  it("a person's turn asks the person; `parent` on a root is refused", async () => {
    seed();
    const { app, manager } = makeServer();
    const first = await post(app, "/chat", { text: "ask: Which colour?" });
    const root = manager.get(first.json.sessionId as string)!;
    expect(root.status).toBe("awaiting-input");
    expect(root.awaitingInput?.to).toBeUndefined(); // the person's
    await post(app, `/session/${root.id}/answer`, { text: "red" });
    expect(root.status).toBe("idle");

    await post(app, "/chat", { sessionId: root.id, text: "ask@parent: Which colour?" });
    expect(root.status).toBe("idle"); // nothing was asked
    const refusal = toolResults(root).at(-1)!;
    expect(refusal).toMatchObject({ name: "ask", isError: true });
    expect(refusal.content).toMatch(/you have no parent agent — ask the user/);
  });

  it("a sub-agent's task turn asks its parent, whose reply is the answer", async () => {
    seed();
    const { app, manager, agents } = makeServer();
    const first = await post(app, "/chat", { text: "spawn: ask: Which colour?" });
    await agents.idle();
    const root = manager.get(first.json.sessionId as string)!;
    const child = named(manager, "agent-1")!;

    // The question reached the parent as a message from the child…
    const asked = inbound(root).find((e) => e.inbound!.kind === "question")!;
    expect(asked.inbound).toMatchObject({ from: "agent-1", kind: "question" });
    expect(asked.text).toMatch(/^\[Question from your sub-agent "agent-1" — it is paused until it gets an answer\./);
    expect(asked.text).toContain("Which colour? (suggested: Yes / No)");
    // …and the parent's reply answered it, as the ask's result — not as a
    // message riding the child's queue.
    const answer = toolResults(child).find((t) => t.name === "ask")!;
    expect(answer).toMatchObject({ isError: false, content: '[Answer from your parent agent "root"]\n\nblue' });
    expect(inbound(child).map((e) => e.inbound!.kind)).toEqual(["task"]);
    expect(toolResults(root).find((t) => t.name === "send_message")!.content).toMatch(/as the answer to its question/);
    expect(child.status).toBe("idle");
    expect(child.queuedMessages).toEqual([]);
    // The child then carried on and finished, and its parent heard.
    expect(inbound(root).some((e) => e.inbound!.kind === "finished")).toBe(true);
    // H-10: every request the child made answered every call.
    for (const r of requests) expect(everyCallAnswered(r.messages)).toBe(true);
  });

  it("a person typing in a sub-agent's view opens a turn that asks the person", async () => {
    seed();
    const { app, manager, agents } = makeServer();
    await post(app, "/chat", { text: "spawn: say hi" });
    await agents.idle();
    const child = named(manager, "agent-1")!;
    await child.send("ask: Which colour?");
    expect(child.status).toBe("awaiting-input");
    expect(child.awaitingInput?.to).toBeUndefined();
    // Explicit `to: parent` overrides the default either way.
    await post(app, `/session/${child.id}/answer`, { text: "red" });
    await agents.idle();
    await child.send("ask@parent: noreply — which shade?");
    expect(child.awaitingInput?.to).toBe("parent");
    await agents.idle();
  });

  it("a root's turn an agent opened still asks the person — it has no parent", async () => {
    seed();
    const { app, manager, agents } = makeServer();
    const first = await post(app, "/chat", { text: "spawn: msg: parent | ask: Which colour?" });
    await agents.idle();
    const root = manager.get(first.json.sessionId as string)!;
    await until(manager, () => root.status === "awaiting-input");
    expect(root.awaitingInput?.to).toBeUndefined();
  });
});

describe("only the addressee or the person answers", () => {
  it("the parent's message to a child asking the person queues; the person's answer lands first", async () => {
    seed();
    const { app, manager, agents } = makeServer();
    const first = await post(app, "/chat", { text: "spawn: ask@user: Which colour?" });
    await agents.idle();
    const root = manager.get(first.json.sessionId as string)!;
    const child = named(manager, "agent-1")!;
    expect(child.status).toBe("awaiting-input");
    expect(child.awaitingInput?.to).toBeUndefined();
    // Not the person's question going to the parent: no question message.
    expect(inbound(root).some((e) => e.inbound!.kind === "question")).toBe(false);

    await post(app, "/chat", { sessionId: root.id, text: "msg: agent-1 | purple" });
    await agents.idle();
    expect(child.status).toBe("awaiting-input"); // still waiting on the person
    expect(child.queuedMessages.map((q) => q.inbound?.from)).toEqual(["root"]);
    expect(toolResults(child).some((t) => t.name === "ask")).toBe(false);

    await post(app, `/session/${child.id}/answer`, { text: "green" });
    await agents.idle();
    const results = toolResults(child);
    expect(results.find((t) => t.name === "ask")!.content).toBe("green");
    // The parent's message landed after the answer, as an ordinary message.
    const msg = inbound(child).find((e) => e.inbound!.kind === "message")!;
    expect(msg.text).toBe('[Message from your parent agent "root"]\n\npurple');
    const at = (id: string) => child.conversation.entries.findIndex((e) => e.id === id);
    expect(at(msg.id)).toBeGreaterThan(at(results.find((t) => t.name === "ask")!.id));
  });

  it("a grandchild's message to a child asking its parent queues", async () => {
    seed();
    const { app, manager, agents } = makeServer();
    // agent-1 asks root (noreply, so root leaves it); agent-1 has a child.
    await post(app, "/chat", { text: "spawn: spawn: say hi" });
    await agents.idle();
    const child = named(manager, "agent-1")!;
    const grandchild = named(manager, "agent-2")!;
    await child.send("ask@parent: noreply — which shade?");
    await agents.idle();
    expect(child.asksParent).toBe(true);
    await grandchild.send("msg: parent | from below");
    await agents.idle();
    expect(child.status).toBe("awaiting-input");
    // Its message and its completion notice both wait behind the question.
    expect(child.queuedMessages.map((q) => [q.inbound?.from, q.inbound?.kind])).toEqual([
      ["agent-2", "message"],
      ["agent-2", "finished"],
    ]);
    expect(toolResults(child).some((t) => t.name === "ask")).toBe(false);
  });

  it("the person always answers — a question to the parent included; the parent's late reply is just a message", async () => {
    seed();
    const { app, manager, agents } = makeServer();
    const first = await post(app, "/chat", { text: "spawn: ask@parent: noreply — which shade?" });
    await agents.idle();
    const root = manager.get(first.json.sessionId as string)!;
    const child = named(manager, "agent-1")!;
    expect(child.awaitingInput?.to).toBe("parent");
    // A question for the parent agent does not light the parent's "waiting
    // for you" flag — it is the parent's to answer.
    expect(root.subtree).toMatchObject({ waiting: 0 });

    const answered = await post(app, `/session/${child.id}/answer`, { text: "teal" });
    expect(answered.status).toBe(200);
    await agents.idle();
    expect(toolResults(child).find((t) => t.name === "ask")!.content).toBe("teal");

    await post(app, "/chat", { sessionId: root.id, text: "msg: agent-1 | blue after all" });
    await agents.idle();
    expect(toolResults(root).at(-1)!.content).toBe('Sent to "agent-1".');
    expect(inbound(child).at(-1)!.text).toBe('[Message from your parent agent "root"]\n\nblue after all');
  });
});

describe("an answered turn waits for a slot like any agent-started turn", () => {
  function child(opts: { slot: boolean }) {
    let slot = opts.slot;
    const asked: string[] = [];
    const host: AgentHost = {
      spawn: async () => "started",
      send: () => "sent",
      listModels: () => "",
      admit: () => slot,
      treeSpendUsd: (s) => s.spendUsd,
      subtree: () => ({ agents: 0, running: 0, queued: 0, waiting: 0, spendUsd: 0 }),
      askParent: (_s, r) => void asked.push(r.questions[0]!.question),
    };
    const calls: ChatRequest[] = [];
    const inner = fakeAgentDriver();
    const s = new Session({
      config: { ...seeded.opus },
      driver: {
        async *streamChat(req, o) {
          calls.push(req);
          yield* inner.streamChat(req, o);
        },
      },
      tools: new ToolRegistry([...fileTools(), askTool(), ...agentTools()]),
      sandbox: new Sandbox([workspace]),
    });
    s.setAgentHost(host, { name: "agent-1", depth: 1, parentSessionId: "p", rootSessionId: "p" });
    const outcomes: string[] = [];
    s.onEvent((e) => {
      if (e.type === "settled") outcomes.push(e.outcome);
    });
    return { s, calls, asked, outcomes, open: () => (slot = true) };
  }

  it("queues without a slot, and starts when given one", async () => {
    seed();
    const t = child({ slot: false });
    await t.s.send("ask@parent: Which colour?");
    expect(t.asked).toEqual(["Which colour?"]);
    expect(t.s.answerFromParent("root", "blue")).toBe(true);
    expect(t.s.status).toBe("queued");
    await t.s.resumeAnswered(); // no slot: stays queued
    expect(t.s.status).toBe("queued");
    t.open();
    await t.s.startQueued();
    expect(t.s.status).toBe("idle");
    expect(t.outcomes).toEqual(["finished"]);
    for (const r of t.calls) expect(everyCallAnswered(r.messages)).toBe(true);
  });

  for (const scope of ["soft", "hard"] as const) {
    it(`a ${scope} Stop ends a queued answered turn, and nothing restarts it`, async () => {
      seed();
      const t = child({ slot: false });
      await t.s.send("ask@parent: Which colour?");
      t.s.answerFromParent("root", "blue");
      const before = t.calls.length;
      t.s.stop(scope);
      expect(t.s.status).toBe("idle");
      expect(t.outcomes).toEqual(["stopped"]);
      t.open();
      await t.s.startQueued();
      await t.s.resumeAnswered();
      expect(t.calls).toHaveLength(before);
      // The next message is a valid request (H-10).
      await t.s.send("hello");
      for (const r of t.calls) expect(everyCallAnswered(r.messages)).toBe(true);
    });
  }

  it("an answer under a persistence fault lands, and the turn resumes once the fault clears", async () => {
    seed();
    const t = child({ slot: true });
    await t.s.send("ask@parent: Which colour?");
    t.s.raisePersistenceFault({ filePath: "x.jsonl", message: "ENOSPC", pending: 1 });
    expect(t.s.answerFromParent("root", "blue")).toBe(true);
    expect(t.s.status).toBe("awaiting-persistence"); // nothing resumes under a fault (D-46)
    await t.s.resumeAnswered();
    expect(t.s.status).toBe("awaiting-persistence");
    t.s.discardPersistence(() => 0);
    await t.s.recovered;
    expect(t.s.status).toBe("idle");
    expect(t.outcomes).toEqual(["finished"]);
    for (const r of t.calls) expect(everyCallAnswered(r.messages)).toBe(true);
  });

  it("a reply that lands before the session is paused on the card queues instead of answering", async () => {
    seed();
    const t = child({ slot: true });
    // `awaiting-input` is emitted while the question is set but the loop has not
    // yet reached the pause: the window a parent's reply could fall into.
    let early: boolean | undefined;
    t.s.onEvent((e) => {
      if (e.type === "awaiting-input") early = t.s.answerFromParent("root", "too soon");
    });
    await t.s.send("ask@parent: Which colour?");
    expect(early).toBe(false);
    expect(t.s.status).toBe("awaiting-input");
    expect(t.s.asksParent).toBe(true); // still asked, still answerable
    expect(t.s.answerFromParent("root", "blue")).toBe(true);
    await t.s.resumeAnswered();
    expect(t.s.status).toBe("idle");
    expect(toolResults(t.s).find((r) => r.name === "ask")!.content).toBe('[Answer from your parent agent "root"]\n\nblue');
  });

  it("an answer after the person already answered changes nothing", async () => {
    seed();
    const t = child({ slot: true });
    await t.s.send("ask@parent: Which colour?");
    await t.s.answer("red");
    expect(t.s.answerFromParent("root", "blue")).toBe(false);
    expect(toolResults(t.s).filter((r) => r.name === "ask").map((r) => r.content)).toEqual(["red"]);
  });
});

describe("spawn_agent's mode may only tighten", () => {
  it("refuses a looser mode and starts nothing", async () => {
    seed({ opus: { defaultMode: "plan" } });
    const { app, manager, agents } = makeServer();
    const first = await post(app, "/chat", { text: "spawn#code: write: x.md | hi" });
    await agents.idle();
    const root = manager.get(first.json.sessionId as string)!;
    expect(root.mode).toBe("plan");
    const refusal = toolResults(root).find((t) => t.name === "spawn_agent")!;
    expect(refusal.isError).toBe(true);
    expect(refusal.content).toMatch(/^spawn_agent refused: you are in plan mode/);
    expect(manager.list()).toHaveLength(1);
  });

  it("runs a stricter child in its mode, and a revival keeps it stricter", async () => {
    seed();
    const { app, manager, agents } = makeServer();
    const first = await post(app, "/chat", { text: "spawn#ask: write: out.txt | hi" });
    await agents.idle();
    const root = manager.get(first.json.sessionId as string)!;
    const child = named(manager, "agent-1")!;
    expect(child.mode).toBe("ask");
    expect(toolResults(child).find((t) => t.name === "write_file")!.content).toMatch(/Ask mode is read-only/);
    expect(fs.existsSync(path.join(workspace, "out.txt"))).toBe(false);
    expect(store.agents(root.conversation.id)[0]).toMatchObject({ name: "agent-1", mode: "ask" });

    await post(app, `/session/${child.id}/close`, {});
    await store.flush();
    await post(app, "/chat", { sessionId: root.id, text: "msg: agent-1 | welcome back" });
    await agents.idle();
    expect(named(manager, "agent-1")!.mode).toBe("ask");
  });

  it("records an explicit mode equal to the parent's, so loosening the parent later never loosens the revived child", async () => {
    seed({ opus: { defaultMode: "plan" } });
    const { app, manager, agents } = makeServer();
    const first = await post(app, "/chat", { text: "spawn#plan: say hi" });
    await agents.idle();
    const root = manager.get(first.json.sessionId as string)!;
    const child = named(manager, "agent-1")!;
    expect(child.mode).toBe("plan");
    expect(store.agents(root.conversation.id)[0]).toMatchObject({ name: "agent-1", mode: "plan" });

    root.setModeApproval("code"); // the person loosens the parent
    await post(app, `/session/${child.id}/close`, {});
    await store.flush();
    await post(app, "/chat", { sessionId: root.id, text: "msg: agent-1 | welcome back" });
    await agents.idle();
    expect(named(manager, "agent-1")!.mode).toBe("plan");
  });

  it("rejects a mode that is not one", async () => {
    seed();
    const { app, manager, agents } = makeServer();
    const first = await post(app, "/chat", { text: "spawn#sudo: say hi" });
    await agents.idle();
    const root = manager.get(first.json.sessionId as string)!;
    expect(toolResults(root).find((t) => t.name === "spawn_agent")!.content).toMatch(/`mode` is one of ask, plan, code/);
  });
});

describe("the tool-round pause can be switched off (D-89)", () => {
  const opusRounds = (rounds: number) => ({ opus: { commands: { toolRounds: rounds } } });

  it("'don't ask again' continues past the budget, stops at the spend cap, and survives a restart via the log", async () => {
    seed(opusRounds(2));
    let server = makeServer();
    const first = await post(server.app, "/chat", { text: "loop: notes.txt" });
    const id = first.json.sessionId as string;
    let s = server.manager.get(id)!;
    expect(s.status).toBe("awaiting-continue");
    const convId = s.conversation.id;
    // Raise a cap so the unbraked loop has something to stop it.
    await post(server.app, `/session/${id}/cap`, { capUsd: s.spendUsd + 0.008 });
    let stalls = 0;
    s.onEvent((e) => void (e.type === "awaiting-continue" && stalls++));
    const res = await post(server.app, `/session/${id}/continue`, { dontAskAgain: true });
    expect(res.status).toBe(200);
    expect(stalls).toBe(0); // far past the budget of 2 (then 4): never paused again
    expect(s.capReached).toBe(true); // …and the spend cap still stopped it
    expect(toolResults(s).length).toBeGreaterThan(4);
    expect(s.roundsOff).toBe(true);

    // Restart: a new store and server over the same files.
    await store.flush();
    expect(fs.readFileSync(store.filePath(convId), "utf8")).toContain('"kind":"rounds-off"');
    await store.close();
    store = new ConversationStore(convDir);
    expect(store.load(convId)!.roundsOff).toBe(true);
    server = makeServer();
    const resumed = await post(server.app, "/chat", { conversationId: convId, text: "hello again" });
    s = server.manager.get(resumed.json.sessionId as string)!;
    expect(s.roundsOff).toBe(true);
    await post(server.app, `/session/${s.id}/cap`, { capUsd: s.spendUsd + 0.008 });
    stalls = 0;
    s.onEvent((e) => void (e.type === "awaiting-continue" && stalls++));
    await post(server.app, "/chat", { sessionId: s.id, text: "loop: notes.txt" });
    expect(stalls).toBe(0);
    expect(s.capReached).toBe(true);
  });

  it("a plain Continue writes nothing and the pause comes back", async () => {
    seed(opusRounds(2));
    const { app, manager } = makeServer();
    const first = await post(app, "/chat", { text: "loop: notes.txt" });
    const s = manager.get(first.json.sessionId as string)!;
    await post(app, `/session/${s.id}/continue`, {});
    expect(s.status).toBe("awaiting-continue");
    expect(s.awaitingContinue).toMatchObject({ budget: 4 });
    expect(s.conversation.roundsOff).toBeUndefined();
    await store.flush();
    expect(fs.readFileSync(store.filePath(s.conversation.id), "utf8")).not.toContain("rounds-off");
    s.stop("hard");
  });

  it("a thread's 'don't ask again' covers its sub-agents, never its parent", async () => {
    seed();
    const { app, manager, agents } = makeServer();
    const first = await post(app, "/chat", { text: "spawn: spawn: say hi" });
    await agents.idle();
    const root = manager.get(first.json.sessionId as string)!;
    const child = named(manager, "agent-1")!;
    const grandchild = named(manager, "agent-2")!;
    expect([root.roundsOff, child.roundsOff, grandchild.roundsOff]).toEqual([false, false, false]);
    child.conversation.roundsOff = true; // what the card's button records on agent-1
    expect([root.roundsOff, child.roundsOff, grandchild.roundsOff]).toEqual([false, true, true]);
    root.conversation.roundsOff = true;
    expect(grandchild.roundsOff).toBe(true);
  });

  it("`--tool-rounds off` is read from the root's config, live, for the whole tree", async () => {
    seed({ sonnet: { commands: { toolRounds: 0 } } });
    const { app, manager, agents } = makeServer();
    const first = await post(app, "/chat", { text: "spawn@sonnet: say hi" });
    await agents.idle();
    const root = manager.get(first.json.sessionId as string)!;
    const child = named(manager, "agent-1")!;
    expect(child.config.name).toBe("sonnet");
    expect(child.roundsOff).toBe(false); // its own config says off; the root's does not

    const cfg = loadConfig(paths);
    saveConfig(
      {
        ...cfg,
        modelConfigs: cfg.modelConfigs.map((m) => (m.id === seeded.opus.id ? { ...m, commands: { toolRounds: 0 } } : m)),
      },
      paths,
    );
    expect(child.roundsOff).toBe(true); // the root switched it off, read live
    expect(root.roundsOff).toBe(true);
  });

  it("an unbraked loop still lets the process breathe: a Stop from a timer lands", async () => {
    seed(opusRounds(0));
    const s = new Session({
      config: { ...seeded.opus },
      driver: fakeAgentDriver(),
      tools: new ToolRegistry(fileTools()),
      sandbox: new Sandbox([workspace]),
      maxToolIterations: 2,
    });
    // `loop:` on a missing file touches no I/O at all — without the yield past
    // the budget, this timer would never fire and `send` would never return.
    setTimeout(() => s.stop("hard"), 50);
    await s.send("loop: missing.md");
    expect(s.status).toBe("idle");
    expect(toolResults(s).length).toBeGreaterThan(2);
  });

  it("a lone session reads its own config and mark", () => {
    seed(opusRounds(0));
    const s = new Session({ config: { ...seeded.opus }, driver: fakeAgentDriver() });
    expect(s.roundsOff).toBe(true);
    const t = new Session({ config: { ...seeded.sonnet }, driver: fakeAgentDriver() });
    expect(t.roundsOff).toBe(false);
  });
});

describe("the --tool-rounds config flag", () => {
  let out: string[];
  let restore: () => void;
  beforeEach(() => {
    seed();
    out = [];
    const real = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => (out.push(String(s)), true)) as typeof process.stdout.write;
    restore = () => (process.stdout.write = real);
  });
  afterEach(() => restore());
  const stored = () => loadConfig(paths).modelConfigs.find((c) => c.name === "opus")!;

  it("sets a number, off and default, and reads each back", async () => {
    expect(await runConfig(["set", "opus", "--tool-rounds", "80", "--offline"])).toBe(0);
    expect(stored().commands?.toolRounds).toBe(80);
    expect(out.join("")).toContain("tool rounds: pause after 80 model turns on one message; Continue doubles it");
    await runConfig(["set", "opus", "--tool-rounds", "off", "--offline"]);
    expect(stored().commands?.toolRounds).toBe(0);
    expect(toolRoundsOff(stored())).toBe(true);
    expect(out.join("")).toContain("tool rounds: off — no pause");
    await runConfig(["set", "opus", "--tool-rounds", "default", "--offline"]);
    expect(stored().commands?.toolRounds).toBeUndefined();
  });

  it("rejects malformed values", async () => {
    await expect(runConfig(["set", "opus", "--tool-rounds", "0", "--offline"])).rejects.toThrow(/positive whole number/);
    await expect(runConfig(["set", "opus", "--tool-rounds", "1.5", "--offline"])).rejects.toThrow(/positive whole number/);
  });

  it("config which states it, default included", async () => {
    const cwd = process.cwd();
    process.chdir(workspace);
    try {
      expect(await runConfig(["which", "--offline"])).toBe(0);
    } finally {
      process.chdir(cwd);
    }
    expect(out.join("")).toContain("tool rounds: pause after 50 model turns on one message");
  });

  it("config model carries it, and prints it when it is not the default", () => {
    const source = { ...stored(), commands: { toolRounds: 0 } };
    expect(deriveModelConfig(source, { model: SONNET, name: "x" }).commands).toEqual({ toolRounds: 0 });
    expect(nonDefaultSettings(source)).toContain("toolRounds:off");
  });
});
