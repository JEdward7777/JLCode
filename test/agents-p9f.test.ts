/**
 * P9f — the lifecycle: close, `list_agents`, Wake, boot (X-56 Q14, Q18–Q20,
 * D-88/D-89).
 *
 *   - rest states derive from the log alone: interrupted / owes-reply /
 *     quiescent, from crafted logs;
 *   - closed is a flag in the tree's file: a closed agent unloads, stays in its
 *     parent's list, drops out of `list_agents` unless asked, and a message or
 *     a click reopens it;
 *   - on boot nothing starts: a root opened from history brings its open tree
 *     back at rest;
 *   - Wake resumes the interrupted (healing open calls, H-10) and the owing in
 *     a subtree, skips the quiescent and the closed, admits through the width
 *     cap, and never resets a tool-round budget.
 *
 * Tier 0: the fake driver and hand-written JSONL; waits are on the bag's bus
 * and the coordinator's own in-flight work, never on a clock.
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
import { addModelConfig, setBinding, resolveForCwd } from "../src/config/operations";
import { resolvePaths, type JlcodePaths } from "../src/paths";
import { fakeAgentDriver } from "../src/session/fake";
import { restStateOf, newConversation, appendEntry } from "../src/conversation/tree";
import type { ChatMessage, ChatRequest, LlmDriver, StreamEvent } from "../src/llm/types";
import type { ModelConfig } from "../src/config/types";
import type { Conversation, Entry } from "../src/conversation/types";
import type { SessionManager } from "../src/session/manager";
import type { Session } from "../src/session/session";
import { SPAWN_AGENT } from "../src/tools/agent-tools";

const OPUS = "anthropic/claude-opus-5";
const KEY_A = "sk-or-v1-client-a-0000000000aaaa";
const CATALOG = {
  fetchedAt: "2099-01-01T00:00:00.000Z",
  windows: { [OPUS]: 1_000_000 },
  modalities: { [OPUS]: ["text"] },
  prices: {},
  limits: {},
};

let dir: string;
let paths: JlcodePaths;
let workspace: string;
let convDir: string;
let store: ConversationStore;
let catalog: ModelCatalog;
let requests: ChatRequest[];
const saved = { config: process.env.JLCODE_CONFIG_DIR, data: process.env.JLCODE_DATA_DIR };

function recordingDriver(): LlmDriver {
  const fake = fakeAgentDriver();
  return {
    async *streamChat(req, opts): AsyncGenerator<StreamEvent> {
      requests.push(req);
      yield* fake.streamChat(req, opts);
    },
  };
}

function seed(commands?: ModelConfig["commands"]) {
  const cfg = defaultConfig();
  const a = addModelConfig(cfg, {
    name: "opus",
    model: OPUS,
    openRouterKey: KEY_A,
    defaultMode: "code",
    defaultApproval: "full-auto",
    compaction: { auto: true },
    environment: { turnTimestamps: false },
    // Priced, so spend has something to add up (D-33).
    pricing: { promptPerMTok: 1, completionPerMTok: 1 },
    ...(commands ? { commands } : {}),
  });
  saveConfig(setBinding(a.config, workspace, a.added.id), paths);
}

function makeServer() {
  const deps = { paths, cwd: workspace, makeDriver: () => recordingDriver(), mcpTools: () => [], catalog };
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

async function post(app: Server["app"], url: string, body: unknown = {}) {
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
const tools = (s: Session) => s.conversation.entries.filter((e): e is Extract<Entry, { type: "tool" }> => e.type === "tool");

/** Every `tool_calls` message on the wire is answered before anything else. */
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

// ---- Crafted logs. ----

let seq = 0;
const ts = () => new Date(Date.UTC(2026, 10, 1, 0, 0, seq++)).toISOString();
type Line = Record<string, unknown>;

/** A tree file written by hand, as a crash would leave it. */
class Craft {
  readonly lines: Line[] = [];
  constructor(readonly rootId: string) {
    this.lines.push({ kind: "header", id: rootId, workingDir: workspace, createdAt: ts() });
  }
  agent(agentId: string, name: string, parentAgentId: string | null = null, depth = 1): this {
    this.lines.push({ kind: "agent", agentId, parentAgentId, name, depth, createdAt: ts() });
    return this;
  }
  closed(agentId: string): this {
    this.lines.push({ kind: "agent-closed", agentId, closed: true, ts: ts() });
    return this;
  }
  entry(agent: string | null, e: Line): string {
    const id = `e_${seq++}`;
    this.lines.push({ ...e, id, ts: ts(), ...(agent ? { agent } : {}) });
    return id;
  }
  user(agent: string | null, parent: string | null, text: string, inbound?: Line): string {
    return this.entry(agent, { type: "user", parent, text, ...(inbound ? { inbound } : {}) });
  }
  reply(agent: string | null, parent: string | null, text: string): string {
    return this.entry(agent, { type: "assistant", parent, text, finishReason: "stop" });
  }
  call(agent: string | null, parent: string | null, callId: string, name = "read_file"): string {
    return this.entry(agent, {
      type: "assistant",
      parent,
      text: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: callId, type: "function", function: { name, arguments: JSON.stringify({ path: "notes.txt" }) } }],
    });
  }
  result(agent: string | null, parent: string | null, callId: string): string {
    return this.entry(agent, { type: "tool", parent, toolCallId: callId, name: "read_file", content: "the notes" });
  }
  inbox(agent: string, id: string, from: string, text: string): this {
    this.lines.push({ kind: "inbox", agent, id, from, msgKind: "message", text, ts: ts() });
    return this;
  }
  write(): void {
    fs.mkdirSync(convDir, { recursive: true });
    fs.writeFileSync(path.join(convDir, `${this.rootId}.jsonl`), this.lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    fs.appendFileSync(path.join(convDir, "index.jsonl"), JSON.stringify({ id: this.rootId, workingDir: workspace, createdAt: ts() }) + "\n");
  }
}

/**
 * The tree every boot test opens: a root at rest over its children —
 *   agent-1  interrupted: a read_file call with no result;
 *   agent-2  quiescent: its own reply;
 *   agent-3  owes a reply: a message sent to it, never delivered;
 *   agent-4  closed (and interrupted — Wake skips it anyway), with agent-5,
 *            open, under it;
 *   agent-6  interrupted: a tool result the model never answered, under agent-2.
 */
function craftTree(rootId = "cv_boot"): Craft {
  const t = new Craft(rootId);
  t.agent("a1", "agent-1").agent("a2", "agent-2").agent("a3", "agent-3").agent("a4", "agent-4");
  t.agent("a5", "agent-5", "a4", 2).agent("a6", "agent-6", "a2", 2).closed("a4");
  const r1 = t.user(null, null, "start the work");
  t.reply(null, r1, "Started my sub-agents.");
  const task = (a: string) => ({ id: `in_${a}`, from: "root", kind: "task" });
  const u1 = t.user("a1", null, "read the notes", task("a1"));
  t.call("a1", u1, "call_a1");
  const u2 = t.user("a2", null, "say hi", task("a2"));
  t.reply("a2", u2, "hi");
  const u3 = t.user("a3", null, "say hi", task("a3"));
  t.reply("a3", u3, "hi");
  t.inbox("a3", "in_late", "root", "[Message from your parent agent \"root\"]\n\nanother thing");
  const u4 = t.user("a4", null, "read the notes", task("a4"));
  t.call("a4", u4, "call_a4");
  const u5 = t.user("a5", null, "say hi", task("a5"));
  t.reply("a5", u5, "hi");
  const u6 = t.user("a6", null, "read the notes", task("a6"));
  const c6 = t.call("a6", u6, "call_a6");
  t.result("a6", c6, "call_a6");
  return t;
}

/** The crafted tree, opened live after a "restart". */
async function booted() {
  craftTree().write();
  const server = makeServer();
  const opened = await post(server.app, "/conversation/cv_boot/open");
  return { ...server, root: server.manager.get(opened.json.sessionId)! };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-p9f-"));
  process.env.JLCODE_CONFIG_DIR = path.join(dir, "config");
  process.env.JLCODE_DATA_DIR = path.join(dir, "data");
  paths = resolvePaths();
  fs.mkdirSync(path.dirname(paths.modelsCacheFile), { recursive: true });
  fs.writeFileSync(paths.modelsCacheFile, JSON.stringify(CATALOG), "utf8");
  workspace = path.join(dir, "work");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "notes.txt"), "the notes\n");
  convDir = path.join(dir, "conversations");
  // No fsync: these are logic tests, and fsync made their run time scale with
  // disk contention (records still land in the file; only crash-durability goes).
  store = new ConversationStore(convDir, { fsync: false });
  catalog = new ModelCatalog({ file: paths.modelsCacheFile });
  requests = [];
});

afterEach(async () => {
  await store.close();
  process.env.JLCODE_CONFIG_DIR = saved.config;
  process.env.JLCODE_DATA_DIR = saved.data;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("rest states from the log (X-56 Q14)", () => {
  const conv = (build: (c: { conv: Conversation }) => void): Conversation => {
    const box = { conv: newConversation() };
    build(box);
    return box.conv;
  };
  const add = (box: { conv: Conversation }, e: Record<string, unknown>) => {
    box.conv = appendEntry(box.conv, e as never).conv;
  };
  const call = { id: "c1", type: "function" as const, function: { name: "read_file", arguments: "{}" } };

  it("an empty thread is quiescent, unless an agent's message waits in its inbox", () => {
    const c = newConversation();
    expect(restStateOf(c, c.activeLeaf, false)).toBe("quiescent");
    expect(restStateOf(c, c.activeLeaf, true)).toBe("owes-reply");
  });

  it("its own reply is quiescent; a pending message makes it owe one", () => {
    const c = conv((b) => {
      add(b, { type: "user", text: "hi" });
      add(b, { type: "assistant", text: "hello", finishReason: "stop" });
    });
    expect(restStateOf(c, c.activeLeaf, false)).toBe("quiescent");
    expect(restStateOf(c, c.activeLeaf, true)).toBe("owes-reply");
  });

  it("a call with no result, a result never answered, a person's unanswered message: interrupted", () => {
    const open = conv((b) => {
      add(b, { type: "user", text: "go" });
      add(b, { type: "assistant", text: "", toolCalls: [call] });
    });
    expect(restStateOf(open, open.activeLeaf, false)).toBe("interrupted");
    const answered = conv((b) => {
      add(b, { type: "user", text: "go" });
      add(b, { type: "assistant", text: "", toolCalls: [call] });
      add(b, { type: "tool", toolCallId: "c1", name: "read_file", content: "x" });
    });
    expect(restStateOf(answered, answered.activeLeaf, false)).toBe("interrupted");
    const typed = conv((b) => add(b, { type: "user", text: "are you there?" }));
    expect(restStateOf(typed, typed.activeLeaf, false)).toBe("interrupted");
  });

  it("an agent's delivered message with nothing under it is owed a reply", () => {
    const c = conv((b) => add(b, { type: "user", text: "[Message…]\n\nhi", inbound: { id: "m1", from: "root", kind: "message" } }));
    expect(restStateOf(c, c.activeLeaf, false)).toBe("owes-reply");
  });

  it("steps over wire-silent entries, looks through a compaction, and reads a max_tokens cut-off as at rest", () => {
    const silent = conv((b) => {
      add(b, { type: "user", text: "go" });
      add(b, { type: "assistant", text: "", toolCalls: [call] });
      add(b, { type: "todo", ops: [], by: "agent" });
      add(b, { type: "model-switch", configId: "x", snapshot: { name: "x", model: "y" } });
    });
    expect(restStateOf(silent, silent.activeLeaf, false)).toBe("interrupted");
    // The manual compaction, made at rest over a finished reply: still asleep.
    const compacted = conv((b) => {
      add(b, { type: "user", text: "go" });
      add(b, { type: "assistant", text: "done", finishReason: "stop" });
      add(b, { type: "compaction", summary: "s", replayCut: true });
    });
    expect(restStateOf(compacted, compacted.activeLeaf, false)).toBe("quiescent");
    const cut = conv((b) => {
      add(b, { type: "user", text: "go" });
      add(b, { type: "assistant", text: "a long…", finishReason: "length", truncated: true });
    });
    expect(restStateOf(cut, cut.activeLeaf, false)).toBe("quiescent");
  });

  it("an automatic compaction mid-turn reads as cut off as the branch beneath it (review R1-3)", () => {
    // runLoop's pre-send compact() lands after a drained batch, before the next
    // model call — a restart there must not read "finished".
    const midTurn = conv((b) => {
      add(b, { type: "user", text: "go" });
      add(b, { type: "assistant", text: "", toolCalls: [call] });
      add(b, { type: "tool", toolCallId: "c1", name: "read_file", content: "x" });
      add(b, { type: "compaction", summary: "s", replayCut: true });
    });
    expect(restStateOf(midTurn, midTurn.activeLeaf, false)).toBe("interrupted");
    const owed = conv((b) => {
      add(b, { type: "user", text: "[Message…]\n\nhi", inbound: { id: "m1", from: "root", kind: "message" } });
      add(b, { type: "compaction", summary: "s", replayCut: true });
    });
    expect(restStateOf(owed, owed.activeLeaf, false)).toBe("owes-reply");
  });

  it("a parent that yielded after a spawn is at rest, not cut off (Q5)", () => {
    const spawn = { id: "s1", type: "function" as const, function: { name: SPAWN_AGENT, arguments: "{}" } };
    const yielded = conv((b) => {
      add(b, { type: "user", text: "go" });
      add(b, { type: "assistant", text: "", toolCalls: [spawn, call] });
      add(b, { type: "tool", toolCallId: "s1", name: SPAWN_AGENT, content: "Started" });
      add(b, { type: "tool", toolCallId: "c1", name: "read_file", content: "x" });
    });
    expect(restStateOf(yielded, yielded.activeLeaf, false)).toBe("quiescent");
    expect(restStateOf(yielded, yielded.activeLeaf, true)).toBe("owes-reply");
    // A refused spawn did not yield; nor did a batch cut off before it drained.
    const refused = conv((b) => {
      add(b, { type: "user", text: "go" });
      add(b, { type: "assistant", text: "", toolCalls: [spawn] });
      add(b, { type: "tool", toolCallId: "s1", name: SPAWN_AGENT, content: "refused", isError: true });
    });
    expect(restStateOf(refused, refused.activeLeaf, false)).toBe("interrupted");
    const cut = conv((b) => {
      add(b, { type: "user", text: "go" });
      add(b, { type: "assistant", text: "", toolCalls: [spawn, call] });
      add(b, { type: "tool", toolCallId: "s1", name: SPAWN_AGENT, content: "Started" });
    });
    expect(restStateOf(cut, cut.activeLeaf, false)).toBe("interrupted");
  });

  it("is read on the branch asked for, not the newest entry", () => {
    let c = newConversation();
    const u = appendEntry(c, { type: "user", text: "go" } as never);
    c = u.conv;
    c = appendEntry(c, { type: "assistant", text: "done", finishReason: "stop" } as never).conv;
    const done = c.activeLeaf;
    const fork = appendEntry(c, { type: "user", text: "again" } as never, u.entry.id); // a sibling branch
    c = fork.conv;
    expect(restStateOf(c, fork.entry.id, false)).toBe("interrupted");
    expect(restStateOf(c, done, false)).toBe("quiescent");
  });
});

describe("boot: a tree comes back at rest (X-56 Q15)", () => {
  beforeEach(() => seed());

  it("nothing starts; open agents load with their root, closed ones (and what is under them) stay out", async () => {
    craftTree().write();
    const { app, manager } = makeServer();
    const opened = await post(app, "/conversation/cv_boot/open");
    expect(opened.status).toBe(200);
    const names = manager
      .list()
      .map((s) => s.agentInfo?.name)
      .sort();
    expect(names).toEqual(["agent-1", "agent-2", "agent-3", "agent-6", "root"]);
    expect(requests).toHaveLength(0);
    expect(manager.list().every((s) => s.status === "idle")).toBe(true);
    const rest = Object.fromEntries(manager.list().map((s) => [s.agentInfo!.name, s.restState]));
    expect(rest).toEqual({ root: "quiescent", "agent-1": "interrupted", "agent-2": "quiescent", "agent-3": "owes-reply", "agent-6": "interrupted" });
    // The closed child is in its parent's rail list, its own child folded with it.
    const root = manager.get(opened.json.sessionId)!;
    expect(root.subtree?.closed).toEqual([{ agentId: "a4", name: "agent-4", conversationId: "cv_boot~a4", below: 1 }]);
    expect(opened.json.rest).toBe("quiescent");
    // Opening it again attaches, never duplicates.
    const again = await post(app, "/conversation/cv_boot/open");
    expect(again.json.sessionId).toBe(root.id);
    expect(manager.list()).toHaveLength(5);
  });

  it("a sub-agent is not opened on its own", async () => {
    craftTree().write();
    const { app } = makeServer();
    expect((await post(app, "/conversation/cv_boot~a1/open")).status).toBe(409);
  });

  it("history marks a root with agents, and lists them with their closed flags", async () => {
    const { app, manager, agents } = makeServer();
    const res = await post(app, "/chat", { text: "spawn: say hi ;; say hi" });
    await agents.idle();
    await until(manager, () => manager.list().length === 3);
    await post(app, `/session/${named(manager, "agent-2")!.id}/close`);
    await store.flush();
    const rows = (await (await app.request("/conversations")).json()) as { conversations: { id: string; agents?: boolean }[] };
    expect(rows.conversations.find((r) => r.id === res.json.conversationId)?.agents).toBe(true);
    const listed = (await (await app.request(`/conversation/${res.json.conversationId}/agents`)).json()) as { agents: any[] };
    expect(listed.agents.map((a) => [a.name, a.closed])).toEqual([
      ["agent-1", false],
      ["agent-2", true],
    ]);
  });
});

describe("Wake (X-56 Q14)", () => {
  beforeEach(() => seed());


  it("on the root: resumes the interrupted (healing the open call) and the owing; skips quiescent and closed", async () => {
    const { app, manager, agents, root } = await booted();
    const woke = await post(app, `/session/${root.id}/wake`);
    expect(woke.json.wake.woken.sort()).toEqual(["agent-1", "agent-3", "agent-6"]);
    expect(woke.json.wake.asleep.sort()).toEqual(["agent-2", "root"]);
    expect(woke.json.wake.closed).toEqual(["agent-4"]);
    await agents.idle();
    await until(manager, () => manager.list().every((s) => s.status === "idle"));
    // agent-4 and agent-5 stayed closed and unloaded.
    expect(named(manager, "agent-4")).toBeUndefined();
    expect(named(manager, "agent-5")).toBeUndefined();
    // The open call was answered before anything was sent over it (H-10).
    const a1 = named(manager, "agent-1")!;
    expect(tools(a1).find((t) => t.toolCallId === "call_a1")?.content).toMatch(/not run/);
    for (const req of requests) expect(everyCallAnswered(req.messages)).toBe(true);
    // The owed message was delivered, and answered.
    const a3 = named(manager, "agent-3")!;
    expect(a3.conversation.entries.some((e) => e.type === "user" && e.inbound?.id === "in_late")).toBe(true);
    // Everyone woken came to rest on a reply of its own — and told its parent.
    for (const name of ["agent-1", "agent-3", "agent-6"]) expect(named(manager, name)!.restState).not.toBe("interrupted");
    expect(root.conversation.entries.filter((e) => e.type === "user" && e.inbound?.kind === "finished").length).toBeGreaterThanOrEqual(2);
  });

  it("is scoped to the entry it was asked on: a child's Wake leaves its siblings asleep", async () => {
    const { app, manager, agents } = await booted();
    const a2 = named(manager, "agent-2")!;
    const woke = await post(app, `/session/${a2.id}/wake`);
    expect(woke.json.wake.woken).toEqual(["agent-6"]);
    expect(woke.json.wake.asleep).toEqual(["agent-2"]);
    await agents.idle();
    expect(named(manager, "agent-1")!.restState).toBe("interrupted");
    expect(named(manager, "agent-3")!.restState).toBe("owes-reply");
  });

  it("admits through the width cap: past it a woken agent waits queued, then starts FIFO", async () => {
    seed({ agentConcurrency: 1 });
    const { app, manager, agents, root } = await booted();
    const woke = await post(app, `/session/${root.id}/wake`);
    expect(woke.json.wake.woken).toHaveLength(1);
    expect(woke.json.wake.queued).toHaveLength(2);
    await agents.idle();
    await until(manager, () => manager.list().every((s) => s.status === "idle"));
    for (const name of ["agent-1", "agent-3", "agent-6"]) expect(named(manager, name)!.restState).not.toBe("interrupted");
  });

  it("is not human input: a woken turn keeps spending the same tool-round budget", async () => {
    seed({ toolRounds: 2 });
    const { app, manager } = makeServer();
    const res = await post(app, "/chat", { text: "loop: notes.txt" });
    const s = manager.get(res.json.sessionId)!;
    await until(manager, () => s.status === "awaiting-continue");
    const before = requests.length;
    // Interrupt it at the pause (a hard Stop leaves the result unanswered by a
    // model: the tip is a tool result) — then Wake it.
    await post(app, `/session/${s.id}/stop`, { scope: "hard" });
    expect(s.restState).toBe("interrupted");
    await post(app, `/session/${s.id}/wake`);
    // The budget it used is still used: it pauses again before any model call.
    await until(manager, () => s.status === "awaiting-continue");
    expect(requests.length).toBe(before);
  });

  it("a loaded session's first turn announces `rest: null` — a woken one stops reading cut off (review R1-2)", async () => {
    const { app, manager, agents } = await booted();
    const a6 = named(manager, "agent-6")!; // tip: a tool result, no open call
    const seen: string[] = [];
    a6.onEvent((e) => {
      if (e.type === "rest") seen.push(String(e.rest));
    });
    await post(app, `/session/${a6.id}/wake`);
    await agents.idle();
    await until(manager, () => a6.status === "idle");
    expect(seen[0]).toBe("null");
    expect(seen.at(-1)).toBe("quiescent");
  });

  it("does not reset the failure breaker: a root waking a failing child still halts it (review R1-4)", async () => {
    const { manager } = await booted();
    const a1 = named(manager, "agent-1")! as unknown as { consecutiveFailures: number; wake(): { done: Promise<void> } };
    a1.consecutiveFailures = 2;
    const { done } = a1.wake();
    expect(a1.consecutiveFailures).toBe(2);
    await done;
  });

  it("wake_agents is the root's: the root wakes its tree, a sub-agent is refused", async () => {
    const { manager, agents, root } = await booted();
    const text = agents.wakeAgents(root);
    expect(text).toMatch(/Woken: .*agent-1/);
    expect(text).toMatch(/Closed, not woken.*agent-4/);
    await agents.idle();
    await until(manager, () => manager.list().every((s) => s.status === "idle"));
    expect(() => agents.wakeAgents(named(manager, "agent-2")!)).toThrow(/root thread's/);
  });
});

describe("closing and reopening (X-56 Q18–Q20)", () => {
  beforeEach(() => seed());

  async function tree() {
    const server = makeServer();
    const res = await post(server.app, "/chat", { text: "spawn: say hi ;; say hi" });
    await server.agents.idle();
    await until(server.manager, () => server.manager.list().length === 3 && server.manager.list().every((s) => s.status === "idle"));
    return { ...server, root: server.manager.get(res.json.sessionId)! };
  }

  it("closing a child unloads it, keeps it in its parent's list, and tells nobody it was stopped (H-17f)", async () => {
    const { app, manager, agents, root } = await tree();
    const a1 = named(manager, "agent-1")!;
    const notices = () => root.conversation.entries.filter((e) => e.type === "user" && e.inbound?.from === "agent-1").length;
    const before = notices();
    await post(app, `/session/${a1.id}/close`);
    await agents.idle();
    expect(named(manager, "agent-1")).toBeUndefined();
    expect(root.subtree?.closed.map((c) => c.name)).toEqual(["agent-1"]);
    expect(notices()).toBe(before);
    expect(root.queuedMessages).toHaveLength(0);
    await store.flush();
    expect(store.agents(root.conversation.id).find((r) => r.name === "agent-1")?.closed).toBe(true);
    // load() ignores the control record: the root's own tree is untouched.
    expect(store.load(root.conversation.id)!.entries.length).toBe(root.conversation.entries.length);
  });

  it("a child closed on its question card sends no 'stopped by the user' notice either (H-17f)", async () => {
    const { app, manager, agents } = makeServer();
    const res = await post(app, "/chat", { text: "spawn: ask@user: which one?" });
    const root = manager.get(res.json.sessionId)!;
    await agents.idle();
    await until(manager, () => named(manager, "agent-1")?.status === "awaiting-input");
    const before = root.conversation.entries.length;
    await post(app, `/session/${named(manager, "agent-1")!.id}/close`);
    await agents.idle();
    expect(root.queuedMessages).toHaveLength(0);
    expect(root.conversation.entries.length).toBe(before);
    expect(root.status).toBe("idle");
  });

  it("a click reopens it at rest, and clears the flag", async () => {
    const { app, manager, root } = await tree();
    const a1 = named(manager, "agent-1")!;
    await post(app, `/session/${a1.id}/close`);
    const reopened = await post(app, `/session/${root.id}/agent/${a1.conversation.id.split("~")[1]}/reopen`);
    expect(reopened.status).toBe(200);
    const back = manager.get(reopened.json.sessionId)!;
    expect(back.agentInfo?.name).toBe("agent-1");
    expect(back.status).toBe("idle");
    expect(back.conversation.entries.length).toBe(a1.conversation.entries.length);
    expect(root.subtree?.closed).toEqual([]);
    await store.flush();
    expect(store.agents(root.conversation.id).find((r) => r.name === "agent-1")?.closed).toBeUndefined();
  });

  it("a message to a closed agent reopens it", async () => {
    const { app, manager, agents, root } = await tree();
    await post(app, `/session/${named(manager, "agent-2")!.id}/close`);
    expect(agents.send(root, "agent-2", "welcome back")).toMatch(/Sent to "agent-2"/);
    await agents.idle();
    const back = named(manager, "agent-2")!;
    expect(back.conversation.entries.some((e) => e.type === "user" && e.inbound?.from === "root" && e.text.endsWith("welcome back"))).toBe(true);
    expect(root.subtree?.closed).toEqual([]);
  });

  it("an agent closes its own children; list_agents leaves them out unless asked", async () => {
    const { manager, agents, root } = await tree();
    expect(agents.listAgents(root, false)).toMatch(/agent-1 — opus .* — finished its turn, idle[\s\S]*agent-2/);
    expect(agents.closeChild(root, "agent-1")).toMatch(/Closed "agent-1"/);
    expect(named(manager, "agent-1")).toBeUndefined();
    const listed = agents.listAgents(root, false);
    expect(listed).not.toMatch(/agent-1/);
    expect(listed).toMatch(/1 closed not shown/);
    expect(agents.listAgents(root, true)).toMatch(/agent-1 — closed/);
    expect(agents.closeChild(root, "agent-1")).toMatch(/already closed/);
    // Only its own: a child cannot close its sibling.
    expect(() => agents.closeChild(named(manager, "agent-2")!, "agent-1")).toThrow(/No sub-agent "agent-1" of yours/);
  });

  it("reopening a closed agent brings back its own open children, not its closed ones", async () => {
    const t = craftTree();
    t.write();
    const { app, manager } = makeServer();
    const opened = await post(app, "/conversation/cv_boot/open");
    const reopened = await post(app, `/session/${opened.json.sessionId}/agent/a4/reopen`);
    expect(manager.get(reopened.json.sessionId)?.agentInfo?.name).toBe("agent-4");
    expect(named(manager, "agent-5")?.agentInfo?.parentSessionId).toBe(reopened.json.sessionId);
    expect(requests).toHaveLength(0);
  });

  it("a reopen from the session's own copy owes nothing already answered (review R1-1)", async () => {
    const { app, manager, agents, root } = await booted();
    const a3 = named(manager, "agent-3")!;
    await post(app, `/session/${a3.id}/wake`);
    await agents.idle();
    await until(manager, () => a3.status === "idle");
    const answered = (s: Session) => s.conversation.entries.filter((e) => e.type === "user" && e.inbound?.id === "in_late").length;
    expect(answered(a3)).toBe(1);
    await post(app, `/session/${a3.id}/close`);
    const back = manager.get((await post(app, `/session/${root.id}/agent/a3/reopen`)).json.sessionId)!;
    expect(back.restState).toBe("quiescent");
    expect(back.queuedMessages).toHaveLength(0);
    const before = requests.length;
    expect((await post(app, `/session/${back.id}/wake`)).json.wake.asleep).toEqual(["agent-3"]);
    await agents.idle();
    expect(answered(back)).toBe(1);
    expect(requests.length).toBe(before);
  });

  it("a message a close's Stop dropped is not owed after a reopen — as the file says (review R1-1)", async () => {
    const { app, manager, root } = await booted();
    const a3 = named(manager, "agent-3")!;
    expect(a3.restState).toBe("owes-reply");
    await post(app, `/session/${a3.id}/close`);
    const back = manager.get((await post(app, `/session/${root.id}/agent/a3/reopen`)).json.sessionId)!;
    expect(back.queuedMessages).toHaveLength(0);
    await store.flush();
    expect(store.load("cv_boot~a3")!.inbox).toBeUndefined();
    expect(back.restState).toBe(restStateOf(store.load("cv_boot~a3")!, back.conversation.activeLeaf, false));
  });

  it("closing then reopening at once reads the session's own copy, not a file that is behind it", async () => {
    const { manager, agents, root } = await tree();
    const a1 = named(manager, "agent-1")!;
    const entries = a1.conversation.entries.length;
    agents.closeChild(root, "agent-1");
    const back = agents.reopen(root, a1.conversation.id.split("~")[1]!);
    expect(back.conversation.entries.length).toBe(entries);
  });

  it("closing a root closes into history as before: no flags, and its tree comes back with it", async () => {
    const { app, manager, root } = await tree();
    const conv = root.conversation.id;
    await post(app, `/session/${root.id}/close`);
    expect(manager.list()).toHaveLength(0);
    expect(store.agents(conv).every((r) => !r.closed)).toBe(true);
    await post(app, `/conversation/${conv}/open`);
    expect(manager.list().map((s) => s.agentInfo?.name).sort()).toEqual(["agent-1", "agent-2", "root"]);
  });
});

describe("round 2: the cap, a Stop's rest, fault listeners", () => {
  beforeEach(() => seed());

  it("closing an agent keeps its spend in the tree's total, so the cap still holds (H-18a)", async () => {
    const server = makeServer();
    const { app, manager, agents } = server;
    const res = await post(app, "/chat", { text: "spawn: say hi ;; say hi" });
    await agents.idle();
    await until(manager, () => manager.list().length === 3 && manager.list().every((s) => s.status === "idle"));
    const root = manager.get(res.json.sessionId)!;
    const a1 = named(manager, "agent-1")!;
    expect(a1.spendUsd).toBeGreaterThan(0);
    const before = root.treeSpendUsd;
    agents.closeChild(root, "agent-1");
    expect(root.treeSpendUsd).toBeCloseTo(before, 12);
    // A cap at what the tree has spent blocks the next call, closed agent and all.
    await post(app, `/session/${root.id}/cap`, { capUsd: before });
    const n = requests.length;
    await post(app, "/chat", { sessionId: root.id, text: "hello" });
    expect(root.capReached).toBe(true);
    expect(requests.length).toBe(n);
  });

  it("after a restart, a closed agent's spend is folded from its log into the tree's total", async () => {
    const t = craftTree();
    // agent-4 (closed) spent $0.50 in calls the provider priced.
    t.entry("a4", { type: "assistant", parent: null, text: "x", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.5 } });
    t.write();
    const { app, manager } = makeServer();
    const opened = await post(app, "/conversation/cv_boot/open");
    const root = manager.get(opened.json.sessionId)!;
    expect(named(manager, "agent-4")).toBeUndefined();
    expect(root.treeSpendUsd).toBeGreaterThanOrEqual(0.5);
    await post(app, `/session/${root.id}/cap`, { capUsd: 0.4 });
    const n = requests.length;
    await post(app, "/chat", { sessionId: root.id, text: "hello" });
    expect(root.capReached).toBe(true);
    expect(requests.length).toBe(n);
  });

  it("a hard Stop of a cap-parked turn announces it as interrupted, so Wake is offered", async () => {
    const { app, manager } = makeServer();
    const res = await post(app, "/chat", { text: "hi" });
    const s = manager.get(res.json.sessionId)!;
    await post(app, `/session/${s.id}/cap`, { capUsd: s.spendUsd + 1e-9 });
    await post(app, "/chat", { sessionId: s.id, text: "loop: notes.txt" });
    await until(manager, () => s.capReached && s.status === "idle");
    expect(s.restState).toBeNull();
    const seen: unknown[] = [];
    s.onEvent((e) => {
      if (e.type === "rest") seen.push(e.rest);
    });
    await post(app, `/session/${s.id}/stop`, { scope: "hard" });
    expect(s.restState).toBe("interrupted");
    expect(seen).toEqual(["interrupted"]);
  });

  it("a session leaving the bag drops its store fault listener — close/reopen cycles leak none", async () => {
    const { app, manager, agents } = makeServer();
    const res = await post(app, "/chat", { text: "spawn: say hi" });
    await agents.idle();
    await until(manager, () => manager.list().length === 2 && manager.list().every((s) => s.status === "idle"));
    const root = manager.get(res.json.sessionId)!;
    const count = () => (store as unknown as { faultListeners: Set<unknown> }).faultListeners.size;
    const steady = count();
    const agentId = named(manager, "agent-1")!.conversation.id.split("~")[1]!;
    for (let i = 0; i < 3; i++) {
      agents.closeChild(root, "agent-1");
      expect(count()).toBe(steady - 1);
      await post(app, `/session/${root.id}/agent/${agentId}/reopen`);
      expect(count()).toBe(steady);
    }
    await post(app, `/session/${root.id}/close`);
    expect(count()).toBe(steady - 2);
  });
});

describe("the store's closed flag", () => {
  it("folds newest-wins, and reopening clears it", async () => {
    const rootId = "cv_flags";
    const t = new Craft(rootId);
    t.agent("x", "agent-1").closed("x").write();
    expect(store.agents(rootId)[0]!.closed).toBe(true);
    await store.agentClosed(rootId, "x", false);
    expect(store.agents(rootId)[0]!.closed).toBeUndefined();
    expect(agentConversationId(rootId, "x")).toBe("cv_flags~x");
  });
});
