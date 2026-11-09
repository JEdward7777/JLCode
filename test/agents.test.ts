/**
 * P9c — the agent core: tree storage, spawn/message, and the brakes (X-56,
 * D-88/D-89).
 *
 * A sub-agent is an ordinary session in the bag, linked to its parent by the
 * coordinator and persisted into its root's one JSONL file. These hold the
 * slice's edges in place:
 *
 *   - the fake driver runs a parent and its children end to end, and the tree
 *     folds back per agent from one interleaved file;
 *   - an agent message is on disk when it is *sent*, so one owed a reply
 *     survives a crash;
 *   - depth refuses, width queues (FIFO) and never refuses;
 *   - agent messages continue the tool-round budget, a human one resets it;
 *   - a model on another key is refused, naming the allowed ones;
 *   - a message to a busy child lands at its next tool-loop pass;
 *   - Stop reaches the subtree, spend rolls up, a child's approval lights its
 *     parent.
 *
 * Tier 0: the fake driver (`src/session/fake.ts`) and gated stand-ins; waits are
 * on events and on the coordinator's own in-flight work, never on a clock.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createServer } from "../src/server/server";
import { createSessionFactory } from "../src/server/session-factory";
import { ConversationStore, agentConversationId } from "../src/persist/conversation-store";
import { ModelCatalog } from "../src/llm/models";
import { loadConfig, saveConfig, defaultConfig } from "../src/config/store";
import { addModelConfig, resolveForCwd, setBinding, deriveModelConfig } from "../src/config/operations";
import { resolvePaths, type JlcodePaths } from "../src/paths";
import { fakeAgentDriver } from "../src/session/fake";
import { buildWireMessages, stripEnvironmentDetails } from "../src/conversation/wire";
import { Session } from "../src/session/session";
import { ToolRegistry } from "../src/tools/registry";
import { fileTools } from "../src/tools/file-tools";
import { Sandbox } from "../src/tools/sandbox";
import { nonDefaultSettings } from "../src/config/model-command";
import { runConfig } from "../src/config/commands";
import type { ChatRequest, LlmDriver, StreamEvent } from "../src/llm/types";
import type { ModelConfig } from "../src/config/types";
import type { Entry } from "../src/conversation/types";
import type { SessionManager } from "../src/session/manager";
import type { Tool } from "../src/tools/types";
import type { ChatMessage } from "../src/llm/types";
import { ModeApprovalGate } from "../src/tools/mode-gate";
import { agentTools as agentToolsForTest } from "../src/tools/agent-tools";
import type { AgentHost } from "../src/session/session";

const OPUS = "anthropic/claude-opus-5";
const SONNET = "anthropic/claude-sonnet-5";
const HAIKU = "anthropic/claude-haiku-5";
const KEY_A = "sk-or-v1-client-a-0000000000aaaa";
const KEY_B = "sk-or-v1-client-b-0000000000bbbb";

const CATALOG = {
  fetchedAt: "2099-01-01T00:00:00.000Z",
  windows: { [OPUS]: 1_000_000, [SONNET]: 200_000, [HAIKU]: 100_000 },
  modalities: { [OPUS]: ["text"], [SONNET]: ["text"], [HAIKU]: ["text"] },
  prices: {},
  limits: {},
};

let dir: string;
let paths: JlcodePaths;
let workspace: string;
let store: ConversationStore;
let catalog: ModelCatalog;
let seeded: { opus: ModelConfig; sonnet: ModelConfig; haiku: ModelConfig };
const saved = { config: process.env.JLCODE_CONFIG_DIR, data: process.env.JLCODE_DATA_DIR };

/** Every turn request a driver saw, with the model it was built for. */
let requests: { model: string; req: ChatRequest }[];

/** Named gates a `hold:<name>` request waits on, released by the test. */
let gates: Map<string, { open: () => void; promise: Promise<void> }>;
function gateFor(name: string) {
  let g = gates.get(name);
  if (!g) {
    let open!: () => void;
    const promise = new Promise<void>((r) => (open = r));
    g = { open, promise };
    gates.set(name, g);
  }
  return g;
}

const HEADER = /^\[(?:Task|Message) from [\s\S]*?\]\n\n/;

/** What the last user message *says*, past its framing and attribution line. */
function lastSaid(req: ChatRequest): string {
  const last = req.messages[req.messages.length - 1];
  if (last?.role !== "user" || typeof last.content !== "string") return "";
  return stripEnvironmentDetails(last.content).trim().replace(HEADER, "").trim();
}

function text(t: string): StreamEvent[] {
  return [
    { type: "text", delta: t },
    { type: "finish", reason: "stop" },
    { type: "usage", usage: { promptTokens: 1000, completionTokens: 10 } },
  ];
}

/**
 * The fake agent driver, plus two stand-ins for a model that is busy:
 *   `hold:<g>`      — answers only once gate g opens;
 *   `holdread:<g>`  — once g opens, calls read_file (so the turn has a next
 *                     tool-loop pass for a queued message to land at).
 */
function treeDriver(config: ModelConfig): LlmDriver {
  const fake = fakeAgentDriver();
  return {
    async *streamChat(req, opts): AsyncGenerator<StreamEvent> {
      requests.push({ model: config.model, req });
      const said = lastSaid(req);
      // A batch whose first call blocks on a gate, with agent traffic behind it —
      // what a Stop landing mid-batch has to keep from starting anything.
      const batch = /^stopbatch:(\S+)/.exec(said);
      if (batch) {
        const calls = [
          { name: "wait_gate", args: { gate: batch[1] } },
          { name: "send_message", args: { to: "parent", text: "done after the stop" } },
          { name: "spawn_agent", args: { task: "say hi" } },
        ];
        for (const [index, c] of calls.entries()) {
          yield { type: "tool_call", index, id: `sb_${index}`, name: c.name, argsDelta: JSON.stringify(c.args) };
        }
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      const held = /^(hold|holdread):(\S+)/.exec(said);
      if (held) {
        await gateFor(held[2]!).promise;
        if (held[1] === "holdread") {
          yield { type: "tool_call", index: 0, id: `read_${held[2]}`, name: "read_file", argsDelta: JSON.stringify({ path: "notes.txt" }) };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        yield* text(`released ${held[2]}`);
        return;
      }
      yield* fake.streamChat(req, opts);
    },
  };
}

function seed(commands?: ModelConfig["commands"]) {
  const base = {
    defaultMode: "code" as const,
    defaultApproval: "full-auto" as const,
    compaction: { auto: true },
    // Priced, so spend has something to roll up (D-33).
    pricing: { promptPerMTok: 1, completionPerMTok: 1 },
    environment: { turnTimestamps: false },
  };
  let cfg = defaultConfig();
  const a = addModelConfig(cfg, { ...base, name: "opus", model: OPUS, openRouterKey: KEY_A, ...(commands ? { commands } : {}) });
  const b = addModelConfig(a.config, { ...base, name: "sonnet", model: SONNET, openRouterKey: KEY_A });
  const c = addModelConfig(b.config, { ...base, name: "haiku", model: HAIKU, openRouterKey: KEY_B });
  cfg = setBinding(c.config, workspace, a.added.id);
  saveConfig(cfg, paths);
  seeded = { opus: a.added, sonnet: b.added, haiku: c.added };
}

function editConfig(id: string, patch: Partial<ModelConfig>): void {
  const cfg = loadConfig(paths);
  saveConfig(
    { ...cfg, modelConfigs: cfg.modelConfigs.map((m) => (m.id === id ? { ...m, ...patch, updatedAt: new Date(Date.now() + 1000).toISOString() } : m)) },
    paths,
  );
}

/** Gates a running tool has reached — `until` waits on these. */
let reached: Set<string>;
/** A tool that blocks until its gate opens: a long command, without a process. */
const waitGate: Tool = {
  name: "wait_gate",
  kind: "read",
  mutates: false,
  def: { type: "function", function: { name: "wait_gate", description: "wait", parameters: { type: "object", properties: {} } } },
  async execute(args) {
    const g = String(args.gate);
    reached.add(g);
    await gateFor(g).promise;
    return { content: `gate ${g} opened` };
  },
};

/** Every `tool_calls` message on the wire is answered, call for call, before
 *  anything else is said — the shape every backend insists on (D-84). */
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

function makeServer() {
  const deps = { paths, cwd: workspace, makeDriver: treeDriver, mcpTools: () => [waitGate], catalog };
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

/** Resolve once `pred` holds, re-checked on every frame of the bag's bus. */
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

const childrenOf = (manager: SessionManager, parent: Session) =>
  manager.list().filter((s) => s.agentInfo?.parentSessionId === parent.id);
const named = (manager: SessionManager, name: string) => manager.list().find((s) => s.agentInfo?.name === name);
const toolResults = (s: Session) => s.conversation.entries.filter((e): e is Extract<Entry, { type: "tool" }> => e.type === "tool");
const inbound = (s: Session) =>
  s.conversation.entries.filter((e): e is Extract<Entry, { type: "user" }> => e.type === "user" && e.inbound !== undefined);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-p9c-"));
  process.env.JLCODE_CONFIG_DIR = path.join(dir, "config");
  process.env.JLCODE_DATA_DIR = path.join(dir, "data");
  paths = resolvePaths();
  fs.mkdirSync(path.dirname(paths.modelsCacheFile), { recursive: true });
  fs.writeFileSync(paths.modelsCacheFile, JSON.stringify(CATALOG), "utf8");
  workspace = path.join(dir, "work");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "notes.txt"), "the notes\n");
  store = new ConversationStore(path.join(dir, "conversations"));
  catalog = new ModelCatalog({ file: paths.modelsCacheFile });
  requests = [];
  gates = new Map();
  reached = new Set();
});

afterEach(async () => {
  for (const g of gates.values()) g.open(); // never leave a turn hanging
  await store.close();
  process.env.JLCODE_CONFIG_DIR = saved.config;
  process.env.JLCODE_DATA_DIR = saved.data;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a parent and its children, end to end on the fake driver", () => {
  it("spawns, ends the parent's turn, routes the child's report back, and notifies on idle", async () => {
    seed();
    const { app, manager, agents } = makeServer();
    const first = await post(app, "/chat", { text: "spawn: msg: parent | hello from the child" });
    expect(first.status).toBe(200);
    await agents.idle();
    const root = manager.get(first.json.sessionId as string)!;

    const [child] = childrenOf(manager, root);
    expect(child?.agentInfo).toMatchObject({ name: "agent-1", depth: 1, rootSessionId: root.id });
    expect(child!.conversation.id).toContain("~"); // lives in the root's file

    // The spawn returned the name at once and the parent's turn ended there:
    // the entry under the spawn result is not another model call of its own.
    const spawnResult = toolResults(root).find((t) => t.name === "spawn_agent")!;
    expect(spawnResult.isError).toBe(false);
    expect(spawnResult.content).toContain('"agent-1"');
    const after = root.conversation.entries.find((e) => e.parent === spawnResult.id)!;
    expect(after.type).toBe("user");

    // The child ran its task under an attributed header, on the parent's model,
    // pinned by a switch entry in its own log (never the folder binding).
    expect(child!.conversation.entries[0]).toMatchObject({ type: "model-switch", configId: seeded.opus.id });
    const task = inbound(child!)[0]!;
    expect(task.inbound).toMatchObject({ from: "root", kind: "task" });
    expect(task.text).toMatch(/^\[Task from your parent agent "root"\. You are sub-agent "agent-1"/);

    // The child's message reached the parent attributed, and so did the notice.
    const kinds = inbound(root).map((e) => [e.inbound!.from, e.inbound!.kind]);
    expect(kinds).toContainEqual(["agent-1", "message"]);
    expect(kinds).toContainEqual(["agent-1", "finished"]);
    const message = inbound(root).find((e) => e.inbound!.kind === "message")!;
    expect(message.text).toBe('[Message from your sub-agent "agent-1"]\n\nhello from the child');
    expect(root.status).toBe("idle");
    expect(child!.status).toBe("idle");

    // The roster says who hangs under whom (the rail nests by it in P9e).
    const state = await post(app, `/session/${root.id}/stop`, { scope: "soft" });
    expect(state.json.agent).toMatchObject({ name: "root", depth: 0 });
    expect(state.json.subtree).toMatchObject({ agents: 1, running: 0, waiting: 0 });
  });

  it("folds the one interleaved file back per agent, on disk as in memory", async () => {
    seed();
    const { app, manager, agents } = makeServer();
    const first = await post(app, "/chat", { text: "spawn: msg: parent | one ;; msg: parent | two" });
    await agents.idle();
    await store.flush();
    const root = manager.get(first.json.sessionId as string)!;
    const kids = childrenOf(manager, root);
    expect(kids.map((k) => k.agentInfo!.name).sort()).toEqual(["agent-1", "agent-2"]);

    // One file for the whole tree, its writers genuinely interleaved.
    const files = fs.readdirSync(path.join(dir, "conversations")).filter((f) => f.endsWith(".jsonl") && f !== "index.jsonl");
    expect(files).toEqual([`${root.conversation.id}.jsonl`]);
    const owners = fs
      .readFileSync(path.join(dir, "conversations", files[0]!), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => typeof r.id === "string" && typeof r.type === "string")
      .map((r) => (typeof r.agent === "string" ? r.agent : "root"));
    const switches = owners.filter((o, i) => i > 0 && o !== owners[i - 1]).length;
    expect(switches).toBeGreaterThan(2);

    for (const s of [root, ...kids]) {
      const loaded = store.load(s.conversation.id)!;
      expect(loaded.id).toBe(s.conversation.id);
      expect(loaded.entries.map((e) => e.id)).toEqual(s.conversation.entries.map((e) => e.id));
      expect(loaded.activeLeaf).toBe(s.conversation.activeLeaf);
      expect(loaded.inbox).toBeUndefined(); // everything sent was delivered
    }
    // A child's name is its title; the history index lists the root alone.
    expect(store.load(kids[0]!.conversation.id)!.title).toMatch(/^agent-\d$/);
    expect(store.list().map((r) => r.id)).toEqual([root.conversation.id]);
    expect(store.agents(root.conversation.id).map((r) => r.name)).toEqual(["agent-1", "agent-2"]);
  });
});

describe("the tree's file, folded by agent", () => {
  it("keeps each agent's own root, forks and activeLeaf apart however the writes interleave", async () => {
    const rootId = "cv_tree";
    await store.create({ id: rootId, workingDir: workspace });
    const a = agentConversationId(rootId, "ag_a");
    const b = agentConversationId(rootId, "ag_b");
    await store.agent(rootId, { agentId: "ag_a", parentAgentId: null, name: "agent-1", depth: 1, createdAt: "" });
    await store.agent(rootId, { agentId: "ag_b", parentAgentId: "ag_a", name: "agent-2", depth: 2, createdAt: "" });
    const e = (id: string, parent: string | null, txt: string): Entry => ({ id, parent, ts: "2026-01-01T00:00:00.000Z", type: "user", text: txt });
    // Root, a, b written turn about — each agent with a root entry of its own.
    await store.entry(rootId, e("r1", null, "root one"));
    await store.entry(a, e("a1", null, "a one"));
    await store.entry(b, e("b1", null, "b one"));
    await store.entry(a, e("a2", "a1", "a two"));
    await store.entry(rootId, e("r2", "r1", "root two"));
    await store.entry(a, e("a3", "a1", "a fork")); // a forks off a1
    await store.activeLeaf(a, "a2"); // …and a's reader goes back to the first branch
    await store.entry(b, e("b2", "b1", "b two"));
    await store.activeLeaf(rootId, "r1");
    await store.flush();

    const root = store.load(rootId)!;
    expect(root.entries.map((x) => x.id)).toEqual(["r1", "r2"]);
    expect(root.activeLeaf).toBe("r1");
    const la = store.load(a)!;
    expect(la.entries.map((x) => x.id)).toEqual(["a1", "a2", "a3"]);
    expect(la.activeLeaf).toBe("a2"); // its own activeLeaf, not root's
    expect(la.entries.every((x) => !("agent" in x))).toBe(true); // the tag stays on disk
    expect(store.load(b)!.entries.map((x) => x.id)).toEqual(["b1", "b2"]);
    // An agent id the file does not record is no conversation at all.
    expect(store.load(agentConversationId(rootId, "ag_nope"))).toBeUndefined();
  });

  it("keeps a sent-but-undelivered message as owed, and forgets a delivered or dropped one", async () => {
    const rootId = "cv_inbox";
    await store.create({ id: rootId, workingDir: workspace });
    const a = agentConversationId(rootId, "ag_a");
    await store.agent(rootId, { agentId: "ag_a", parentAgentId: null, name: "agent-1", depth: 1, createdAt: "" });
    await store.inbox(a, { id: "m1", from: "root", kind: "message", text: "first" });
    await store.inbox(a, { id: "m2", from: "root", kind: "message", text: "second" });
    await store.inbox(a, { id: "m3", from: "root", kind: "message", text: "third" });
    await store.entry(a, { id: "u1", parent: null, ts: "", type: "user", text: "first", inbound: { id: "m1", from: "root", kind: "message" } });
    await store.inboxDropped(a, ["m3"]);
    await store.flush();
    // The crash happened here: m2 was sent, never taken in.
    expect(store.load(a)!.inbox).toEqual([{ id: "m2", from: "root", kind: "message", text: "second" }]);
    expect(store.load(rootId)!.inbox).toBeUndefined(); // it was never the root's
  });

  it("hands an owed message to the session that resumes the agent, without starting a turn", async () => {
    seed();
    const rootId = "cv_resume";
    await store.create({ id: rootId, workingDir: workspace });
    const a = agentConversationId(rootId, "ag_a");
    await store.agent(rootId, { agentId: "ag_a", parentAgentId: null, name: "agent-1", depth: 1, createdAt: "" });
    await store.inbox(a, { id: "m1", from: "root", kind: "message", text: '[Message from your parent agent "root"]\n\nstill there?' });
    await store.flush();
    const factory = createSessionFactory({ paths, cwd: workspace, makeDriver: treeDriver, mcpTools: () => [], catalog });
    const s = factory(seeded.opus, store.load(a)!);
    expect(s.queuedMessages).toHaveLength(1);
    expect(s.queuedMessages[0]!.inbound).toMatchObject({ id: "m1", from: "root" });
    expect(s.status).toBe("idle");
    expect(requests).toHaveLength(0); // nothing auto-starts (X-56 Q15)
  });
});

describe("an agent message is written when it is sent", () => {
  it("records it on the receiver's log while the receiver is still busy", async () => {
    seed();
    const { app, manager, agents } = makeServer();
    const first = await post(app, "/chat", { text: "spawn: hold:busy" });
    const root = manager.get(first.json.sessionId as string)!;
    await until(manager, () => named(manager, "agent-1")?.status === "running");
    const child = named(manager, "agent-1")!;

    await post(app, "/chat", { sessionId: root.id, text: "msg: agent-1 | are you done?" });
    await store.flush();
    // Busy: not in its transcript yet — but on disk as owed, under its agent.
    expect(inbound(child).some((e) => e.text.includes("are you done?"))).toBe(false);
    expect(store.load(child.conversation.id)!.inbox?.map((m) => m.text)).toEqual([
      '[Message from your parent agent "root"]\n\nare you done?',
    ]);
    gateFor("busy").open();
    await agents.idle();
    await store.flush();
    expect(inbound(child).some((e) => e.text.endsWith("are you done?"))).toBe(true);
    expect(store.load(child.conversation.id)!.inbox).toBeUndefined();
  });
});

describe("the depth brake (D-89)", () => {
  it("refuses a spawn past the root's agent depth, and the agent carries on itself", async () => {
    seed({ agentDepth: 1 });
    const { app, manager, agents } = makeServer();
    const first = await post(app, "/chat", { text: "spawn: spawn: say hi" });
    await agents.idle();
    const root = manager.get(first.json.sessionId as string)!;
    const child = childrenOf(manager, root)[0]!;
    const refusal = toolResults(child).find((t) => t.name === "spawn_agent")!;
    expect(refusal.isError).toBe(true);
    expect(refusal.content).toMatch(/refused: you are 1 level below the root and this tree allows sub-agents 1 level deep/);
    expect(childrenOf(manager, child)).toHaveLength(0);
    // The turn was not ended by a refused spawn — the model was asked again.
    const after = child.conversation.entries.find((e) => e.parent === refusal.id);
    expect(after?.type).toBe("assistant");
  });

  it("reads the root's config live, and depth 0 switches spawning off", async () => {
    seed();
    const { app, manager, agents } = makeServer();
    editConfig(seeded.opus.id, { commands: { agentDepth: 0 } });
    const first = await post(app, "/chat", { text: "spawn: say hi" });
    await agents.idle();
    const root = manager.get(first.json.sessionId as string)!;
    expect(toolResults(root)[0]!.content).toMatch(/switched off for this thread \(agent depth 0\)/);
    expect(childrenOf(manager, root)).toHaveLength(0);
  });
});

describe("the width brake (D-89)", () => {
  it("queues the fifth agent of a tree and starts it when one goes idle", async () => {
    seed(); // default cap 4 — and the root counts
    const { app, manager, agents } = makeServer();
    const seen = new Map<string, string[]>();
    manager.subscribe((f) => {
      if (f.kind === "event" && f.event.type === "status") {
        const name = manager.get(f.sessionId)?.agentInfo?.name ?? "?";
        seen.set(name, [...(seen.get(name) ?? []), f.event.status]);
      }
    });
    const first = await post(app, "/chat", { text: "spawn: hold:a ;; hold:b ;; hold:c ;; hold:d" });
    const root = manager.get(first.json.sessionId as string)!;
    await until(manager, () => named(manager, "agent-4")?.status === "running");
    // agent-4 found root + three children running and waited, never refused.
    expect(seen.get("agent-4")).toEqual(["queued", "idle", "running"]);
    expect(seen.get("agent-1")!.includes("queued")).toBe(false);
    // It started only once the root's turn had ended (the slot it freed).
    expect(root.status).toBe("idle");
    for (const g of ["a", "b", "c", "d"]) gateFor(g).open();
    await agents.idle();
    expect(childrenOf(manager, root).every((c) => c.status === "idle")).toBe(true);
  });

  it("starts waiters first-in first-out — a notice to the parent queues behind them", async () => {
    seed({ agentConcurrency: 2 });
    const { app, manager, agents } = makeServer();
    const starts: string[] = [];
    manager.subscribe((f) => {
      if (f.kind === "event" && f.event.type === "status" && f.event.status === "running") {
        starts.push(manager.get(f.sessionId)?.agentInfo?.name ?? "?");
      }
    });
    await post(app, "/chat", { text: "spawn: hold:a ;; hold:b ;; hold:c" });
    // root + agent-1 fill the cap; agent-2 and agent-3 wait; the root yields.
    await until(manager, () => named(manager, "agent-2")?.status === "running");
    expect(named(manager, "agent-3")!.status).toBe("queued");
    gateFor("a").open(); // agent-1 goes idle → its notice wants the root…
    await until(manager, () => named(manager, "agent-3")?.status === "running");
    // …but agent-3 was waiting first, so the root's notice turn queued behind it.
    expect(starts.slice(0, 4)).toEqual(["root", "agent-1", "agent-2", "agent-3"]);
    gateFor("b").open();
    gateFor("c").open();
    await agents.idle();
    expect(starts.filter((n) => n === "root").length).toBeGreaterThan(1); // the notices got their turns
    expect(manager.list().every((s) => s.status === "idle")).toBe(true);
  });

  it("a spend-cap raise resumes parked members through the width cap, never past it", async () => {
    seed({ agentConcurrency: 2 });
    const { app, manager, agents } = makeServer();
    let running = 0;
    let most = 0;
    manager.subscribe((f) => {
      if (f.kind !== "event" || f.event.type !== "status") return;
      running = manager.list().filter((s) => s.status === "running").length;
      most = Math.max(most, running);
    });
    const first = await post(app, "/chat", { text: "spawn: holdread:a ;; holdread:b ;; holdread:c" });
    const root = manager.get(first.json.sessionId as string)!;
    await until(manager, () => named(manager, "agent-2")?.status === "running");
    // Cap the tree where it stands: every next model call is over it.
    await post(app, `/session/${root.id}/cap`, { capUsd: root.treeSpendUsd });
    gateFor("a").open();
    gateFor("b").open();
    gateFor("c").open();
    await until(manager, () => ["agent-1", "agent-2", "agent-3"].every((n) => named(manager, n)?.capReached));
    await agents.idle();
    expect(childrenOf(manager, root).filter((c) => c.capReached)).toHaveLength(3); // more parked than the cap

    most = 0;
    await post(app, `/session/${root.id}/cap`, { capUsd: 100 });
    await agents.idle();
    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThanOrEqual(2);
    expect(manager.list().every((s) => s.status === "idle" && !s.capReached)).toBe(true);
    expect(childrenOf(manager, root).every((c) => toolResults(c).some((t) => t.name === "read_file"))).toBe(true);
  });

  it("off means no cap", async () => {
    seed({ agentConcurrency: 0 });
    const { app, manager, agents } = makeServer();
    await post(app, "/chat", { text: "spawn: hold:a ;; hold:b ;; hold:c ;; hold:d ;; hold:e" });
    await until(manager, () => ["agent-1", "agent-2", "agent-3", "agent-4", "agent-5"].every((n) => named(manager, n)?.status === "running"));
    for (const g of ["a", "b", "c", "d", "e"]) gateFor(g).open();
    await agents.idle();
  });
});

describe("the tool-round budget resets only on human input (D-89)", () => {
  /** A lone session: `read: x` takes two model turns (a call, then an answer). */
  function lone() {
    const config = { ...seeded.opus };
    return new Session({
      config,
      driver: fakeAgentDriver(),
      tools: new ToolRegistry(fileTools()),
      sandbox: new Sandbox([workspace]),
      maxToolIterations: 3,
    });
  }
  const agentSays = (s: Session, id: string, body: string) =>
    s.receive({ id, from: "root", kind: "message", text: `[Message from your parent agent "root"]\n\n${body}` });

  it("an agent's message continues the count and pauses; a person's starts it over", async () => {
    seed();
    const s = lone();
    await s.send("read: notes.txt"); // 2 rounds of 3
    expect(s.status).toBe("idle");

    agentSays(s, "m1", "read: notes.txt");
    await s.startNext();
    // Round 3 asked for a tool; round 4 would be over budget → the pause.
    expect(s.status).toBe("awaiting-continue");
    expect(s.awaitingContinue).toMatchObject({ rounds: 3, budget: 3 });

    // A human message is a fresh budget: the same work runs to the end.
    await s.send("read: notes.txt");
    expect(s.status).toBe("idle");
  });

  it("a person's message waiting in the queue counts as human input when it opens the turn", async () => {
    seed();
    const s = lone();
    await s.send("read: notes.txt"); // 2 of 3 spent
    agentSays(s, "m1", "read: notes.txt");
    await s.enqueue("read: notes.txt"); // idle → opens a turn; a person is in the queue
    expect(s.status).toBe("idle"); // budget reset: no pause
  });
});

describe("spawn_agent's model is checked live against the caller's key", () => {
  it("refuses a model on another key, naming the ones allowed", async () => {
    seed();
    const { app, manager, agents } = makeServer();
    const first = await post(app, "/chat", { text: "spawn@haiku: say hi" });
    await agents.idle();
    const root = manager.get(first.json.sessionId as string)!;
    const refusal = toolResults(root)[0]!;
    expect(refusal.isError).toBe(true);
    expect(refusal.content).toBe(
      'Model config "haiku" uses a different OpenRouter key, and a sub-agent may only use your own key. Allowed: "opus", "sonnet".',
    );
    expect(childrenOf(manager, root)).toHaveLength(0);
  });

  it("runs a same-key sibling, and list_models lists exactly the same-key set", async () => {
    seed();
    const { app, manager, agents } = makeServer();
    const first = await post(app, "/chat", { text: "spawn@sonnet: say hi" });
    await agents.idle();
    const root = manager.get(first.json.sessionId as string)!;
    const child = childrenOf(manager, root)[0]!;
    expect(child.config.model).toBe(SONNET);
    expect(requests.some((r) => r.model === SONNET)).toBe(true);

    await post(app, "/chat", { sessionId: root.id, text: "models:" });
    const listing = toolResults(root).find((t) => t.name === "list_models")!.content;
    expect(listing).toContain("- opus — anthropic/claude-opus-5 (your own)");
    expect(listing).toContain("- sonnet — anthropic/claude-sonnet-5");
    expect(listing).not.toContain("haiku");
    expect(listing).not.toContain(KEY_A);
  });
});

describe("a message to a busy child", () => {
  it("lands at the child's next tool-loop pass, before its next model call", async () => {
    seed();
    const { app, manager, agents } = makeServer();
    const first = await post(app, "/chat", { text: "spawn: holdread:work" });
    const root = manager.get(first.json.sessionId as string)!;
    await until(manager, () => named(manager, "agent-1")?.status === "running");
    const child = named(manager, "agent-1")!;

    await post(app, "/chat", { sessionId: root.id, text: "msg: agent-1 | change of plan" });
    gateFor("work").open();
    await agents.idle();

    // task → tool call → result → the correction → the answer that read it.
    expect(child.conversation.entries.map((e) => e.type)).toEqual(["model-switch", "user", "assistant", "tool", "user", "assistant"]);
    const correction = child.conversation.entries[4] as Extract<Entry, { type: "user" }>;
    expect(correction.inbound).toMatchObject({ from: "root", kind: "message" });
    const childCalls = requests.filter((r) => r.req.messages.some((m) => typeof m.content === "string" && m.content.includes("You are sub-agent")));
    expect(lastSaid(childCalls[1]!.req)).toBe("change of plan");
    expect(childCalls[1]!.req.messages.at(-2)?.role).toBe("tool");
  });
});

describe("tree-wide controls", () => {
  it("lights the parent when a child waits on the human, and Stop reaches the subtree", async () => {
    seed();
    editConfig(seeded.opus.id, { defaultApproval: "manual" });
    const { app, manager, agents } = makeServer();
    const first = await post(app, "/chat", { text: "spawn: write: out.txt | hi" });
    const root = manager.get(first.json.sessionId as string)!;
    await until(manager, () => named(manager, "agent-1")?.status === "awaiting-approval");
    const child = named(manager, "agent-1")!;
    expect(child.approval).toBe("manual"); // inherited from the parent
    await agents.idle();

    const state = await post(app, `/session/${root.id}/cap`, { capUsd: 100 });
    expect(state.json.subtree).toMatchObject({ agents: 1, waiting: 1 });
    expect(child.spendCapUsd).toBe(100); // the cap is the tree's

    const stopped = await post(app, `/session/${root.id}/stop`, { scope: "hard" });
    expect(stopped.status).toBe(200);
    expect(child.status).toBe("idle");
    expect(child.awaitingApproval).toBeUndefined();
    await agents.idle();
    // The parent heard, but a Stop never starts a turn: the notice is parked.
    expect(root.status).toBe("idle");
    expect(root.queuedMessages.map((q) => q.inbound?.kind)).toEqual(["finished"]);
    expect(root.queuedMessages[0]!.text).toContain("was stopped by the user");

    // The card's call was answered by the Stop (H-10), so a later message to
    // the child makes a request every backend accepts.
    expect(toolResults(child).at(-1)).toMatchObject({ name: "write_file", isError: true, content: expect.stringContaining("stopped by the user") });
    // (Cancel the parked notice, or it would land after the command below and
    // be what the fake driver answers.)
    await post(app, `/session/${root.id}/queue`, { queue: [] });
    const before = requests.length;
    await post(app, "/chat", { sessionId: root.id, text: "msg: agent-1 | hello again" });
    await agents.idle();
    const childReqs = requests.slice(before).filter((r) => r.req.messages.some((m) => typeof m.content === "string" && m.content.includes("You are sub-agent")));
    expect(childReqs.length).toBeGreaterThan(0);
    for (const r of childReqs) expect(everyCallAnswered(r.req.messages)).toBe(true);
    expect(child.status).toBe("idle");
  });

  it("a soft Stop reaches the subtree: the rest of a stopped batch starts nothing", async () => {
    seed();
    const { app, manager, agents } = makeServer();
    const first = await post(app, "/chat", { text: "spawn: stopbatch:g" });
    const root = manager.get(first.json.sessionId as string)!;
    await until(manager, () => reached.has("g"));
    const child = named(manager, "agent-1")!;
    const rootCalls = () => requests.filter((r) => !r.req.messages.some((m) => typeof m.content === "string" && m.content.includes("You are sub-agent"))).length;
    const rootBefore = rootCalls();

    await post(app, `/session/${root.id}/stop`, { scope: "soft" });
    gateFor("g").open(); // the long tool finishes; send_message and spawn_agent run after the Stop
    await agents.idle();

    expect(rootCalls()).toBe(rootBefore); // no turn opened on the root
    expect(root.status).toBe("idle");
    // Delivered — on disk and in the queue, owed — but parked.
    expect(root.queuedMessages.map((q) => q.inbound?.kind)).toEqual(["message", "finished"]);
    const spawn = toolResults(child).find((t) => t.name === "spawn_agent")!;
    expect(spawn).toMatchObject({ isError: true, content: expect.stringContaining("the user stopped this turn") });
    expect(named(manager, "agent-2")).toBeUndefined();
    expect(child.status).toBe("idle");
  });

  it("rolls spend up to the tree, and the cap measures the tree", async () => {
    seed();
    const { app, manager, agents } = makeServer();
    const first = await post(app, "/chat", { text: "spawn: say hi" });
    await agents.idle();
    const root = manager.get(first.json.sessionId as string)!;
    const child = childrenOf(manager, root)[0]!;
    expect(child.spendUsd).toBeGreaterThan(0);
    const state = await post(app, `/session/${root.id}/cap`, { capUsd: null });
    expect(state.json.treeSpendUsd).toBeCloseTo(root.spendUsd + child.spendUsd, 10);
    expect(state.json.subtree.spendUsd).toBeCloseTo(child.spendUsd, 10);

    // A cap the child alone is under but the tree is over blocks the child too.
    const cap = root.spendUsd + child.spendUsd / 2;
    expect(child.spendUsd).toBeLessThan(cap);
    await post(app, `/session/${root.id}/cap`, { capUsd: cap });
    const before = requests.length;
    await post(app, "/chat", { sessionId: child.id, text: "again" });
    expect(child.capReached).toBe(true);
    expect(requests.length).toBe(before); // no model call was made
  });

  it("close takes the subtree out of the bag; a later message revives the child from disk", async () => {
    seed();
    const { app, manager, agents } = makeServer();
    const first = await post(app, "/chat", { text: "spawn: say hi" });
    await agents.idle();
    const root = manager.get(first.json.sessionId as string)!;
    const child = childrenOf(manager, root)[0]!;
    const closed = await post(app, `/session/${child.id}/close`, {});
    expect(closed.json.closed).toBe(true);
    expect(manager.get(child.id)).toBeUndefined();
    await store.flush();

    await post(app, "/chat", { sessionId: root.id, text: "msg: agent-1 | welcome back" });
    await agents.idle();
    const revived = named(manager, "agent-1")!;
    expect(revived.id).not.toBe(child.id);
    expect(revived.conversation.id).toBe(child.conversation.id);
    expect(revived.config.model).toBe(OPUS); // its own switch entry decided
    expect(inbound(revived).at(-1)!.text.endsWith("welcome back")).toBe(true);
    // Closing the root closes everything under it.
    await post(app, `/session/${root.id}/close`, {});
    expect(manager.list()).toHaveLength(0);
  });

  it("refuses to revive a sub-agent on its own through /chat", async () => {
    seed();
    const { app } = makeServer();
    const res = await post(app, "/chat", { conversationId: "cv_x~ag_y", text: "hi" });
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/sub-agent/);
  });

  it("send_message to someone unknown is refused with who can be reached", async () => {
    seed();
    const { app, manager, agents } = makeServer();
    const first = await post(app, "/chat", { text: "spawn: msg: agent-9 | hi" });
    await agents.idle();
    const root = manager.get(first.json.sessionId as string)!;
    const child = childrenOf(manager, root)[0]!;
    const refusal = toolResults(child).find((t) => t.name === "send_message")!;
    expect(refusal.isError).toBe(true);
    expect(refusal.content).toBe('No agent "agent-9" you can message. You can reach: "parent".');
    const own = await post(app, "/chat", { sessionId: root.id, text: "msg: parent | hi" });
    expect(own.status).toBe(200);
    expect(toolResults(root).at(-1)!.content).toMatch(/You have no parent agent/);
  });
});

describe("the brakes' config fields (D-89)", () => {
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

  it("config set stores and reads both back; default clears them", async () => {
    expect(await runConfig(["set", "opus", "--agent-depth", "2", "--agent-concurrency", "off", "--offline"])).toBe(0);
    expect(stored().commands).toMatchObject({ agentDepth: 2, agentConcurrency: 0 });
    expect(out.join("")).toContain("agents: sub-agents up to 2 levels below the root, no cap on how many run at once");
    await runConfig(["set", "opus", "--agent-depth", "0", "--offline"]);
    expect(out.join("")).toContain("agents: no sub-agents (agent depth 0)");
    await runConfig(["set", "opus", "--agent-depth", "default", "--agent-concurrency", "default", "--offline"]);
    expect(stored().commands?.agentDepth).toBeUndefined();
    expect(stored().commands?.agentConcurrency).toBeUndefined();
  });

  it("rejects malformed values", async () => {
    await expect(runConfig(["set", "opus", "--agent-depth", "-1", "--offline"])).rejects.toThrow(/whole number/);
    await expect(runConfig(["set", "opus", "--agent-concurrency", "0", "--offline"])).rejects.toThrow(/positive whole number/);
  });

  it("config which states them, defaults included", async () => {
    const cwd = process.cwd();
    process.chdir(workspace);
    try {
      expect(await runConfig(["which", "--offline"])).toBe(0);
    } finally {
      process.chdir(cwd);
    }
    expect(out.join("")).toContain("agents: sub-agents up to 3 levels below the root, at most 4 running at once (the rest wait queued)");
  });

  it("config model carries them, and prints them when they are not the defaults", () => {
    const source = { ...stored(), commands: { agentDepth: 1, agentConcurrency: 8 } };
    const derived = deriveModelConfig(source, { model: SONNET, name: "x" });
    expect(derived.commands).toEqual({ agentDepth: 1, agentConcurrency: 8 });
    expect(nonDefaultSettings(source)).toEqual(expect.arrayContaining(["agentDepth:1", "agentConcurrency:8"]));
    expect(nonDefaultSettings({ ...source, commands: { agentDepth: 0, agentConcurrency: 0 } })).toEqual(
      expect.arrayContaining(["agents:off", "agentConcurrency:off"]),
    );
  });
});

describe("a Stop on a card answers the card's call (H-10)", () => {
  function carded() {
    return new Session({
      config: { ...seeded.opus },
      driver: fakeAgentDriver(),
      tools: new ToolRegistry(fileTools()), // ask_user is the session's own
      sandbox: new Sandbox([workspace]),
      gate: new ModeApprovalGate("code", "manual"),
    });
  }

  for (const scope of ["hard", "soft"] as const) {
    for (const [card, text, status] of [
      ["approval", "write: out.txt | hi", "awaiting-approval"],
      ["question", "ask: which one? | a, b", "awaiting-input"],
    ] as const) {
      it(`${scope} Stop on the ${card} card leaves no call unanswered, and the next send is a valid request`, async () => {
        seed();
        const s = carded();
        const seen: ChatRequest[] = [];
        await s.send(text);
        expect(s.status).toBe(status);
        s.stop(scope);
        expect(s.status).toBe("idle");
        expect(s.awaitingApproval).toBeUndefined();
        expect(s.awaitingInput).toBeUndefined();
        const answer = toolResults(s).at(-1)!;
        expect(answer).toMatchObject({ isError: true, content: expect.stringContaining("stopped by the user") });
        await expect(s.approve({ approve: true })).rejects.toThrow(/No pending approval/);
        expect(everyCallAnswered(s.buildRequest().messages)).toBe(true);
        // …and the turn after it really is accepted as sent.
        const driver = fakeAgentDriver();
        (s as unknown as { driver: LlmDriver }).driver = {
          async *streamChat(req, opts) {
            seen.push(req);
            yield* driver.streamChat(req, opts);
          },
        };
        await s.send("carry on");
        expect(seen.length).toBeGreaterThan(0);
        for (const r of seen) expect(everyCallAnswered(r.messages)).toBe(true);
        expect(s.status).toBe("idle");
      });
    }
  }
});

describe("a hard Stop mid-batch answers the calls it kept from running", () => {
  async function stoppedMidBatch(how: "stop" | "close") {
    seed();
    const server = makeServer();
    const { app, manager, agents } = server;
    const first = await post(app, "/chat", { text: "spawn: stopbatch:g" });
    const root = manager.get(first.json.sessionId as string)!;
    await until(manager, () => reached.has("g"));
    const child = named(manager, "agent-1")!;
    if (how === "stop") await post(app, `/session/${root.id}/stop`, { scope: "hard" });
    else await post(app, `/session/${child.id}/close`, {});
    gateFor("g").open(); // the in-flight call's real result still lands
    await agents.idle();
    await store.flush();
    return { ...server, root, child };
  }

  it("on a tree Stop: the in-flight call keeps its result, the rest are refused, and the next message is a valid request", async () => {
    const { app, agents, root, child } = await stoppedMidBatch("stop");
    const results = toolResults(child).map((t) => [t.name, t.isError]);
    expect(results).toEqual([
      ["wait_gate", false],
      ["send_message", true],
      ["spawn_agent", true],
    ]);
    expect(toolResults(child).at(-1)!.content).toContain("stopped by the user");
    expect(everyCallAnswered(child.buildRequest().messages)).toBe(true);

    await post(app, `/session/${root.id}/queue`, { queue: [] }); // drop the parked notice
    const before = requests.length;
    await post(app, "/chat", { sessionId: root.id, text: "msg: agent-1 | carry on" });
    await agents.idle();
    const childReqs = requests.slice(before).filter((r) => r.req.messages.some((m) => typeof m.content === "string" && m.content.includes("You are sub-agent")));
    expect(childReqs.length).toBeGreaterThan(0);
    for (const r of childReqs) expect(everyCallAnswered(r.req.messages)).toBe(true);
  });

  it("on a Close: the revived child's log is whole, and its next request valid", async () => {
    const { app, manager, agents, root, child } = await stoppedMidBatch("close");
    // What a revival will read back: the log on disk, answered call for call.
    expect(everyCallAnswered(buildWireMessages(store.load(child.conversation.id)!))).toBe(true);
    const before = requests.length;
    await post(app, "/chat", { sessionId: root.id, text: "msg: agent-1 | back again" });
    await agents.idle();
    const revived = named(manager, "agent-1")!;
    expect(revived.id).not.toBe(child.id);
    expect(toolResults(revived).map((t) => t.name)).toEqual(["wait_gate", "send_message", "spawn_agent"]);
    const childReqs = requests.slice(before).filter((r) => r.req.messages.some((m) => typeof m.content === "string" && m.content.includes("You are sub-agent")));
    expect(childReqs.length).toBeGreaterThan(0);
    for (const r of childReqs) expect(everyCallAnswered(r.req.messages)).toBe(true);
  });
});

describe("a Stop on a turn a cap raise has queued (queued resume)", () => {
  /** A lone session in a stub tree: `admit` is the test's to answer. */
  function parked() {
    let slot = false;
    const seenStopping: boolean[] = [];
    const host: AgentHost = {
      async spawn(s) {
        seenStopping.push(s.stopping);
        return "started";
      },
      send(s) {
        seenStopping.push(s.stopping);
        return "sent";
      },
      listModels: () => "",
      admit: () => slot,
      treeSpendUsd: (s) => s.spendUsd,
      subtree: () => ({ agents: 0, running: 0, queued: 0, waiting: 0, spendUsd: 0 }),
    };
    const calls: ChatRequest[] = [];
    const inner = fakeAgentDriver();
    const s = new Session({
      config: { ...seeded.opus },
      driver: {
        async *streamChat(req, opts) {
          calls.push(req);
          yield* inner.streamChat(req, opts);
        },
      },
      tools: new ToolRegistry([...fileTools(), ...agentToolsForTest()]),
      sandbox: new Sandbox([workspace]),
      spendCapUsd: 0, // parked before its first model call
    });
    s.setAgentHost(host, { name: "agent-1", depth: 1, parentSessionId: "p", rootSessionId: "p" });
    const outcomes: string[] = [];
    s.onEvent((e) => {
      if (e.type === "settled") outcomes.push(e.outcome);
    });
    return { s, calls, seenStopping, outcomes, open: () => (slot = true) };
  }

  async function queuedResume() {
    const t = parked();
    await t.s.send("spawn: msg: parent | hi");
    expect(t.s.capReached).toBe(true);
    expect(t.calls).toHaveLength(0);
    await t.s.setSpendCap(100); // the raise — but no slot: waits queued
    expect(t.s.status).toBe("queued");
    return t;
  }

  it("soft: stays parked; the next raise runs it as a normal turn", async () => {
    seed();
    const t = await queuedResume();
    t.s.stop("soft");
    expect(t.s.capReached).toBe(true); // parked again, nothing ended
    expect(t.outcomes).toEqual([]);
    expect(t.s.stopping).toBe(false);

    t.open();
    await t.s.setSpendCap(200);
    expect(t.calls.length).toBeGreaterThan(0);
    expect(t.seenStopping).toEqual([false]); // the spawn ran as any spawn would
    expect(t.s.status).toBe("idle");
    expect(t.outcomes).toEqual(["finished"]);
  });

  it("hard: the turn is ended and a later raise or slot never restarts it", async () => {
    seed();
    const t = await queuedResume();
    t.s.stop("hard");
    expect(t.s.status).toBe("idle");
    expect(t.s.capReached).toBe(false);
    expect(t.outcomes).toEqual(["stopped"]);
    t.open();
    await t.s.setSpendCap(200);
    await t.s.startQueued();
    expect(t.calls).toHaveLength(0);
    expect(t.seenStopping).toEqual([]);
  });
});
