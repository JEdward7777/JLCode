/**
 * P9f2 — a parent changes a child's mode (X-58, D-88/D-93).
 *
 *   - `set_agent_mode(to, mode)` reaches the caller's direct children only;
 *     any mode up to the caller's own, no card; tightening always;
 *   - recorded on the `AgentRecord` (an `agent-mode` control record), so a
 *     close-and-reopen and a restart keep it, still under the revival ceiling;
 *   - it lands between batches, never mid-batch, and the child is told by a
 *     note on the wire before its next model call — never over an unanswered
 *     call (H-10);
 *   - tightening caps the child's live sub-agents; loosening never loosens them;
 *   - a closed child is refused (a message reopens it).
 *
 * Tier 0: the fake driver; waits are on the coordinator's own in-flight work.
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
import { addModelConfig, resolveForCwd, setBinding } from "../src/config/operations";
import { resolvePaths, type JlcodePaths } from "../src/paths";
import { fakeAgentDriver } from "../src/session/fake";
import { stripEnvironmentDetails } from "../src/conversation/wire";
import { agentCard } from "../web/src/agents";
import { SET_AGENT_MODE, setAgentModeTool } from "../src/tools/agent-tools";
import type { ChatMessage, ChatRequest, LlmDriver, StreamEvent } from "../src/llm/types";
import type { ModelConfig } from "../src/config/types";
import type { Entry } from "../src/conversation/types";
import type { Tool } from "../src/tools/types";
import type { Session } from "../src/session/session";
import type { EntryView } from "../web/src/api";

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
let requests: { session: string; req: ChatRequest }[];
/** What the `hook` tool does when a model calls it — set per test. */
let onHook: () => void;
const saved = { config: process.env.JLCODE_CONFIG_DIR, data: process.env.JLCODE_DATA_DIR };

const HEADER = /^\[(?:Task|Message|Question) from [\s\S]*?\]\n\n/;

/** A read-only tool that runs a test's code inside a batch. */
const hookTool: Tool = {
  name: "hook",
  kind: "read",
  mutates: false,
  def: { type: "function", function: { name: "hook", description: "test hook", parameters: { type: "object", properties: {} } } },
  async execute() {
    onHook();
    return { content: "hooked" };
  },
};

/**
 * The fake agent driver, plus `batch:` — one assistant turn calling `hook` and
 * then `write_file mid.txt`, so a test can act between two calls of one batch.
 */
function treeDriver(): LlmDriver {
  const fake = fakeAgentDriver();
  return {
    async *streamChat(req, opts): AsyncGenerator<StreamEvent> {
      requests.push({ session: "", req });
      const last = req.messages[req.messages.length - 1];
      const said =
        last?.role === "user" && typeof last.content === "string" ? stripEnvironmentDetails(last.content).trim().replace(HEADER, "") : "";
      // `hookthen: {"name":…,"args":…}` — `hook`, then that call, in one batch.
      if (said.startsWith("hookthen:")) {
        const spec = JSON.parse(said.slice("hookthen:".length).trim()) as { name: string; args: unknown };
        yield { type: "tool_call", index: 0, id: `h0_${requests.length}`, name: "hook", argsDelta: "{}" };
        yield { type: "tool_call", index: 1, id: `h1_${requests.length}`, name: spec.name, argsDelta: JSON.stringify(spec.args) };
        yield { type: "finish", reason: "tool_calls" };
        yield { type: "usage", usage: { promptTokens: 1000, completionTokens: 10 } };
        return;
      }
      if (said.startsWith("batch:")) {
        yield { type: "tool_call", index: 0, id: `b0_${requests.length}`, name: "hook", argsDelta: "{}" };
        yield {
          type: "tool_call",
          index: 1,
          id: `b1_${requests.length}`,
          name: "write_file",
          argsDelta: JSON.stringify({ path: "mid.txt", content: "mid" }),
        };
        yield { type: "finish", reason: "tool_calls" };
        yield { type: "usage", usage: { promptTokens: 1000, completionTokens: 10 } };
        return;
      }
      yield* fake.streamChat(req, opts);
    },
  };
}

function seed(over: Partial<ModelConfig> = {}) {
  const cfg = defaultConfig();
  const a = addModelConfig(cfg, {
    name: "opus",
    model: OPUS,
    openRouterKey: KEY_A,
    defaultMode: "code",
    defaultApproval: "full-auto",
    compaction: { auto: true },
    environment: { turnTimestamps: false },
    pricing: { promptPerMTok: 1, completionPerMTok: 1 },
    ...over,
  });
  saveConfig(setBinding(a.config, workspace, a.added.id), paths);
}

function makeServer() {
  const deps = { paths, cwd: workspace, makeDriver: treeDriver, mcpTools: () => [hookTool], catalog };
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

const named = (s: Server, name: string) => s.manager.list().find((x) => x.agentInfo?.name === name);
const toolResults = (s: Session) => s.conversation.entries.filter((e): e is Extract<Entry, { type: "tool" }> => e.type === "tool");
const modeNotes = (s: Session) =>
  s.conversation.entries.filter((e): e is Extract<Entry, { type: "user" }> => e.type === "user" && e.inbound?.kind === "mode");
const lastResult = (s: Session, name: string) => toolResults(s).filter((t) => t.name === name).at(-1)!;

/** Every `tool_calls` message on the wire is answered before anything else (D-84, H-10). */
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

const wireText = (req: ChatRequest) => req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n---\n");

/** A root that spawned `agent-1` with `spawnVerb`, all settled. */
async function tree(spawnVerb: string) {
  const server = makeServer();
  const first = await post(server.app, "/chat", { text: spawnVerb });
  await server.agents.idle();
  const root = server.manager.get(first.json.sessionId as string)!;
  return { ...server, root, child: named(server, "agent-1")! };
}

/** The root types a fake-driver command, as the person would. */
async function say(s: Server, session: Session, text: string) {
  await post(s.app, "/chat", { sessionId: session.id, text });
  await s.agents.idle();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-p9f2-"));
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
  onHook = () => {};
});

afterEach(async () => {
  await store.close();
  process.env.JLCODE_CONFIG_DIR = saved.config;
  process.env.JLCODE_DATA_DIR = saved.data;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("set_agent_mode — the tool", () => {
  it("is offered to every session, after the lifecycle tools, with the modes as an enum", () => {
    const def = setAgentModeTool().def.function;
    expect(def.name).toBe(SET_AGENT_MODE);
    expect((def.parameters as any).required).toEqual(["to", "mode"]);
    expect((def.parameters as any).properties.mode.enum).toEqual(["ask", "plan", "code"]);
  });

  it("rejects a mode that is not one, and a missing name", async () => {
    seed();
    const s = await tree("spawn#ask: say hi");
    await say(s, s.root, "mode@agent-1#sudo:");
    expect(lastResult(s.root, SET_AGENT_MODE)).toMatchObject({ isError: true });
    expect(lastResult(s.root, SET_AGENT_MODE).content).toMatch(/`mode` is one of ask, plan, code/);
    expect(s.child.mode).toBe("ask");
  });
});

describe("loosening up to the parent's own mode, with no card", () => {
  it("an ask child set to code may write on its next turn — told before its next model call", async () => {
    seed();
    const s = await tree("spawn#ask: say hi");
    expect(s.child.mode).toBe("ask");
    await say(s, s.root, "mode@agent-1#code:");
    const result = lastResult(s.root, SET_AGENT_MODE);
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/^Set "agent-1" to code mode \(was ask\)/);
    // Idle, so it applies at once — the pane and the rail read it live.
    expect(s.child.mode).toBe("code");
    expect(s.child.status).toBe("idle");
    // No turn was started: the note waits for the next one.
    expect(modeNotes(s.child)).toHaveLength(0);
    expect(s.root.status).not.toBe("awaiting-approval");
    expect(store.agents(s.root.conversation.id)[0]).toMatchObject({ name: "agent-1", mode: "code" });

    const before = requests.length;
    await say(s, s.root, "msg: agent-1 | write: out.txt | made in code mode");
    expect(fs.readFileSync(path.join(workspace, "out.txt"), "utf8")).toBe("made in code mode");
    // The child's next request carries the note, ahead of the message that
    // opened the turn, and the writing tools are on offer and allowed.
    const childReq = requests.slice(before).map((r) => r.req).find((r) => wireText(r).includes("set your mode to code"))!;
    expect(childReq).toBeDefined();
    const text = wireText(childReq);
    expect(text.indexOf("set your mode to code")).toBeLessThan(text.indexOf("write: out.txt"));
    expect(childReq.tools!.map((t) => t.function.name)).toContain("write_file");
    const [note] = modeNotes(s.child);
    expect(note!.inbound).toMatchObject({ from: "root", kind: "mode" });
    expect(note!.text).toMatch(/^\[Your parent agent "root" set your mode to code — you may edit files and run commands\.\]$/);
  });

  it("a plan parent may loosen an ask child to plan", async () => {
    seed({ defaultMode: "plan" });
    const s = await tree("spawn#ask: say hi");
    await say(s, s.root, "mode@agent-1#plan:");
    expect(lastResult(s.root, SET_AGENT_MODE).isError).toBeFalsy();
    expect(s.child.mode).toBe("plan");
  });

  it("refuses above the parent's mode, and changes nothing", async () => {
    seed({ defaultMode: "plan" });
    const s = await tree("spawn#ask: say hi");
    await say(s, s.root, "mode@agent-1#code:");
    const result = lastResult(s.root, SET_AGENT_MODE);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/^set_agent_mode refused: you are in plan mode.*\(ask, plan\)/);
    expect(s.child.mode).toBe("ask");
    expect(store.agents(s.root.conversation.id)[0]!.mode).toBe("ask");
    await store.flush();
    expect(fs.readFileSync(path.join(convDir, `${s.root.conversation.id}.jsonl`), "utf8")).not.toMatch(/agent-mode/);
  });

  it("setting the mode it already has records it and says so, with no note", async () => {
    seed();
    const s = await tree("spawn: say hi");
    expect(store.agents(s.root.conversation.id)[0]!.mode).toBeUndefined();
    await say(s, s.root, "mode@agent-1#code:");
    expect(lastResult(s.root, SET_AGENT_MODE).content).toBe('"agent-1" is already in code mode.');
    expect(store.agents(s.root.conversation.id)[0]!.mode).toBe("code");
    await say(s, s.root, "msg: agent-1 | say hi");
    expect(modeNotes(s.child)).toHaveLength(0);
  });
});

describe("tightening", () => {
  it("is always allowed, and the child's next write is refused", async () => {
    seed();
    const s = await tree("spawn: say hi");
    expect(s.child.mode).toBe("code");
    await say(s, s.root, "mode@agent-1#ask:");
    expect(lastResult(s.root, SET_AGENT_MODE).content).toMatch(/^Set "agent-1" to ask mode \(was code\)/);
    expect(s.child.mode).toBe("ask");
    await say(s, s.root, "msg: agent-1 | write: nope.txt | no");
    expect(fs.existsSync(path.join(workspace, "nope.txt"))).toBe(false);
    expect(lastResult(s.child, "write_file").content).toMatch(/Ask mode is read-only/);
    expect(modeNotes(s.child)[0]!.text).toMatch(/set your mode to ask — read-only/);
  });

  // Flake note (one unexplained red in a full `npm test` at load ~7, error not
  // captured; not reproduced since). Ruled out: every wait here is
  // `say`/`tree` → `post` (which awaits the whole turn, then `flushDurable`)
  // then `agents.idle()`. Neither has a timer. The coordinator tracks every
  // background start (`later`/`track`), and a probe asserting "every session
  // idle" after each `idle()` held for 287 runs under CPU stress, 6 copies at
  // once. `store.agents()` reads the file, but agent-2's row is flushed by the
  // step-2 post. Nothing is pending at `store.close()`. Tool-call ids
  // (`fake_${Date.now()}`) only pair within one batch. The `capBelow` /
  // `setModeFromParent` path is synchronous. Hunch: the 20s `testTimeout`.
  // Wall time here was roughly records × fsync (every `AppendLog` write fsyncs),
  // and it scaled with disk contention, not CPU: 2.3s alone, ~6s in a normal
  // full suite, ~12s with two suites running together, and 18.3s under heavy
  // synthetic fsync load. In that last run its neighbour "a child cannot loosen
  // its own child…" timed out at 22s against the 20s ceiling.
  // Done: this file's store (and the other agent suites') now runs with
  // `fsync: false` (`ConversationStore` option; production still fsyncs), so
  // run time no longer tracks the disk. Measured after, same fsync stress:
  // this test 10.0s → 0.02s, this file 121s → 0.4s, the four agent suites
  // 2m02s → 1.9s wall (unstressed: 6.2s → 0.02s, 63s → 1.7s). That
  // the original red was this timeout is still a hunch — the message was never
  // captured. If it recurs, capture the message.
  it("caps the child's live sub-agents now and tells them; their records keep their own mode", async () => {
    seed();
    const s = await tree("spawn: say hi");
    await say(s, s.child, "spawn: say hi"); // the person, in agent-1's pane
    const grand = named(s, "agent-2")!;
    expect(grand.mode).toBe("code");
    await say(s, s.root, "mode@agent-1#ask:");
    expect(lastResult(s.root, SET_AGENT_MODE).content).toMatch(/Also capped \(below it\): "agent-2"\./);
    expect(s.child.mode).toBe("ask");
    expect(grand.mode).toBe("ask");
    const records = store.agents(s.root.conversation.id);
    expect(records.find((r) => r.name === "agent-2")!.mode).toBeUndefined();
    await say(s, s.child, "msg: agent-2 | say hi");
    expect(modeNotes(grand)[0]).toMatchObject({ inbound: { from: "agent-1", kind: "mode" } });
    expect(modeNotes(grand)[0]!.text).toMatch(/^\[Your mode was capped at ask/);
  });

  it("loosening the child never loosens a grandchild spawned stricter", async () => {
    seed();
    const s = await tree("spawn#plan: say hi");
    await say(s, s.child, "spawn#ask: say hi");
    const grand = named(s, "agent-2")!;
    expect(grand.mode).toBe("ask");
    await say(s, s.root, "mode@agent-1#code:");
    expect(s.child.mode).toBe("code");
    expect(grand.mode).toBe("ask");
  });
});

describe("only the caller's own children", () => {
  it("refuses a sibling, a grandchild, the parent and itself — with the names it may use", async () => {
    seed();
    const s = await tree("spawn: say hi ;; say hi");
    const a1 = named(s, "agent-1")!;
    await say(s, a1, "spawn: say hi");
    expect(named(s, "agent-3")).toBeDefined();
    const before = new Map(s.manager.list().map((x) => [x.id, x.mode]));

    // A grandchild, by the root.
    await say(s, s.root, "mode@agent-3#ask:");
    expect(lastResult(s.root, SET_AGENT_MODE)).toMatchObject({ isError: true });
    expect(lastResult(s.root, SET_AGENT_MODE).content).toMatch(/no sub-agent "agent-3" of yours.*Yours: "agent-1", "agent-2"\./);
    // A sibling, the parent (by name and as "parent") and itself, by agent-1.
    for (const to of ["agent-2", "root", "parent", "agent-1"]) {
      expect(() => s.agents.setAgentMode(a1, to, "ask")).toThrow(/no sub-agent .* of yours.*Yours: "agent-3"\./);
    }
    for (const x of s.manager.list()) expect(x.mode).toBe(before.get(x.id));
  });

  it("a session with no tree gets the plain refusal", async () => {
    const result = await setAgentModeTool().execute({ to: "agent-1", mode: "ask" }, { sandbox: undefined as never });
    expect(result).toMatchObject({ isError: true, content: "sub-agents are not available in this session" });
  });
});

describe("persistence — close, revival, restart", () => {
  it("a closed child is refused; reopened by a message, it keeps the mode it was set to", async () => {
    seed();
    const s = await tree("spawn#ask: say hi");
    await say(s, s.root, "mode@agent-1#code:");
    await post(s.app, `/session/${s.child.id}/close`);
    await say(s, s.root, "mode@agent-1#plan:");
    expect(lastResult(s.root, SET_AGENT_MODE).content).toMatch(/^set_agent_mode refused: "agent-1" is closed\. A send_message to it reopens it/);
    await store.flush();
    await say(s, s.root, "msg: agent-1 | welcome back");
    expect(named(s, "agent-1")!.mode).toBe("code");
  });

  it("the revival ceiling still applies: a parent tightened since caps the revived child", async () => {
    seed();
    const s = await tree("spawn#ask: say hi");
    await say(s, s.root, "mode@agent-1#code:");
    await post(s.app, `/session/${s.child.id}/close`);
    s.root.setModeApproval("plan"); // the person tightens the root
    await store.flush();
    await say(s, s.root, "msg: agent-1 | welcome back");
    expect(named(s, "agent-1")!.mode).toBe("plan");
  });

  it("survives a restart: the tree opened from history brings the child back in the mode it was set to", async () => {
    seed();
    const s = await tree("spawn#ask: say hi");
    await say(s, s.root, "mode@agent-1#code:");
    await say(s, s.root, "mode@agent-1#plan:");
    const rootId = s.root.conversation.id;
    await store.flush();
    const lines = fs.readFileSync(path.join(convDir, `${rootId}.jsonl`), "utf8").split("\n").filter((l) => l.includes('"agent-mode"'));
    expect(lines).toHaveLength(2); // newest wins on read
    // The control record is the tree's, not the root's transcript.
    expect(store.load(rootId)!.entries.some((e) => (e as any).kind === "agent-mode")).toBe(false);

    await store.close();
    store = new ConversationStore(convDir, { fsync: false });
    const again = makeServer();
    const opened = await post(again.app, `/conversation/${rootId}/open`);
    expect(opened.status).toBe(200);
    expect(named(again, "agent-1")!.mode).toBe("plan");
  });
});

describe("when it lands — between batches, never mid-batch (H-10)", () => {
  it("a call already issued keeps the mode it was issued under; the next request is made under the new one", async () => {
    seed();
    const s = await tree("spawn#ask: say hi");
    let during: { mode: string; ahead: string; notes: number } | undefined;
    const modeEvents: string[] = [];
    s.child.onEvent((e) => {
      if (e.type === "mode") modeEvents.push(e.mode);
    });
    onHook = () => {
      s.agents.setAgentMode(s.root, "agent-1", "code");
      during = { mode: s.child.mode, ahead: s.child.modeAhead, notes: modeNotes(s.child).length };
    };
    const before = requests.length;
    await say(s, s.root, "msg: agent-1 | batch:");

    // Mid-batch: recorded, held — nothing applied, nothing written.
    expect(during).toEqual({ mode: "ask", ahead: "code", notes: 0 });
    expect(store.agents(s.root.conversation.id)[0]!.mode).toBe("code");
    // The write in the same batch ran under ask.
    expect(lastResult(s.child, "write_file").content).toMatch(/Ask mode is read-only/);
    expect(fs.existsSync(path.join(workspace, "mid.txt"))).toBe(false);
    // Applied once the batch drained, announced once.
    expect(s.child.mode).toBe("code");
    expect(modeEvents).toEqual(["code"]);

    // The note sits right after the batch's last result, and the request that
    // followed carries it — every call on every request answered first.
    const notes = modeNotes(s.child);
    expect(notes).toHaveLength(1);
    const results = toolResults(s.child);
    expect(notes[0]!.parent).toBe(results.at(-1)!.id);
    const childReqs = requests.slice(before).map((r) => r.req).filter((r) => wireText(r).includes("batch:"));
    expect(childReqs.length).toBeGreaterThanOrEqual(2);
    for (const r of childReqs) expect(everyCallAnswered(r.messages)).toBe(true);
    const after = childReqs.find((r) => wireText(r).includes("set your mode to code"))!;
    expect(after.messages.at(-1)).toMatchObject({ role: "user" });
    expect(String(after.messages.at(-1)!.content)).toMatch(/set your mode to code/);

    // And the next turn writes.
    await say(s, s.root, "msg: agent-1 | write: later.txt | ok");
    expect(fs.existsSync(path.join(workspace, "later.txt"))).toBe(true);
  });

  it("set while the child waits on an approval card: nothing is said over the open call; it lands after the batch", async () => {
    seed({ defaultApproval: "manual" });
    const s = await tree("spawn#plan: write: plan.md | the plan");
    expect(s.child.status).toBe("awaiting-approval");
    const entries = s.child.conversation.entries.length;
    s.agents.setAgentMode(s.root, "agent-1", "code");
    // Held: the card's call was gated under plan, and the log is untouched.
    expect(s.child.mode).toBe("plan");
    expect(s.child.modeAhead).toBe("code");
    expect(s.child.conversation.entries.length).toBe(entries);

    const before = requests.length;
    await s.child.approve({ approve: true });
    await s.agents.idle();
    expect(fs.readFileSync(path.join(workspace, "plan.md"), "utf8")).toBe("the plan");
    expect(s.child.mode).toBe("code");
    const notes = modeNotes(s.child);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.parent).toBe(lastResult(s.child, "write_file").id);
    for (const r of requests.slice(before)) expect(everyCallAnswered(r.req.messages)).toBe(true);
  });

  it("a person's own mode change outranks a parent's change still waiting to land", async () => {
    seed({ defaultApproval: "manual" });
    const s = await tree("spawn#plan: write: plan.md | the plan");
    s.agents.setAgentMode(s.root, "agent-1", "code");
    s.child.setModeApproval("ask"); // the person, in the child's pane
    await s.child.approve({ approve: true });
    await s.agents.idle();
    expect(s.child.mode).toBe("ask");
    expect(modeNotes(s.child)).toHaveLength(0);
  });

  it("a hard Stop is an idle point: a held change lands, and its note waits for the next turn", async () => {
    seed({ defaultApproval: "manual" });
    const s = await tree("spawn#plan: write: plan.md | the plan");
    s.agents.setAgentMode(s.root, "agent-1", "code");
    s.child.stop("hard");
    await s.agents.idle();
    expect(s.child.mode).toBe("code");
    expect(modeNotes(s.child)).toHaveLength(0);
    // (The root holds the parked "stopped" notice, so the person types here.)
    await say(s, s.child, "say hi");
    expect(modeNotes(s.child)).toHaveLength(1);
  });
});

describe("a held tightening is already the ceiling (round 1)", () => {
  const hookThen = (name: string, args: unknown) => `hookthen: ${JSON.stringify({ name, args })}`;

  it("a child cannot loosen its own child past a tightening held for its batch", async () => {
    seed();
    const s = await tree("spawn: say hi");
    await say(s, s.child, "spawn#ask: say hi");
    const grand = named(s, "agent-2")!;
    onHook = () => void s.agents.setAgentMode(s.root, "agent-1", "ask");
    await say(s, s.child, hookThen("set_agent_mode", { to: "agent-2", mode: "code" }));
    expect(lastResult(s.child, SET_AGENT_MODE)).toMatchObject({ isError: true });
    expect(lastResult(s.child, SET_AGENT_MODE).content).toMatch(/^set_agent_mode refused: you are in ask mode/);
    expect(s.child.mode).toBe("ask");
    expect(grand.mode).toBe("ask");
    await say(s, s.child, "msg: agent-2 | write: loose.txt | no");
    expect(fs.existsSync(path.join(workspace, "loose.txt"))).toBe(false);
  });

  it("a child spawned in the same batch as a held tightening starts under it", async () => {
    seed();
    const s = await tree("spawn: say hi");
    onHook = () => void s.agents.setAgentMode(s.root, "agent-1", "ask");
    await say(s, s.child, hookThen("spawn_agent", { task: "write: spawned.txt | x" }));
    expect(s.child.mode).toBe("ask");
    expect(named(s, "agent-2")!.mode).toBe("ask");
    expect(fs.existsSync(path.join(workspace, "spawned.txt"))).toBe(false);
  });

  it("when a held mode lands, everything below is capped to it", async () => {
    seed();
    const s = await tree("spawn: say hi");
    await say(s, s.child, "spawn: say hi");
    const grand = named(s, "agent-2")!;
    expect(grand.mode).toBe("code");
    // Held on agent-1 for its batch; a loosening of agent-2 sneaks in by hand
    // in between (the coordinator's own check is against `modeAhead`, so only
    // the landing cap can catch a change made around it).
    onHook = () => {
      s.agents.setAgentMode(s.root, "agent-1", "plan");
      grand.setModeApproval("code");
    };
    await say(s, s.child, "batch:");
    expect(s.child.mode).toBe("plan");
    expect(grand.mode).toBe("plan");
  });

  it("re-setting the mode a child already has still caps what is below it", async () => {
    seed();
    const s = await tree("spawn: say hi");
    await say(s, s.child, "spawn: say hi");
    const grand = named(s, "agent-2")!;
    s.child.setModeApproval("ask"); // the person, in agent-1's pane — not passed on
    expect(grand.mode).toBe("code");
    await say(s, s.root, "mode@agent-1#ask:");
    expect(lastResult(s.root, SET_AGENT_MODE).content).toBe('"agent-1" is already in ask mode. Also capped (below it): "agent-2".');
    expect(grand.mode).toBe("ask");
  });
});

describe("the note never keeps a yielding turn going (round 1)", () => {
  it("a spawn batch with a held note yields, and the note waits for the next turn", async () => {
    seed();
    const s = await tree("spawn: say hi");
    onHook = () => void s.agents.setAgentMode(s.root, "agent-1", "plan");
    const before = requests.length;
    // agent-2 pauses on a question to the person, so no finishing notice can
    // reach agent-1's queue mid-batch and legitimately keep its turn going.
    await say(s, s.child, `hookthen: ${JSON.stringify({ name: "spawn_agent", args: { task: "ask@user: which?" } })}`);
    expect(named(s, "agent-2")!.status).toBe("awaiting-input");
    // Only the batch's own request: the spawn yielded, nothing went out after it.
    const own = requests.slice(before).map((r) => r.req).filter((r) => wireText(r).includes("hookthen"));
    expect(own).toHaveLength(1);
    expect(s.child.mode).toBe("plan");
    expect(modeNotes(s.child)).toHaveLength(0);
    await say(s, s.child, "say hi");
    const notes = modeNotes(s.child);
    expect(notes).toHaveLength(1);
    // At that turn's top, ahead of what opened it.
    const opener = s.child.conversation.entries.find((e) => e.type === "user" && e.parent === notes[0]!.id);
    expect(opener).toMatchObject({ type: "user", text: "say hi" });
  });
});

describe("the transcript cards (P9f2)", () => {
  const tool = (content: string, isError = false): EntryView => ({ id: "t", parent: null, type: "tool", name: "set_agent_mode", content, isError });

  it("the parent's call reads → set agent-1 to code", () => {
    const card = agentCard(tool('Set "agent-1" to code mode (was ask). It applies…'), JSON.stringify({ to: "agent-1", mode: "code" }));
    expect(card).toEqual({ kind: "mode", peer: "agent-1", head: "→ set", body: "was ask", detail: "to code" });
  });

  it("a refusal reads as one", () => {
    const card = agentCard(tool("set_agent_mode refused: you are in plan mode", true), JSON.stringify({ to: "agent-1", mode: "code" }));
    expect(card).toMatchObject({ kind: "refused", peer: "agent-1", head: "→ mode not set for" });
  });

  it("the child's note reads mode set by its parent, or capped", () => {
    const user = (text: string): EntryView => ({ id: "u", parent: null, type: "user", text, inbound: { id: "m", from: "root", kind: "mode" } });
    expect(agentCard(user('[Your parent agent "root" set your mode to code — you may edit files and run commands.]'))).toEqual({
      kind: "mode",
      peer: "root",
      head: "mode set by",
      body: "",
      detail: "to code",
    });
    expect(agentCard(user("[Your mode was capped at ask — read-only: …]"))).toMatchObject({ head: "mode capped by", detail: "to ask" });
  });
});
