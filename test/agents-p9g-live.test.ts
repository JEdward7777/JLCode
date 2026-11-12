/**
 * P9g — live validation of sub-agents against real models (X-56, D-88/D-93/D-97).
 *
 * P9c's Tier-1 test (`agents-live.test.ts`) asks the first question: does a
 * model, reading only the tool descriptions, spawn, end its turn and message by
 * name? These ask the rest of what the design leans on a model to do:
 *
 *   (a) spawn on a **same-key sibling config** — a second, cheaper model found
 *       through `list_models`;
 *   (b) a **mid-task correction** — the parent messages a child that is busy,
 *       and the change reaches it before its next step;
 *   (c) a child's **question routed to its parent** (`ask`, to the parent), and
 *       the parent's `send_message` is its answer;
 *   (d) a **cross-model switch** mid-thread, and back by forking above it — each
 *       request goes to the model of the branch it was built from;
 *   (e) a child spawned in **ask**, refused a write, **loosened** by its parent
 *       with `set_agent_mode`, then does the write (P9f2, X-58).
 *
 * The assertions are weak properties (TESTING.md) — which calls happened, where
 * a keyword arrived, which model a request went to — never wording.
 *
 * ## Recorded through the request-keyed cache (D-24)
 *
 * Recorded once with `JLCODE_LIVE=1 npx vitest run test/agents-p9g-live.test.ts`
 * (paid — Joshua approved P9g 2026-11-12); every run since replays free.
 * Every scenario always runs: there is no "is it recorded?" gate, because a
 * gate hides a stale fixture — an edited tool description or system prompt
 * would turn the suite into a quiet skip. A request the cache does not hold
 * fails loudly instead (`noMiss` below, with a "stale fixture — re-record
 * (paid)" message), the cue to re-record with the command above and a key.
 *
 * The same two rules as P9c keep a replay replayable: no clock on the wire
 * (`turnTimestamps: false`), and one agent of a tree running at a time
 * (`agentConcurrency: 1`), so a message only reaches an agent between turns —
 * except where (b) arranges, deterministically, for one to land mid-turn.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Session, type SessionRetarget } from "../src/session/session";
import { AgentCoordinator } from "../src/session/agents";
import { ToolRegistry } from "../src/tools/registry";
import { agentTools } from "../src/tools/agent-tools";
import { askTool } from "../src/tools/ask-user";
import { fileTools } from "../src/tools/file-tools";
import { ModeApprovalGate } from "../src/tools/mode-gate";
import { Sandbox } from "../src/tools/sandbox";
import type { ChatRequest, LlmDriver } from "../src/llm/types";
import type { Mode, ModelConfig } from "../src/config/types";
import type { Conversation, Entry } from "../src/conversation/types";
import type { Tool } from "../src/tools/types";
import { liveDriver } from "./helpers/live";

const MINI = process.env.JLCODE_AGENTS_MODEL ?? "openai/gpt-4o-mini";
/** The same-key sibling: cheaper than gpt-4o-mini on OpenRouter's list
 *  ($0.10/$0.40 per M against $0.15/$0.60, checked 2026-11-12). */
const NANO = process.env.JLCODE_AGENTS_SIBLING_MODEL ?? "openai/gpt-4.1-nano";
const SYS = "You are JLCode, a concise coding agent. Keep replies short.";
/** The tree's spend cap (D-33) — a brake on a runaway recording, never reached. */
const CAP_USD = 2;

function config(id: string, name: string, model: string, mode: Mode = "code"): ModelConfig {
  return {
    id,
    name,
    // One key for both: that is what makes the second a *sibling* (X-56 Q9).
    openRouterKey: "unused-through-caching",
    model,
    sampling: { maxTokens: 400 },
    defaultMode: mode,
    defaultApproval: "full-auto",
    compaction: { auto: false, contextLength: 128_000 },
    commands: { agentConcurrency: 1 },
    environment: { turnTimestamps: false },
    createdAt: "",
    updatedAt: "",
  };
}

const MAIN_CFG = config("cfg_p9g_main", "Main", MINI);
const NANO_CFG = config("cfg_p9g_nano", "Nano", NANO);

type Probe = { req: ChatRequest; model: string };

interface Built {
  root: Session;
  agents: AgentCoordinator;
  sessions: Session[];
  /** Every request the tree made, in order, with the model it went to. */
  requests: Probe[];
  /** Cache misses replay hit. A session turns a driver error into its own error
   *  state, so without this a stale fixture surfaces as a confusing assertion. */
  misses: string[];
}

/** Fail first, and plainly, when a request was not in the recording. */
function noMiss(b: Built): void {
  if (b.misses.length > 0) {
    throw new Error(
      `stale fixture: ${b.misses.length} request(s) not in the recording — something on the wire changed (a tool ` +
        `description, the system prompt…). Re-record with JLCODE_LIVE=1 npx vitest run test/agents-p9g-live.test.ts (paid).`,
    );
  }
}

/**
 * A tree on `configs` (the first is the root's). `tools` adds to the agent
 * tools and `ask`; `workspace` is the sandbox's one root.
 */
function tree(
  inner: () => LlmDriver,
  opts: { configs?: ModelConfig[]; tools?: Tool[]; workspace?: string } = {},
): Built {
  const configs = opts.configs ?? [MAIN_CFG];
  const sandbox = new Sandbox([opts.workspace ?? os.tmpdir()]);
  const requests: Probe[] = [];
  const misses: string[] = [];
  const driver = (): LlmDriver => {
    const d = inner();
    return {
      async *streamChat(req, o) {
        requests.push({ req, model: req.model });
        try {
          yield* d.streamChat(req, o);
        } catch (err) {
          if (err instanceof Error && err.message.includes("live-cache MISS")) misses.push(err.message);
          throw err;
        }
      },
    };
  };
  const lookup = (id: string) => configs.find((c) => c.id === id);
  const session = (cfg: ModelConfig, conversation?: Conversation): Session => {
    const retarget = (c: ModelConfig): SessionRetarget => ({
      config: c,
      driver: driver(),
      watchdogMs: 0,
      maxToolIterations: 50,
      acceptsImages: false,
    });
    return new Session({
      config: cfg,
      driver: driver(),
      systemPrompt: SYS,
      tools: new ToolRegistry([...(opts.tools ?? []), askTool(), ...agentTools()]),
      sandbox,
      mode: cfg.defaultMode,
      approval: cfg.defaultApproval,
      buildGate: (m, a) => new ModeApprovalGate(m, a),
      spendCapUsd: CAP_USD,
      conversation,
      lookupConfig: lookup,
      deriveRetarget: retarget,
      bindingConfig: () => configs[0],
    });
  };
  const sessions: Session[] = [];
  const agents = new AgentCoordinator({
    listConfigs: () => configs,
    startAgent: ({ config: c, conversation }) => {
      const s = session(c, conversation);
      sessions.push(s);
      return s;
    },
    agentRecords: () => [],
    loadConversation: () => undefined,
  });
  const root = session(configs[0]!);
  agents.adoptRoot(root);
  return { root, agents, sessions, requests, misses };
}

type Args = { task?: string; to?: string; text?: string; model?: string; mode?: string; path?: string; content?: string; question?: string };
const calls = (s: Session, name: string): Args[] =>
  s.conversation.entries.flatMap((e) =>
    e.type === "assistant"
      ? (e.toolCalls ?? []).filter((c) => c.function.name === name).map((c) => JSON.parse(c.function.arguments || "{}") as Args)
      : [],
  );
const results = (s: Session, name: string) =>
  s.conversation.entries.filter((e): e is Extract<Entry, { type: "tool" }> => e.type === "tool" && e.name === name);
const inbound = (s: Session) =>
  s.conversation.entries.filter((e): e is Extract<Entry, { type: "user" }> => e.type === "user" && e.inbound !== undefined);
/** `word` as a whole word, any case — "RED" must not match "stored" or "required". */
const has = (text: string | undefined, word: string) => new RegExp(`\\b${word}\\b`, "i").test(text ?? "");
const child1 = (b: Built) => {
  const c = b.sessions.find((s) => s.agentInfo?.name === "agent-1");
  if (!c) throw new Error("the model never spawned a sub-agent");
  return c;
};
/** A request is the child's when its task header names it. */
const isChilds = (p: Probe, name: string) =>
  p.req.messages.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes(`You are sub-agent "${name}"`));

/** Dump each agent's log for a person reading what the model did (`P9G_DUMP=dir`). */
function dump(label: string, b: Built): void {
  const dir = process.env.P9G_DUMP;
  if (!dir) return;
  const all = [b.root, ...b.sessions].map((s) => ({ name: s.agentInfo?.name ?? "root", entries: s.conversation.entries }));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${label}.json`), JSON.stringify({ requests: b.requests.map((r) => r.model), all }, null, 1));
}

// ---- (a) a same-key sibling config

const A_FIRST =
  `Call list_models, then start one sub-agent with spawn_agent on the model config that is NOT your own. ` +
  `Its task: send its parent the word READY with send_message.`;
const buildA = (d: () => LlmDriver) => tree(d, { configs: [MAIN_CFG, NANO_CFG] });

// ---- (b) a mid-task correction

const B_FIRST =
  `Start one sub-agent with spawn_agent. Its task, word for word: "First call the checkpoint tool, and wait for ` +
  `its result. Then send your parent, with send_message, the color you were told to use. The color is RED."`;
const B_CORRECTION = `Change of plan: tell your sub-agent to use the color BLUE instead of RED.`;
/** A read-only tool the child calls mid-turn. The first call hands the parent a
 *  person's correction and waits for that turn to finish, so the parent's
 *  message lands while the child is busy — at the same point on every run. */
function checkpoint(fire: () => Promise<void>): Tool {
  let fired = false;
  return {
    name: "checkpoint",
    kind: "read",
    mutates: false,
    def: {
      type: "function",
      function: { name: "checkpoint", description: "Record a progress checkpoint.", parameters: { type: "object", properties: {} } },
    },
    async execute() {
      if (!fired) {
        fired = true;
        await fire();
      }
      return { content: "checkpoint recorded" };
    },
  };
}
function buildB(d: () => LlmDriver): Built {
  let built: Built | undefined;
  built = tree(d, { tools: [checkpoint(() => built!.root.send(B_CORRECTION))] });
  return built;
}

// ---- (c) a question routed to the parent

const C_FIRST =
  `The project's color is GREEN. Start one sub-agent with spawn_agent, and do not tell it the color. Its task: ` +
  `ask its parent which color the project uses, using the ask tool, then send that color to its parent with send_message.`;
const buildC = (d: () => LlmDriver) => tree(d);

// ---- (d) a cross-model switch, and back via fork

const D_FIRST = `Reply with the single word ONE.`;
const D_SECOND = `Reply with the single word TWO.`;
const D_THIRD = `Reply with the single word THREE.`;
const buildD = (d: () => LlmDriver) => tree(d, { configs: [MAIN_CFG, NANO_CFG] });

// ---- (e) a child loosened by its parent

const E_FIRST =
  `Start one sub-agent with spawn_agent in "ask" mode. Its task: write the word DONE into the file note.txt with ` +
  `write_file; if it cannot, tell its parent why with send_message. Do not write the file yourself. If the ` +
  `sub-agent reports a problem, give it what it needs to finish.`;
const fileSubset = () => fileTools().filter((t) => t.name === "read_file" || t.name === "write_file");
const buildE = (d: () => LlmDriver, workspace?: string) => tree(d, { tools: fileSubset(), workspace });

describe("live models drive the agent tree (Tier 1, P9g)", () => {
  it("(a) spawns on a same-key sibling config, found with list_models", { timeout: 300_000 }, async () => {
    const b = buildA(liveDriver);
    await b.root.send(A_FIRST);
    await b.agents.idle();
    dump("a", b);
    noMiss(b);
    const child = child1(b);

    expect(calls(b.root, "list_models").length).toBeGreaterThan(0);
    // It named the sibling, and the child runs on it.
    expect(calls(b.root, "spawn_agent").some((a) => a.model?.toLowerCase() === "nano")).toBe(true);
    expect(child.config.model).toBe(NANO);
    // Every request the child made went to the sibling's model; none of the root's did.
    const childs = b.requests.filter((p) => isChilds(p, "agent-1"));
    expect(childs.length).toBeGreaterThan(0);
    expect(childs.every((p) => p.model === NANO)).toBe(true);
    expect(b.requests.filter((p) => !isChilds(p, "agent-1")).every((p) => p.model === MINI)).toBe(true);
    // …and the sibling model used send_message to report.
    expect(calls(child, "send_message").some((a) => a.to === "parent" && has(a.text, "READY"))).toBe(true);
    expect(inbound(b.root).some((e) => e.inbound!.from === "agent-1" && e.inbound!.kind === "message")).toBe(true);
  });

  it("(b) a correction sent to a busy child lands before its next step", { timeout: 300_000 }, async () => {
    const b = buildB(liveDriver);
    await b.root.send(B_FIRST);
    await b.agents.idle();
    dump("b", b);
    noMiss(b);
    const child = child1(b);

    expect(results(child, "checkpoint").length).toBeGreaterThan(0);
    // The person's correction reached the parent mid-way through the child's
    // turn, and the parent passed it on by name.
    expect(calls(b.root, "send_message").some((a) => a.to === "agent-1" && has(a.text, "BLUE"))).toBe(true);
    // In the child's own log the correction sits after the checkpoint's result
    // and before the report — it landed between two steps of the busy turn.
    const log = child.conversation.entries;
    const at = (pred: (e: Entry) => boolean) => log.findIndex(pred);
    const cp = at((e) => e.type === "tool" && e.name === "checkpoint");
    const corr = at((e) => e.type === "user" && e.inbound?.kind === "message" && has(e.text, "BLUE"));
    expect(cp).toBeGreaterThanOrEqual(0);
    expect(corr).toBeGreaterThan(cp);
    // Nothing the model said sits between them: no model call ran in between.
    expect(log.slice(cp + 1, corr).some((e) => e.type === "assistant")).toBe(false);
    // The child's very next request after the checkpoint already carried it.
    const afterCp = b.requests.filter(
      (p) => isChilds(p, "agent-1") && p.req.messages.some((m) => m.role === "tool" && m.content === "checkpoint recorded"),
    );
    expect(afterCp.length).toBeGreaterThan(0);
    expect(afterCp[0]!.req.messages.some((m) => m.role === "user" && typeof m.content === "string" && has(m.content, "BLUE"))).toBe(true);
    const reports = calls(child, "send_message").filter((a) => a.to === "parent" || a.to === "root");
    expect(reports.length).toBeGreaterThan(0);
    // It never reported the superseded color, and its last word is the new one.
    expect(reports.some((a) => has(a.text, "RED"))).toBe(false);
    expect(has(reports[reports.length - 1]!.text, "BLUE")).toBe(true);
  });

  it("(c) a child's question goes to its parent, and send_message answers it", { timeout: 300_000 }, async () => {
    const b = buildC(liveDriver);
    await b.root.send(C_FIRST);
    await b.agents.idle();
    dump("c", b);
    noMiss(b);
    const child = child1(b);

    // The parent kept the answer out of the task, so the child had to ask.
    const spawned = calls(b.root, "spawn_agent");
    expect(spawned.length).toBeGreaterThan(0);
    expect(spawned.some((a) => has(a.task, "GREEN"))).toBe(false);
    // The child asked, and the question reached the parent as a question.
    expect(calls(child, "ask").length).toBeGreaterThan(0);
    expect(inbound(b.root).some((e) => e.inbound!.from === "agent-1" && e.inbound!.kind === "question")).toBe(true);
    // The parent's send_message was taken as the answer to it.
    expect(results(b.root, "send_message").some((r) => r.content.includes("as the answer to its question"))).toBe(true);
    expect(results(child, "ask").some((r) => r.content.startsWith(`[Answer from your parent agent "root"]`) && has(r.content, "GREEN"))).toBe(true);
    // …and the child carried on and reported the answer.
    expect(calls(child, "send_message").some((a) => (a.to === "parent" || a.to === "root") && has(a.text, "GREEN"))).toBe(true);
    expect(child.status).toBe("idle");
  });

  it("(d) a mid-thread model switch, and back by forking above it", { timeout: 300_000 }, async () => {
    const b = buildD(liveDriver);
    const { root } = b;
    await root.send(D_FIRST);
    noMiss(b);
    expect(b.requests.at(-1)!.model).toBe(MINI);

    await root.switchModel(NANO_CFG.id);
    const sw = root.conversation.entries.find((e) => e.type === "model-switch");
    if (!sw) throw new Error("no model-switch entry");
    await root.send(D_SECOND);
    noMiss(b);
    expect(b.requests.at(-1)!.model).toBe(NANO);
    // A switch keeps the thread: the new model is sent the exchange before it.
    expect(JSON.stringify(b.requests.at(-1)!.req.messages)).toContain("ONE");

    // Fork above the switch: the branch has no switch on it, so it is the
    // binding's model again — and the switched exchange is not on its wire.
    root.setActiveLeaf(sw.parent);
    root.resyncModel();
    await root.send(D_THIRD);
    dump("d", b);
    noMiss(b);
    const last = b.requests.at(-1)!;
    expect(last.model).toBe(MINI);
    expect(JSON.stringify(last.req.messages)).not.toContain("TWO");
    expect(b.requests.map((r) => r.model)).toEqual([MINI, NANO, MINI]);
    // Each branch answered (wording is not asserted — only that it replied).
    const replies = root.conversation.entries.filter((e) => e.type === "assistant");
    expect(replies.length).toBe(3);
  });

  it("(e) a child spawned in ask is loosened with set_agent_mode and then writes", { timeout: 300_000 }, async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-p9g-e-"));
    try {
      const b = buildE(liveDriver, ws);
      await b.root.send(E_FIRST);
      await b.agents.idle();
      dump("e", b);
      noMiss(b);
      const child = child1(b);

      // agent-1's own spawn — the result naming it — was the one in ask.
      const rootLog = b.root.conversation.entries;
      const spawnResult = rootLog.find(
        (e): e is Extract<Entry, { type: "tool" }> => e.type === "tool" && e.name === "spawn_agent" && e.content.includes(`"agent-1"`),
      );
      if (!spawnResult) throw new Error("no spawn_agent result names agent-1");
      const spawnCall = rootLog
        .flatMap((e) => (e.type === "assistant" ? (e.toolCalls ?? []) : []))
        .find((c) => c.id === spawnResult.toolCallId);
      expect((JSON.parse(spawnCall!.function.arguments) as Args).mode).toBe("ask");
      expect(spawnResult.content).toContain("in ask mode");

      // In order: Ask refused the write, the parent loosened the child by name
      // to a mode that writes, the child was told, and then the write went through.
      const childLog = child.conversation.entries;
      const refused = childLog.findIndex((e) => e.type === "tool" && e.name === "write_file" && e.isError && e.content.includes("Ask mode"));
      const note = childLog.findIndex((e) => e.type === "user" && e.inbound?.kind === "mode" && e.inbound.from === "root");
      const wrote = childLog.findIndex((e) => e.type === "tool" && e.name === "write_file" && !e.isError);
      expect(refused).toBeGreaterThanOrEqual(0);
      expect(note).toBeGreaterThan(refused);
      expect(wrote).toBeGreaterThan(note);
      const setAt = rootLog.findIndex(
        (e) =>
          e.type === "assistant" &&
          (e.toolCalls ?? []).some((c) => {
            if (c.function.name !== "set_agent_mode") return false;
            const a = JSON.parse(c.function.arguments) as Args;
            return a.to === "agent-1" && a.mode === "code";
          }),
      );
      expect(setAt).toBeGreaterThanOrEqual(0);
      // The refusal reached the parent before it loosened the child.
      const told = rootLog.findIndex((e) => e.type === "user" && e.inbound?.from === "agent-1" && e.inbound.kind === "message");
      expect(told).toBeGreaterThanOrEqual(0);
      expect(setAt).toBeGreaterThan(told);
      // The root never wrote it itself.
      expect(calls(b.root, "write_file").length).toBe(0);
      expect(fs.readFileSync(path.join(ws, "note.txt"), "utf8")).toContain("DONE");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
