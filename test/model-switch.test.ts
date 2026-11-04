/**
 * P9a — per-thread model switching, headless (X-56, D-87).
 *
 * A thread's model is an entry in its own log: the nearest `model-switch` above
 * the leaf governs, resolved by config **id** against the live store on every
 * request. These tests hold the settled design's edges in place:
 *
 *   - fold/fork reverts: the entry governs below itself only;
 *   - once switched, the folder binding never moves the branch — and a fork
 *     above the first switch follows the binding again;
 *   - a deleted config refuses to send (typed, for the picker), never substitutes;
 *   - the switch drops the old model's signed reasoning and releases the pin;
 *   - a cross-key switch needs an explicit acknowledgement, every time;
 *   - picked while busy → pending, written at the next idle point;
 *   - the configs listing carries fingerprints, never key bytes.
 *
 * Tier 0: fake drivers record every request, so "the thread runs on Sonnet" is
 * asserted on the wire rather than on a label.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createServer } from "../src/server/server";
import { createSessionFactory, createSessionRetarget } from "../src/server/session-factory";
import { ConversationStore } from "../src/persist/conversation-store";
import { ModelCatalog } from "../src/llm/models";
import { loadConfig, saveConfig, defaultConfig } from "../src/config/store";
import { addModelConfig, groupConfigsByKey, keyFingerprint, resolveForCwd, setBinding } from "../src/config/operations";
import { resolvePaths, type JlcodePaths } from "../src/paths";
import { newConversation, appendEntry, governingSwitch } from "../src/conversation/tree";
import { buildWireMessages, pinnedProvider } from "../src/conversation/wire";
import { Session } from "../src/session/session";
import type { ChatRequest, LlmDriver, StreamEvent } from "../src/llm/types";
import type { ModelConfig } from "../src/config/types";

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

// ---- Pure: the fold, the wire, the pin.

describe("the fold: the nearest switch above the leaf governs", () => {
  function tree() {
    let conv = newConversation();
    const push = (input: Parameters<typeof appendEntry>[1], parent?: string | null) => {
      const r = appendEntry(conv, input, parent);
      conv = r.conv;
      return r.entry;
    };
    const u1 = push({ type: "user", text: "one" });
    const a1 = push({
      type: "assistant",
      text: "hi",
      reasoning: [{ type: "reasoning.text", text: "opus thinks", signature: "sig-opus", index: 0 }],
      provider: "Anthropic",
    });
    const sw1 = push({ type: "model-switch", configId: "cfg-b", snapshot: { name: "b", model: SONNET } });
    const u2 = push({ type: "user", text: "two" });
    const a2 = push({ type: "assistant", text: "yo", provider: "Google" });
    const sw2 = push({ type: "model-switch", configId: "cfg-c", snapshot: { name: "c", model: HAIKU } });
    return { conv: () => conv, push, u1, a1, sw1, u2, a2, sw2 };
  }

  it("picks the nearest switch, and a fork above the first one has none", () => {
    const t = tree();
    expect(governingSwitch(t.conv())?.configId).toBe("cfg-c");
    expect(governingSwitch(t.conv(), t.a2.id)?.configId).toBe("cfg-b");
    expect(governingSwitch(t.conv(), t.a1.id)).toBeUndefined();
    // Fork off u1's answer — a sibling branch with no switch on it.
    const fork = t.push({ type: "user", text: "other" }, t.a1.id);
    expect(governingSwitch(t.conv(), fork.id)).toBeUndefined();
  });

  it("drops reasoning above the newest switch and releases the pin, like a compaction", () => {
    const t = tree();
    // Above the first switch: the reasoning replays and the pin holds.
    const before = buildWireMessages(t.conv(), { leafId: t.a1.id, stamps: false });
    expect(before.find((m) => m.role === "assistant")?.reasoning_details).toBeDefined();
    expect(pinnedProvider(t.conv(), t.a1.id)).toBe("Anthropic");

    // Below it: text kept, signed reasoning gone, pin re-derived after the switch.
    const after = buildWireMessages(t.conv(), { leafId: t.a2.id, stamps: false });
    const assistants = after.filter((m) => m.role === "assistant");
    expect(assistants.map((m) => m.content)).toEqual(["hi", "yo"]);
    expect(assistants.every((m) => m.reasoning_details === undefined)).toBe(true);
    expect(pinnedProvider(t.conv(), t.a2.id)).toBe("Google");
    // The switch itself carries no message.
    expect(after.filter((m) => m.role === "user")).toHaveLength(2);

    // At the leaf (under the second switch) nothing is pinned yet.
    expect(pinnedProvider(t.conv())).toBeUndefined();
  });
});

describe("the configs listing", () => {
  it("groups by key with last-4 fingerprints, current key first", () => {
    const configs = [
      { id: "1", name: "a1", model: OPUS, openRouterKey: KEY_A },
      { id: "2", name: "b1", model: SONNET, openRouterKey: KEY_B },
      { id: "3", name: "a2", model: HAIKU, openRouterKey: KEY_A },
    ] as ModelConfig[];
    const groups = groupConfigsByKey(configs, KEY_B);
    expect(groups.map((g) => g.fingerprint)).toEqual(["bbbb", "aaaa"]);
    expect(groups[0]!.current).toBe(true);
    expect(groups[1]!.configs.map((c) => c.name)).toEqual(["a1", "a2"]);
    expect(JSON.stringify(groups)).not.toContain("client-a");
    // A short key gives nothing away; no key is no fingerprint.
    expect(keyFingerprint("sk-short")).toBe("****");
    expect(keyFingerprint("")).toBe("");
  });
});

// ---- Through the server, as `serve` wires it.

let dir: string;
let paths: JlcodePaths;
let workspace: string;
let store: ConversationStore;
let catalog: ModelCatalog;
/** Every turn request that reached a driver, in order — the ground truth. */
let calls: ChatRequest[];
const saved = { config: process.env.JLCODE_CONFIG_DIR, data: process.env.JLCODE_DATA_DIR };

function isTitleAsk(req: ChatRequest): boolean {
  const last = req.messages[req.messages.length - 1];
  return typeof last?.content === "string" && last.content.includes("Name this conversation");
}

/** Answers in one turn; on Opus it leaves signed reasoning and a backend, the
 *  two things a switch must not hand the next model. */
function plainDriver(config: ModelConfig): LlmDriver {
  return {
    async *streamChat(req): AsyncGenerator<StreamEvent> {
      expect(req.model).toBe(config.model); // the driver is built per config
      if (isTitleAsk(req)) {
        yield { type: "text", delta: "A thread" };
        yield { type: "finish", reason: "stop" };
        return;
      }
      calls.push(req);
      if (config.model === OPUS) {
        yield { type: "provider", name: "Anthropic" };
        yield { type: "reasoning_details", value: [{ type: "reasoning.text", text: "t", signature: "sig", index: 0 }] };
      }
      yield { type: "text", delta: "ok" };
      yield { type: "finish", reason: "stop" };
    },
  };
}

/** First turn calls `ask_user` — the session is busy (paused) until answered. */
function askDriver(config: ModelConfig): LlmDriver {
  return {
    async *streamChat(req): AsyncGenerator<StreamEvent> {
      if (isTitleAsk(req)) {
        yield { type: "text", delta: "A thread" };
        yield { type: "finish", reason: "stop" };
        return;
      }
      calls.push(req);
      const answered = req.messages.some((m) => m.role === "tool");
      if (!answered) {
        yield {
          type: "tool_call",
          index: 0,
          id: "c1",
          name: "ask_user",
          argsDelta: JSON.stringify({ questions: [{ header: "Env", question: "Which env?" }] }),
        };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text", delta: `done on ${config.model}` };
        yield { type: "finish", reason: "stop" };
      }
    },
  };
}

/** Three configs: opus (bound) and sonnet under key A, haiku under key B. */
function seed(): { opus: ModelConfig; sonnet: ModelConfig; haiku: ModelConfig } {
  const base = { defaultMode: "code" as const, defaultApproval: "manual" as const, compaction: { auto: true } };
  let cfg = defaultConfig();
  const a = addModelConfig(cfg, { ...base, name: "opus", model: OPUS, openRouterKey: KEY_A });
  const b = addModelConfig(a.config, { ...base, name: "sonnet", model: SONNET, openRouterKey: KEY_A });
  const c = addModelConfig(b.config, { ...base, name: "haiku", model: HAIKU, openRouterKey: KEY_B });
  cfg = setBinding(c.config, workspace, a.added.id);
  saveConfig(cfg, paths);
  return { opus: a.added, sonnet: b.added, haiku: c.added };
}

/** Rewrite one config in the live store, the way a CLI edit would. */
function editConfig(id: string, patch: Partial<ModelConfig>): void {
  const cfg = loadConfig(paths);
  saveConfig(
    {
      ...cfg,
      modelConfigs: cfg.modelConfigs.map((m) =>
        m.id === id ? { ...m, ...patch, updatedAt: new Date(Date.now() + 1000).toISOString() } : m,
      ),
    },
    paths,
  );
}

function makeApp(
  makeDriver: (config: ModelConfig) => LlmDriver,
  opts: { onRetarget?: (c: ModelConfig) => void; onPersist?: (name: string, patch: unknown) => void } = {},
) {
  const deps = { paths, cwd: workspace, makeDriver, mcpTools: () => [], catalog };
  const retarget = createSessionRetarget(deps);
  return createServer({
    resolveConfig: () => resolveForCwd(loadConfig(paths), workspace),
    newSession: createSessionFactory(deps),
    retargetSession: (session, config) => {
      opts.onRetarget?.(config);
      return retarget(session, config);
    },
    listConfigs: () => loadConfig(paths).modelConfigs,
    persistDefaults: opts.onPersist,
    store,
    workingDir: workspace,
    version: "0.0.0",
  }).app;
}

type App = ReturnType<typeof makeApp>;

async function post(app: App, url: string, body: unknown) {
  const res = await app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

async function get(app: App, url: string) {
  const res = await app.request(url);
  return { status: res.status, text: await res.text() };
}

let seeded: ReturnType<typeof seed>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-p9a-"));
  process.env.JLCODE_CONFIG_DIR = path.join(dir, "config");
  process.env.JLCODE_DATA_DIR = path.join(dir, "data");
  paths = resolvePaths();
  fs.mkdirSync(path.dirname(paths.modelsCacheFile), { recursive: true });
  fs.writeFileSync(paths.modelsCacheFile, JSON.stringify(CATALOG), "utf8");
  workspace = path.join(dir, "work");
  fs.mkdirSync(workspace, { recursive: true });
  store = new ConversationStore(path.join(dir, "conversations"));
  catalog = new ModelCatalog({ file: paths.modelsCacheFile });
  calls = [];
  seeded = seed();
});

afterEach(async () => {
  await store.close();
  process.env.JLCODE_CONFIG_DIR = saved.config;
  process.env.JLCODE_DATA_DIR = saved.data;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("switching a thread's model through the server", () => {
  it("writes a switch entry, runs the next turn on it, and drops the old reasoning and pin", async () => {
    const app = makeApp(plainDriver);
    const first = await post(app, "/chat", { text: "one" });
    const sessionId = first.json.sessionId as string;
    expect(calls[0]!.model).toBe(OPUS);

    const sw = await post(app, `/session/${sessionId}/model`, { configId: seeded.sonnet.id });
    expect(sw.status).toBe(200);
    expect(sw.json.switch).toBe("applied");
    expect(sw.json.model).toBe(SONNET);
    expect(sw.json.contextWindow).toBe(200_000); // derived parts came with it (H-06)

    const second = await post(app, "/chat", { text: "two", sessionId });
    expect(second.status).toBe(200);
    const req = calls[1]!;
    expect(req.model).toBe(SONNET);
    expect(req.messages.some((m) => m.reasoning_details !== undefined)).toBe(false);
    expect(req.provider).toBeUndefined(); // the Anthropic pin was released

    // The entry is on the transcript with its snapshot, for the marker (P9b).
    const conv = await get(app, `/session/${sessionId}`);
    expect(conv.text).toContain('"type":"model-switch"');
    expect(conv.text).toContain('"model":"anthropic/claude-sonnet-5"');
  });

  it("a switched config's own routing governs (D-86), and its edits reach the thread live", async () => {
    const FLEX = { only: ["anthropic/flex"], allow_fallbacks: false };
    editConfig(seeded.sonnet.id, { provider: FLEX } as Partial<ModelConfig>);
    const app = makeApp(plainDriver);
    const first = await post(app, "/chat", { text: "one" });
    const sessionId = first.json.sessionId as string;
    await post(app, `/session/${sessionId}/model`, { configId: seeded.sonnet.id });
    await post(app, "/chat", { text: "two", sessionId });
    expect(calls[1]!.provider).toEqual(FLEX);
    expect(calls[1]!.reasoning).toBeUndefined();

    // Edit the switched-to config from "the CLI" — no rebind, no restart.
    editConfig(seeded.sonnet.id, { reasoningEffort: "high" });
    await post(app, "/chat", { text: "three", sessionId });
    expect(calls[2]!.model).toBe(SONNET);
    expect(calls[2]!.reasoning).toEqual({ effort: "high" });
  });

  it("ignores the binding once switched, and follows it again on a fork above the first switch", async () => {
    const retargets: string[] = [];
    const app = makeApp(plainDriver, { onRetarget: (c) => retargets.push(c.model) });
    const first = await post(app, "/chat", { text: "one" });
    const sessionId = first.json.sessionId as string;
    await post(app, `/session/${sessionId}/model`, { configId: seeded.sonnet.id });

    // The folder is rebound to haiku from another terminal.
    saveConfig(setBinding(loadConfig(paths), workspace, seeded.haiku.id), paths);

    await post(app, "/chat", { text: "two", sessionId });
    expect(calls[1]!.model).toBe(SONNET); // the thread's own choice holds
    // …and the binding was never even offered to it (`adoptLatestConfig` skips).
    expect(retargets).not.toContain(HAIKU);

    // Edit the first message: a fork above the switch, which has no switch on
    // it — so the binding governs again.
    const state = (await post(app, "/chat", { text: "three", sessionId })).json;
    expect(state.model).toBe(SONNET);
    const tree = JSON.parse((await get(app, `/session/${sessionId}`)).text) as { entries: { id: string; type: string; text?: string }[] };
    const firstUser = tree.entries.find((e) => e.type === "user" && e.text === "one")!;
    const edited = await post(app, `/session/${sessionId}/edit`, { entryId: firstUser.id, text: "one, again" });
    expect(edited.status).toBe(200);
    expect(calls.at(-1)!.model).toBe(HAIKU);
    expect(edited.json.model).toBe(HAIKU);
  });

  it("refuses to send when the switched-to config was deleted, and a new pick unblocks it", async () => {
    const app = makeApp(plainDriver);
    const first = await post(app, "/chat", { text: "one" });
    const sessionId = first.json.sessionId as string;
    await post(app, `/session/${sessionId}/model`, { configId: seeded.sonnet.id });

    const cfg = loadConfig(paths);
    saveConfig({ ...cfg, modelConfigs: cfg.modelConfigs.filter((m) => m.id !== seeded.sonnet.id) }, paths);

    const before = calls.length;
    const refused = await post(app, "/chat", { text: "two", sessionId });
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe("model-config-missing");
    expect(refused.json.snapshot).toEqual({ name: "sonnet", model: SONNET });
    expect(calls.length).toBe(before); // nothing sent — and nothing substituted

    // The state says so before anyone types, and no orphan message was appended.
    const state = (await post(app, `/session/${sessionId}/queue`, { queue: [] })).json;
    expect(state.modelMissing.code).toBe("model-config-missing");
    const tree = (await get(app, `/session/${sessionId}`)).text;
    expect(tree).not.toContain('"text":"two"');

    // The gone config's key is unknown, so even a pick under the same key as
    // before asks for the confirm — never wrong after a rotation (round 2).
    const unconfirmed = await post(app, `/session/${sessionId}/model`, { configId: seeded.opus.id });
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.json).toMatchObject({ code: "cross-key", from: null, to: "aaaa" });
    // Picking a model writes an ordinary switch and the thread sends again.
    const pick = await post(app, `/session/${sessionId}/model`, { configId: seeded.opus.id, acknowledgeKeyChange: true });
    expect(pick.json.modelMissing).toBeNull();
    const ok = await post(app, "/chat", { text: "two", sessionId });
    expect(ok.status).toBe(200);
    expect(calls.at(-1)!.model).toBe(OPUS);
  });

  it("refuses a cross-key switch without the acknowledgement, every time", async () => {
    const app = makeApp(plainDriver);
    const first = await post(app, "/chat", { text: "one" });
    const sessionId = first.json.sessionId as string;

    const refused = await post(app, `/session/${sessionId}/model`, { configId: seeded.haiku.id });
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe("cross-key");
    expect(refused.json.from).toBe("aaaa");
    expect(refused.json.to).toBe("bbbb");
    expect(JSON.stringify(refused.json)).not.toContain("client-");

    const ok = await post(app, `/session/${sessionId}/model`, { configId: seeded.haiku.id, acknowledgeKeyChange: true });
    expect(ok.status).toBe(200);
    expect(ok.json.model).toBe(HAIKU);

    // Back across the key: asked again — no "don't ask again".
    const again = await post(app, `/session/${sessionId}/model`, { configId: seeded.opus.id });
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("cross-key");
  });

  it("records a pick made while busy as pending, replaces it on a second pick, and writes it at idle", async () => {
    const app = makeApp(askDriver);
    const first = await post(app, "/chat", { text: "one" });
    const sessionId = first.json.sessionId as string;
    expect(first.json.status).toBe("awaiting-input");

    const p1 = await post(app, `/session/${sessionId}/model`, { configId: seeded.sonnet.id });
    expect(p1.json.switch).toBe("pending");
    expect(p1.json.pendingModelSwitch).toMatchObject({ configId: seeded.sonnet.id, model: SONNET });
    const p2 = await post(app, `/session/${sessionId}/model`, {
      configId: seeded.haiku.id,
      acknowledgeKeyChange: true,
    });
    expect(p2.json.pendingModelSwitch).toMatchObject({ configId: seeded.haiku.id });
    expect(p2.json.model).toBe(OPUS); // nothing applied mid-cycle

    const done = await post(app, `/session/${sessionId}/answer`, { text: "prod" });
    expect(done.json.status).toBe("idle");
    // The paused turn finished on the model it started on…
    expect(calls.map((r) => r.model)).toEqual([OPUS, OPUS]);
    // …and the pending pick landed at the idle point, the second one only.
    expect(done.json.pendingModelSwitch).toBeNull();
    expect(done.json.model).toBe(HAIKU);
    const tree = JSON.parse((await get(app, `/session/${sessionId}`)).text) as { entries: { type: string; configId?: string }[] };
    const switches = tree.entries.filter((e) => e.type === "model-switch");
    expect(switches.map((e) => e.configId)).toEqual([seeded.haiku.id]);
  });

  it("survives a restart: a resumed thread runs under its switch, not the binding", async () => {
    const app = makeApp(plainDriver);
    const first = await post(app, "/chat", { text: "one" });
    const sessionId = first.json.sessionId as string;
    const conversationId = first.json.conversationId as string;
    await post(app, `/session/${sessionId}/model`, { configId: seeded.sonnet.id });

    // A new server process over the same store — the switch is only in the log.
    const restarted = makeApp(plainDriver);
    const resumed = await post(restarted, "/chat", { text: "two", conversationId });
    expect(resumed.status).toBe(200);
    expect(resumed.json.model).toBe(SONNET);
    expect(calls.at(-1)!.model).toBe(SONNET);
  });

  it("lists configs grouped by key with no key bytes in the response", async () => {
    const app = makeApp(plainDriver);
    const first = await post(app, "/chat", { text: "one" });
    const sessionId = first.json.sessionId as string;
    const res = await get(app, `/configs?session=${sessionId}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(KEY_A);
    expect(res.text).not.toContain(KEY_B);
    expect(res.text).not.toContain("client-a");
    const body = JSON.parse(res.text) as { groups: { fingerprint: string; current: boolean; configs: { name: string }[] }[] };
    expect(body.groups[0]).toMatchObject({ fingerprint: "aaaa", current: true });
    expect(body.groups[0]!.configs.map((c) => c.name)).toEqual(["opus", "sonnet"]);
    expect(body.groups[1]!.configs.map((c) => c.name)).toEqual(["haiku"]);
  });
});

// ---- Review round 1: the branch a switch lands on, retry, the held queue, and
// the mid-turn edges.

/** Models that throw a non-transient error (a retryable failed turn, D-57). */
let failing: Set<string>;
/** `ask_user` rounds a turn takes before it answers (each needs an answer). */
let askRounds: number;
/** Run once inside the next answering (non-tool) call — "while the last LLM
 *  call of the turn is in flight", the only time a queued message outlives the
 *  turn instead of being flushed into it (D-52). */
let duringAnswer: (() => Promise<unknown>) | undefined;
/** Hold the settle-time title ask open: it signals `started` and waits on
 *  `release` (round 5 — the window in which status reads idle with a pin held). */
let titleHold: { started: () => void; release: Promise<void> } | undefined;
/** Hold a turn call whose user message contains `slow:` the same way. */
let slowHold: { started: () => void; release: Promise<void> } | undefined;

/** A gate a test opens by hand: `started` resolves once the driver reaches it. */
function gate() {
  let open!: () => void;
  let reached!: () => void;
  const release = new Promise<void>((r) => (open = r));
  const started = new Promise<void>((r) => (reached = r));
  return { hold: { started: reached, release }, open, started };
}

/**
 * One scripted driver for the edge cases. A user message containing `ask:`
 * opens a run of `ask_user` calls (`askRounds` of them); anything else is a
 * one-line answer — on Opus with signed reasoning and a backend, the two things
 * no other model may be handed.
 */
function scriptDriver(config: ModelConfig): LlmDriver {
  return {
    async *streamChat(req): AsyncGenerator<StreamEvent> {
      expect(req.model).toBe(config.model);
      if (isTitleAsk(req)) {
        const held = titleHold;
        if (held) {
          titleHold = undefined;
          held.started();
          await held.release;
        }
        yield { type: "text", delta: "A thread" };
        yield { type: "finish", reason: "stop" };
        return;
      }
      calls.push(req);
      if (failing.has(config.model)) throw new Error("boom");
      const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
      if (slowHold && typeof lastUser?.content === "string" && lastUser.content.includes("slow:")) {
        const held = slowHold;
        slowHold = undefined;
        held.started();
        await held.release;
      }
      const last = req.messages[req.messages.length - 1]!;
      const tools = req.messages.filter((m) => m.role === "tool").length;
      if (last.role === "user" && typeof last.content === "string" && last.content.includes("outside:")) {
        yield {
          type: "tool_call",
          index: 0,
          id: "o1",
          name: "read_file",
          argsDelta: JSON.stringify({ path: path.join(dir, "outside.txt") }),
        };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      if (last.role === "user" && typeof last.content === "string" && last.content.includes("run:")) {
        yield {
          type: "tool_call",
          index: 0,
          id: "r1",
          name: "run_command",
          // Long on purpose: a Stop that fails to kill it times the test out
          // instead of letting the turn quietly carry on.
          argsDelta: JSON.stringify({ command: "sleep 30" }),
        };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      const asking =
        (last.role === "user" && typeof last.content === "string" && last.content.includes("ask:")) ||
        (last.role === "tool" && tools < askRounds);
      if (asking) {
        yield {
          type: "tool_call",
          index: 0,
          id: `c${tools + 1}`,
          name: "ask_user",
          argsDelta: JSON.stringify({ questions: [{ header: "Q", question: `Question ${tools + 1}?` }] }),
        };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      if (duringAnswer) {
        const hook = duringAnswer;
        duringAnswer = undefined;
        await hook();
      }
      if (config.model === OPUS) {
        yield { type: "provider", name: "Anthropic" };
        yield { type: "reasoning_details", value: [{ type: "reasoning.text", text: "t", signature: "sig", index: 0 }] };
      }
      yield { type: "text", delta: "ok" };
      yield { type: "finish", reason: "stop" };
    },
  };
}

type TreeView = { entries: { id: string; parent: string | null; type: string; text?: string; configId?: string }[] };

async function treeOf(app: App, sessionId: string): Promise<TreeView> {
  return JSON.parse((await get(app, `/session/${sessionId}`)).text) as TreeView;
}

function deleteConfig(id: string): void {
  const cfg = loadConfig(paths);
  saveConfig({ ...cfg, modelConfigs: cfg.modelConfigs.filter((m) => m.id !== id) }, paths);
}

describe("review round 1", () => {
  beforeEach(() => {
    failing = new Set();
    askRounds = 1;
    duringAnswer = undefined;
  });

  it("measures a cross-key pick from the branch in view, not the last turn run — both directions", async () => {
    const app = makeApp(scriptDriver);
    const first = await post(app, "/chat", { text: "one" });
    const sessionId = first.json.sessionId as string;
    const a1 = (await treeOf(app, sessionId)).entries.find((e) => e.type === "assistant")!;
    await post(app, `/session/${sessionId}/model`, { configId: seeded.haiku.id, acknowledgeKeyChange: true });
    await post(app, "/chat", { text: "two", sessionId });
    expect(calls.at(-1)!.model).toBe(HAIKU);

    // Back above the switch: that branch follows the binding (opus, key A).
    const rewound = await post(app, `/session/${sessionId}/rewind`, { entryId: a1.id });
    expect(rewound.json.model).toBe(OPUS); // the state follows the branch in view
    const groups = JSON.parse((await get(app, `/configs?session=${sessionId}`)).text) as { groups: { fingerprint: string; current: boolean }[] };
    expect(groups.groups[0]).toMatchObject({ fingerprint: "aaaa", current: true });

    const toB = await post(app, `/session/${sessionId}/model`, { configId: seeded.haiku.id });
    expect(toB.status).toBe(409); // A→B on this branch needs the confirm
    expect(toB.json).toMatchObject({ code: "cross-key", from: "aaaa", to: "bbbb" });
    const toA = await post(app, `/session/${sessionId}/model`, { configId: seeded.sonnet.id });
    expect(toA.status).toBe(200); // same key as this branch — one click
    expect(toA.json.model).toBe(SONNET);
  });

  it("drops a pending pick when the branch it would land on has a different key", async () => {
    const app = makeApp(scriptDriver);
    const first = await post(app, "/chat", { text: "one" });
    const sessionId = first.json.sessionId as string;
    const a1 = (await treeOf(app, sessionId)).entries.find((e) => e.type === "assistant")!;
    await post(app, `/session/${sessionId}/model`, { configId: seeded.haiku.id, acknowledgeKeyChange: true });
    const busy = await post(app, "/chat", { text: "ask: two", sessionId });
    expect(busy.json.status).toBe("awaiting-input");

    // Same key as the busy branch (B), so no confirm was asked for…
    const pick = await post(app, `/session/${sessionId}/model`, { configId: seeded.haiku.id });
    expect(pick.json.switch).toBe("pending");
    // …but the reader moves to the opus branch (key A) before it lands.
    await post(app, `/session/${sessionId}/rewind`, { entryId: a1.id });
    const done = await post(app, `/session/${sessionId}/answer`, { text: "x" });
    expect(done.json.pendingModelSwitch).toBeNull();
    const switches = (await treeOf(app, sessionId)).entries.filter((e) => e.type === "model-switch");
    expect(switches).toHaveLength(1); // only the original, acknowledged one
  });

  it("retries on the model of the branch in view, never another model's signed reasoning", async () => {
    const app = makeApp(scriptDriver);
    const first = await post(app, "/chat", { text: "one" });
    const sessionId = first.json.sessionId as string;
    await post(app, "/chat", { text: "two", sessionId });
    const tree = await treeOf(app, sessionId);
    const [a1, a2] = tree.entries.filter((e) => e.type === "assistant");
    // A sibling of "two", switched to sonnet, whose turn fails.
    await post(app, `/session/${sessionId}/rewind`, { entryId: a1!.id });
    await post(app, `/session/${sessionId}/model`, { configId: seeded.sonnet.id });
    failing.add(SONNET);
    const failed = await post(app, "/chat", { text: "three", sessionId });
    expect(failed.json.retryable).toBe(true);
    failing.clear();

    // Back to the opus branch (signed reasoning on it), and Retry.
    await post(app, `/session/${sessionId}/rewind`, { entryId: a2!.id });
    const retried = await post(app, `/session/${sessionId}/retry`, {});
    expect(retried.status).toBe(200);
    const req = calls.at(-1)!;
    expect(req.model).toBe(OPUS);
  });

  it("releases a queue held for a missing model once a model is picked", async () => {
    const app = makeApp(scriptDriver);
    const first = await post(app, "/chat", { text: "one" });
    const sessionId = first.json.sessionId as string;
    await post(app, `/session/${sessionId}/model`, { configId: seeded.sonnet.id });
    deleteConfig(seeded.sonnet.id);

    const held = await post(app, `/session/${sessionId}/queue`, { text: "two" });
    expect(held.json.queue).toHaveLength(1);
    const before = calls.length;
    expect(held.json.status).toBe("idle");

    const pick = await post(app, `/session/${sessionId}/model`, { configId: seeded.opus.id, acknowledgeKeyChange: true });
    expect(pick.json.queue).toHaveLength(0);
    expect(calls.length).toBe(before + 1);
    expect(calls.at(-1)!.model).toBe(OPUS);
  });

  it("refuses mid-turn when the config is deleted, leaving the turn retryable after a pick", async () => {
    const app = makeApp(scriptDriver);
    const first = await post(app, "/chat", { text: "one" });
    const sessionId = first.json.sessionId as string;
    await post(app, `/session/${sessionId}/model`, { configId: seeded.sonnet.id });
    const busy = await post(app, "/chat", { text: "ask: two", sessionId });
    expect(busy.json.status).toBe("awaiting-input");
    deleteConfig(seeded.sonnet.id);

    const before = calls.length;
    const answered = await post(app, `/session/${sessionId}/answer`, { text: "x" });
    expect(calls.length).toBe(before); // nothing sent, nothing substituted
    expect(answered.json.status).toBe("idle");
    expect(answered.json.retryable).toBe(true);
    expect(answered.json.modelMissing.code).toBe("model-config-missing");

    await post(app, `/session/${sessionId}/model`, { configId: seeded.opus.id, acknowledgeKeyChange: true });
    const retried = await post(app, `/session/${sessionId}/retry`, {});
    expect(retried.status).toBe(200);
    expect(calls.at(-1)!.model).toBe(OPUS);
    expect(retried.json.status).toBe("idle");
  });

  it("lands a pending pick before the queued turn that follows the busy one", async () => {
    const app = makeApp(scriptDriver);
    const first = await post(app, "/chat", { text: "ask: one" });
    const sessionId = first.json.sessionId as string;
    await post(app, `/session/${sessionId}/model`, { configId: seeded.sonnet.id });
    // Queued during the turn's last call, so it opens a turn of its own.
    duringAnswer = () => post(app, `/session/${sessionId}/queue`, { text: "queued" });

    await post(app, `/session/${sessionId}/answer`, { text: "x" });
    expect(calls.map((r) => r.model)).toEqual([OPUS, OPUS, SONNET]);
    const entries = (await treeOf(app, sessionId)).entries;
    const sw = entries.find((e) => e.type === "model-switch")!;
    const queued = entries.find((e) => e.type === "user" && e.text === "queued")!;
    expect(queued.parent).toBe(sw.id);
  });

  it("holds a model change to the governing config until the turn boundary", async () => {
    const app = makeApp(scriptDriver);
    const first = await post(app, "/chat", { text: "one" });
    const sessionId = first.json.sessionId as string;
    await post(app, `/session/${sessionId}/model`, { configId: seeded.sonnet.id });
    await post(app, "/chat", { text: "ask: two", sessionId });

    editConfig(seeded.sonnet.id, { model: HAIKU }); // same config id, new model
    await post(app, `/session/${sessionId}/answer`, { text: "x" });
    expect(calls.at(-1)!.model).toBe(SONNET); // mid-cycle: not handed over

    await post(app, "/chat", { text: "three", sessionId });
    expect(calls.at(-1)!.model).toBe(HAIKU); // next turn: the edit applies
  });

  it("keeps the turn's doubled round budget across a mid-turn re-resolve", async () => {
    editConfig(seeded.sonnet.id, { commands: { toolRounds: 2 } } as Partial<ModelConfig>);
    askRounds = 3;
    const app = makeApp(scriptDriver);
    const first = await post(app, "/chat", { text: "one" });
    const sessionId = first.json.sessionId as string;
    await post(app, `/session/${sessionId}/model`, { configId: seeded.sonnet.id });
    await post(app, "/chat", { text: "ask: go", sessionId });
    await post(app, `/session/${sessionId}/answer`, { text: "1" });
    const stalled = await post(app, `/session/${sessionId}/answer`, { text: "2" });
    expect(stalled.json.status).toBe("awaiting-continue"); // 2 rounds of 2

    // An edit to the governing config lands mid-turn, then Continue (budget 4).
    editConfig(seeded.sonnet.id, { reasoningEffort: "high" });
    const cont = await post(app, `/session/${sessionId}/continue`, {});
    expect(cont.json.status).toBe("awaiting-input"); // round 3
    expect(calls.at(-1)!.reasoning).toEqual({ effort: "high" }); // the edit did apply
    const done = await post(app, `/session/${sessionId}/answer`, { text: "3" });
    expect(done.json.status).toBe("idle"); // round 4 ran: the budget was not reset to 2
  });

  it("drops a pending pick whose config was deleted before the idle point", async () => {
    const app = makeApp(scriptDriver);
    const first = await post(app, "/chat", { text: "ask: one" });
    const sessionId = first.json.sessionId as string;
    const pick = await post(app, `/session/${sessionId}/model`, { configId: seeded.sonnet.id });
    expect(pick.json.switch).toBe("pending");
    deleteConfig(seeded.sonnet.id);

    const done = await post(app, `/session/${sessionId}/answer`, { text: "x" });
    expect(done.json.pendingModelSwitch).toBeNull();
    expect(done.json.model).toBe(OPUS);
    expect(done.json.modelMissing).toBeNull();
    expect((await treeOf(app, sessionId)).entries.some((e) => e.type === "model-switch")).toBe(false);
  });
});

// ---- Review round 2: a branch never inherits a sibling's switch, a suspended
// turn is never retargeted, a retry keeps its cycle, a pick spends no call.

/** opus "one" → a1; switch the thread to haiku (key B); `ask: two` pauses;
 *  the reader rewinds to a1 (no switch, key A) while that turn is paused. */
async function strandedOnA1(app: App) {
  const first = await post(app, "/chat", { text: "one" });
  const sessionId = first.json.sessionId as string;
  const a1 = (await treeOf(app, sessionId)).entries.find((e) => e.type === "assistant")!;
  await post(app, `/session/${sessionId}/model`, { configId: seeded.haiku.id, acknowledgeKeyChange: true });
  const busy = await post(app, "/chat", { text: "ask: two", sessionId });
  expect(busy.json.status).toBe("awaiting-input");
  await post(app, `/session/${sessionId}/rewind`, { entryId: a1.id });
  return { sessionId, a1 };
}

describe("review round 2", () => {
  beforeEach(() => {
    failing = new Set();
    askRounds = 1;
    duringAnswer = undefined;
  });


  it("runs a queued turn on an unswitched branch under the binding, not the sibling's switch", async () => {
    const app = makeApp(scriptDriver);
    const { sessionId, a1 } = await strandedOnA1(app);
    duringAnswer = () => post(app, `/session/${sessionId}/queue`, { text: "queued" });
    const done = await post(app, `/session/${sessionId}/answer`, { text: "x" });
    expect(calls.map((r) => r.model)).toEqual([OPUS, HAIKU, HAIKU, OPUS]);
    expect(done.json.model).toBe(OPUS);
    const queued = (await treeOf(app, sessionId)).entries.find((e) => e.type === "user" && e.text === "queued")!;
    expect(queued.parent).toBe(a1.id);
  });

  it("measures a pick from the branch in view while the session still holds the paused turn's config", async () => {
    const app = makeApp(scriptDriver);
    const { sessionId } = await strandedOnA1(app);
    // Paused on haiku (key B); the branch in view is a1, opus (key A). A pick
    // here lands on a1 at the idle point, so a1's key is what it is measured from.
    const pick = await post(app, `/session/${sessionId}/model`, { configId: seeded.haiku.id });
    expect(pick.status).toBe(409);
    expect(pick.json).toMatchObject({ code: "cross-key", from: "aaaa", to: "bbbb" });
    // …and once the turn settles, the idle session holds a1's config (the invariant).
    const done = await post(app, `/session/${sessionId}/answer`, { text: "x" });
    expect(done.json.status).toBe("idle");
    expect(done.json.model).toBe(OPUS);
  });

  it("retries an unswitched branch on the binding when a halted session holds a sibling's switch", async () => {
    const app = makeApp(scriptDriver);
    const first = await post(app, "/chat", { text: "one" });
    const sessionId = first.json.sessionId as string;
    const a1 = (await treeOf(app, sessionId)).entries.find((e) => e.type === "assistant")!;
    await post(app, `/session/${sessionId}/model`, { configId: seeded.haiku.id, acknowledgeKeyChange: true });
    failing.add(HAIKU);
    await post(app, "/chat", { text: "two", sessionId }); // failure 1
    await post(app, "/chat", { text: "three", sessionId }); // 2 (a Retry would reset the count)
    const halted = await post(app, "/chat", { text: "four", sessionId }); // 3 → breaker
    expect(halted.json.status).toBe("halted");
    failing.clear();
    // Halted is not an idle point, so the rewind leaves the config alone…
    const rewound = await post(app, `/session/${sessionId}/rewind`, { entryId: a1.id });
    expect(rewound.json.model).toBe(HAIKU);
    // …and the retry, acting on a1, must align for itself.
    const retried = await post(app, `/session/${sessionId}/retry`, {});
    expect(retried.status).toBe(200);
    expect(calls.at(-1)!.model).toBe(OPUS);
  });

  it("never retargets a cap-blocked turn: it resumes on the model it started on", async () => {
    const app = makeApp(scriptDriver);
    const first = await post(app, "/chat", { text: "one" });
    const sessionId = first.json.sessionId as string;
    const a1 = (await treeOf(app, sessionId)).entries.find((e) => e.type === "assistant")!;
    await post(app, `/session/${sessionId}/model`, { configId: seeded.haiku.id, acknowledgeKeyChange: true });
    await post(app, "/chat", { text: "ask: two", sessionId });
    await post(app, `/session/${sessionId}/cap`, { capUsd: 0 });
    const blocked = await post(app, `/session/${sessionId}/answer`, { text: "x" });
    expect(blocked.json.capReached).toBe(true);
    expect(blocked.json.status).toBe("idle"); // reads idle — but the turn is pinned

    const rewound = await post(app, `/session/${sessionId}/rewind`, { entryId: a1.id });
    expect(rewound.json.model).toBe(HAIKU); // nothing moved under the suspended turn
    // A message queued now opens no turn (cap-blocked), but it is a route that
    // re-adopts the binding for the branch in view — which must not reach the
    // pinned turn.
    const queued = await post(app, `/session/${sessionId}/queue`, { text: "later" });
    expect(queued.json.model).toBe(HAIKU);
    const n = calls.length;
    await post(app, `/session/${sessionId}/cap`, { capUsd: null });
    expect(calls[n]!.model).toBe(HAIKU); // the resumed turn (which takes "later" with it, D-52)
  });

  it("retries an unswitched thread on its own model after a rebind, round budget intact", async () => {
    editConfig(seeded.opus.id, { commands: { toolRounds: 2 } } as Partial<ModelConfig>);
    askRounds = 3;
    const app = makeApp(scriptDriver);
    const first = await post(app, "/chat", { text: "ask: one" });
    const sessionId = first.json.sessionId as string;
    const stalled = await post(app, `/session/${sessionId}/answer`, { text: "1" });
    expect(stalled.json.status).toBe("awaiting-input");
    expect((await post(app, `/session/${sessionId}/answer`, { text: "2" })).json.status).toBe("awaiting-continue");
    failing.add(OPUS);
    const failed = await post(app, `/session/${sessionId}/continue`, {}); // budget 4; round 3 fails
    expect(failed.json.retryable).toBe(true);
    failing.clear();

    // The folder is rebound mid-cycle; a retry must not pick that up (D-82a).
    saveConfig(setBinding(loadConfig(paths), workspace, seeded.sonnet.id), paths);
    const before = calls.length;
    const retried = await post(app, `/session/${sessionId}/retry`, {});
    expect(calls.length).toBe(before + 1); // round 4 ran: the doubled budget held
    expect(calls.at(-1)!.model).toBe(OPUS);
    expect(retried.json.status).toBe("awaiting-input");
  });

  it("does not send a parked todo notice when the model is switched", async () => {
    const app = makeApp(scriptDriver);
    const first = await post(app, "/chat", { text: "one" });
    const sessionId = first.json.sessionId as string;
    const res = await app.request(`/session/${sessionId}/todos`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ text: "write the tests" }] }),
    });
    const parked = (await res.json()) as Record<string, any>;
    expect(parked.queue).toHaveLength(1); // parked: no turn opened for it
    const before = calls.length;

    const pick = await post(app, `/session/${sessionId}/model`, { configId: seeded.sonnet.id });
    expect(pick.json.switch).toBe("applied");
    expect(calls.length).toBe(before); // no unrequested model call
    expect(pick.json.queue).toHaveLength(1);
  });
});

// ---- Review round 3: the config invariant — every model call resolves from
// the branch it acts on; an idle session holds the in-view branch's config.

describe("review round 3: the config invariant", () => {
  beforeEach(() => {
    failing = new Set();
    askRounds = 1;
    duringAnswer = undefined;
  });

  it("a send onto another branch while a turn is cap-parked runs on that branch's model", async () => {
    const app = makeApp(scriptDriver);
    const first = await post(app, "/chat", { text: "one" });
    const sessionId = first.json.sessionId as string;
    const a1 = (await treeOf(app, sessionId)).entries.find((e) => e.type === "assistant")!;
    await post(app, `/session/${sessionId}/model`, { configId: seeded.haiku.id, acknowledgeKeyChange: true });
    await post(app, `/session/${sessionId}/cap`, { capUsd: 0 });
    const parked = await post(app, "/chat", { text: "two", sessionId });
    expect(parked.json.capReached).toBe(true);

    const onA1 = await post(app, "/chat", { text: "three", sessionId, leaf: a1.id });
    expect(onA1.status).toBe(200);
    expect(onA1.json.model).toBe(OPUS);
    await post(app, `/session/${sessionId}/cap`, { capUsd: null });
    expect(calls.at(-1)!.model).toBe(OPUS);
    expect(calls.at(-1)!.messages.at(-1)!.content).toContain("three");
  });

  it("compacts on demand with the in-view branch's model after a mid-turn rewind", async () => {
    const app = makeApp(scriptDriver);
    const { sessionId } = await strandedOnA1(app);
    await post(app, `/session/${sessionId}/answer`, { text: "x" });
    const before = calls.length;
    const res = await post(app, `/session/${sessionId}/compact`, {});
    expect(res.status).toBe(200);
    expect(calls.length).toBe(before + 1);
    expect(calls.at(-1)!.model).toBe(OPUS);
  });

  it("refuses on-demand compaction and Retry, typed, on a branch whose config is gone", async () => {
    const app = makeApp(scriptDriver);
    const first = await post(app, "/chat", { text: "one" });
    const sessionId = first.json.sessionId as string;
    await post(app, `/session/${sessionId}/model`, { configId: seeded.sonnet.id });
    failing.add(SONNET);
    const failed = await post(app, "/chat", { text: "two", sessionId });
    expect(failed.json.retryable).toBe(true);
    failing.clear();
    deleteConfig(seeded.sonnet.id);

    const before = calls.length;
    const compact = await post(app, `/session/${sessionId}/compact`, {});
    expect(compact.status).toBe(409);
    expect(compact.json.code).toBe("model-config-missing");
    const retry = await post(app, `/session/${sessionId}/retry`, {});
    expect(retry.status).toBe(409);
    expect(retry.json.code).toBe("model-config-missing");
    expect(retry.json.retryable).toBeUndefined(); // the 409 body is the refusal, not a state
    expect(calls.length).toBe(before);
  });
});

// ---- Review round 4: a refused send leaves a parked turn as it found it; a
// refused edit leaves the pointer; defaults are written to the in-view config.

describe("review round 4", () => {
  beforeEach(() => {
    failing = new Set();
    askRounds = 1;
    duringAnswer = undefined;
  });

  it("a send refused for a missing config keeps the cap-parked turn's pin", async () => {
    const app = makeApp(scriptDriver);
    const first = await post(app, "/chat", { text: "one" });
    const sessionId = first.json.sessionId as string;
    const a1 = (await treeOf(app, sessionId)).entries.find((e) => e.type === "assistant")!;
    await post(app, `/session/${sessionId}/model`, { configId: seeded.sonnet.id });
    await post(app, "/chat", { text: "two", sessionId });
    const a2 = (await treeOf(app, sessionId)).entries.filter((e) => e.type === "assistant").at(-1)!;
    await post(app, `/session/${sessionId}/rewind`, { entryId: a1.id });
    await post(app, `/session/${sessionId}/cap`, { capUsd: 0 });
    const parked = await post(app, "/chat", { text: "three", sessionId });
    expect(parked.json.capReached).toBe(true);
    deleteConfig(seeded.sonnet.id);

    const refused = await post(app, "/chat", { text: "four", sessionId, leaf: a2.id });
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe("model-config-missing");
    await post(app, `/session/${sessionId}/rewind`, { entryId: a1.id });

    const n = calls.length;
    await post(app, `/session/${sessionId}/cap`, { capUsd: null });
    const resumed = calls.slice(n);
    expect(resumed.length).toBeGreaterThan(0);
    for (const req of resumed) expect(req.messages.at(-1)!.role).not.toBe("assistant");
    expect(resumed[0]!.model).toBe(OPUS);
    expect(resumed[0]!.messages.at(-1)!.content).toContain("three");
  });

  it("an edit refused for a missing config leaves the pointer where it was", async () => {
    const app = makeApp(scriptDriver);
    const first = await post(app, "/chat", { text: "one" });
    const sessionId = first.json.sessionId as string;
    await post(app, `/session/${sessionId}/model`, { configId: seeded.sonnet.id });
    await post(app, "/chat", { text: "two", sessionId });
    deleteConfig(seeded.sonnet.id);
    const before = JSON.parse((await get(app, `/session/${sessionId}`)).text) as TreeView & { activeLeaf: string };
    const two = before.entries.find((e) => e.type === "user" && e.text === "two")!;

    const edited = await post(app, `/session/${sessionId}/edit`, { entryId: two.id, text: "two, again" });
    expect(edited.status).toBe(409);
    expect(edited.json.code).toBe("model-config-missing");
    const after = JSON.parse((await get(app, `/session/${sessionId}`)).text) as { activeLeaf: string };
    expect(after.activeLeaf).toBe(before.activeLeaf);
  });

  it("writes mode/trigger defaults to the in-view branch's config, and skips a deleted one", async () => {
    const persisted: string[] = [];
    const app = makeApp(scriptDriver, { onPersist: (name) => persisted.push(name) });
    const first = await post(app, "/chat", { text: "one" });
    const sessionId = first.json.sessionId as string;
    const a1 = (await treeOf(app, sessionId)).entries.find((e) => e.type === "assistant")!;
    await post(app, `/session/${sessionId}/model`, { configId: seeded.sonnet.id });
    await post(app, `/session/${sessionId}/mode`, { mode: "plan" });
    expect(persisted).toEqual(["sonnet"]);

    // Paused on sonnet while the reader looks at a1 (unswitched → the binding).
    await post(app, "/chat", { text: "ask: two", sessionId });
    await post(app, `/session/${sessionId}/rewind`, { entryId: a1.id });
    await post(app, `/session/${sessionId}/trigger-mode`, { mode: "manual" });
    expect(persisted).toEqual(["sonnet", "opus"]);
    await post(app, `/session/${sessionId}/answer`, { text: "x" });

    // Back on the switched branch, whose config is then deleted: nothing written.
    const tree = await treeOf(app, sessionId);
    const tip = tree.entries.filter((e) => e.type === "assistant").at(-1)!;
    await post(app, `/session/${sessionId}/rewind`, { entryId: tip.id });
    deleteConfig(seeded.sonnet.id);
    const res = await post(app, `/session/${sessionId}/mode`, { mode: "code" });
    expect(res.status).toBe(200);
    await post(app, `/session/${sessionId}/trigger-mode`, { mode: "auto" });
    expect(persisted).toEqual(["sonnet", "opus"]);
  });
});

// ---- Review round 5: a finished turn's settle tail never touches a newer turn.

describe("review round 5: turn generations", () => {
  beforeEach(() => {
    failing = new Set();
    askRounds = 1;
    duringAnswer = undefined;
    titleHold = undefined;
    slowHold = undefined;
  });

  /** "one" settles into a held title ask; returns the pending /chat. */
  async function oneWithTitleHeld(app: App) {
    const t = gate();
    titleHold = t.hold;
    const res = await app.request("/session", { method: "POST" });
    const { sessionId } = (await res.json()) as { sessionId: string };
    const one = post(app, "/chat", { text: "one", sessionId });
    await t.started;
    const a1 = (await treeOf(app, sessionId)).entries.find((e) => e.type === "assistant")!;
    return { sessionId, a1, one, openTitle: t.open };
  }

  it("a suspended turn opened during the old turn's title ask keeps its pin", async () => {
    const app = makeApp(scriptDriver);
    const { sessionId, a1, one, openTitle } = await oneWithTitleHeld(app);
    const two = await post(app, "/chat", { text: "ask: two", sessionId });
    expect(two.json.status).toBe("awaiting-input");
    openTitle();
    await one;
    await post(app, `/session/${sessionId}/rewind`, { entryId: a1.id });
    const done = await post(app, `/session/${sessionId}/answer`, { text: "x" });
    expect(done.status).toBe(200);

    const entries = (await treeOf(app, sessionId)).entries;
    const call = entries.find((e) => e.type === "assistant" && e.parent === entries.find((u) => u.text === "ask: two")!.id)!;
    const result = entries.find((e) => e.type === "tool")!;
    expect(result.parent).toBe(call.id); // answered under the call, not under a1
    // No request carries a tool message that doesn't follow its call.
    for (const req of calls) {
      req.messages.forEach((m, i) => {
        if (m.role === "tool") expect(["assistant", "tool"]).toContain(req.messages[i - 1]!.role);
      });
    }
  });

  it("a running turn opened during the old turn's title ask keeps its pin", async () => {
    const app = makeApp(scriptDriver);
    const { sessionId, a1, one, openTitle } = await oneWithTitleHeld(app);
    const s = gate();
    slowHold = s.hold;
    const two = post(app, "/chat", { text: "slow: two", sessionId });
    await s.started; // B is mid-request
    openTitle();
    await one; // A's tail runs while B is running
    await post(app, `/session/${sessionId}/rewind`, { entryId: a1.id });
    s.open();
    expect((await two).status).toBe(200);

    const entries = (await treeOf(app, sessionId)).entries;
    const userTwo = entries.find((e) => e.type === "user" && e.text === "slow: two")!;
    const replies = entries.filter((e) => e.type === "assistant");
    expect(replies.at(-1)!.parent).toBe(userTwo.id); // B's reply chains off B, not a1
  });
});

// ---- Review round 6: a hard Stop of a suspended turn is an idle point.

describe("review round 6: hard stop ends a suspended turn", () => {
  beforeEach(() => {
    failing = new Set();
    askRounds = 1;
    duringAnswer = undefined;
    titleHold = undefined;
    slowHold = undefined;
  });

  it("a pick after a hard Stop from a question card applies at once", async () => {
    const app = makeApp(scriptDriver);
    const first = await post(app, "/chat", { text: "ask: one" });
    const sessionId = first.json.sessionId as string;
    expect(first.json.status).toBe("awaiting-input");
    const stopped = await post(app, `/session/${sessionId}/stop`, { scope: "hard" });
    expect(stopped.json.status).toBe("idle");
    const pick = await post(app, `/session/${sessionId}/model`, { configId: seeded.sonnet.id });
    expect(pick.json.switch).toBe("applied");
    expect(pick.json.model).toBe(SONNET);
    expect(pick.json.pendingModelSwitch).toBeNull();
  });

  it("a pick made before the hard Stop lands at the Stop", async () => {
    const app = makeApp(scriptDriver);
    const first = await post(app, "/chat", { text: "ask: one" });
    const sessionId = first.json.sessionId as string;
    const pick = await post(app, `/session/${sessionId}/model`, { configId: seeded.sonnet.id });
    expect(pick.json.switch).toBe("pending");
    const stopped = await post(app, `/session/${sessionId}/stop`, { scope: "hard" });
    expect(stopped.json.pendingModelSwitch).toBeNull();
    expect(stopped.json.model).toBe(SONNET);
    expect((await treeOf(app, sessionId)).entries.some((e) => e.type === "model-switch")).toBe(true);
  });

  it("a hard-stopped cap park is not resumed by a later cap raise", async () => {
    const app = makeApp(scriptDriver);
    const first = await post(app, "/chat", { text: "one" });
    const sessionId = first.json.sessionId as string;
    await post(app, `/session/${sessionId}/cap`, { capUsd: 0 });
    const parked = await post(app, "/chat", { text: "two", sessionId });
    expect(parked.json.capReached).toBe(true);
    const stopped = await post(app, `/session/${sessionId}/stop`, { scope: "hard" });
    expect(stopped.json.capReached).toBe(false);

    const n = calls.length;
    await post(app, `/session/${sessionId}/cap`, { capUsd: null });
    expect(calls.length).toBe(n); // nothing resumed
    const fresh = await post(app, "/chat", { text: "three", sessionId });
    expect(fresh.status).toBe(200);
    expect(calls.length).toBe(n + 1);
    expect(calls.at(-1)!.messages.at(-1)!.content).toContain("three");
  });
});

// ---- Review round 7: a resume that consumed its card is a running turn.

describe("review round 7: stop during an approved tool", () => {
  beforeEach(() => {
    failing = new Set();
    askRounds = 1;
    duringAnswer = undefined;
    titleHold = undefined;
    slowHold = undefined;
  });

  it("a hard Stop while an approved command runs settles the turn on its own branch, with no model call", async () => {
    const app = makeApp(scriptDriver);
    const first = await post(app, "/chat", { text: "one" });
    const sessionId = first.json.sessionId as string;
    const a1 = (await treeOf(app, sessionId)).entries.find((e) => e.type === "assistant")!;
    const card = await post(app, "/chat", { text: "run: x", sessionId });
    expect(card.json.status).toBe("awaiting-approval");
    await post(app, `/session/${sessionId}/rewind`, { entryId: a1.id });

    const n = calls.length;
    const approving = post(app, `/session/${sessionId}/approve`, { approve: true });
    // Wait, deterministically, until the approved command is actually live —
    // a pure read, bounded so a regression fails fast rather than at the timeout.
    const deadline = Date.now() + 5_000;
    for (;;) {
      const state = JSON.parse((await get(app, `/session/${sessionId}/state`)).text) as Record<string, any>;
      if (state.status === "running" && (state.tasks as { status: string }[]).some((t) => t.status === "running")) break;
      if (Date.now() > deadline) throw new Error(`approved command never went live: status ${state.status}`);
      await new Promise((r) => setTimeout(r, 10));
    }
    const stopped = await post(app, `/session/${sessionId}/stop`, { scope: "hard" });
    expect(stopped.status).toBe(200);
    const approved = await approving;
    expect(approved.json.status).toBe("idle");
    expect(calls.length).toBe(n); // no model call after the stop

    const entries = (await treeOf(app, sessionId)).entries;
    const call = entries.find((e) => e.type === "assistant" && e.parent === entries.find((u) => u.text === "run: x")!.id)!;
    const result = entries.find((e) => e.type === "tool")!;
    expect(result.parent).toBe(call.id); // under its tool_call, not the reader's a1
  });
});

// ---- Review round 8: a Stop during an accepted compaction, and a resume that
// throws after marking itself running.

describe("review round 8: stop during resolveCompaction", () => {
  const cfg: ModelConfig = {
    id: "cfg",
    name: "Test",
    openRouterKey: "sk",
    model: "work-model",
    defaultMode: "code",
    defaultApproval: "manual",
    createdAt: "",
    updatedAt: "",
    compaction: { auto: false, triggerModes: ["cancelable"], bufferTokens: 100 },
  };
  const turn = (text: string, promptTokens: number): StreamEvent[] => [
    { type: "text", delta: text },
    { type: "finish", reason: "stop" },
    { type: "usage", usage: { promptTokens, completionTokens: 10 } },
  ];

  /** Turn 1 crosses the budget; request 2 is the summary, held open until
   *  `release` (rejecting on abort); anything after answers at once. */
  function heldSummaryDriver() {
    const requests: ChatRequest[] = [];
    let started!: () => void;
    let release!: () => void;
    const summaryStarted = new Promise<void>((r) => (started = r));
    const summaryRelease = new Promise<void>((r) => (release = r));
    const driver: LlmDriver = {
      async *streamChat(req, opts): AsyncGenerator<StreamEvent> {
        requests.push(req);
        const n = requests.length;
        if (n === 1) return yield* turn("first", 950);
        if (n === 2) {
          started();
          await Promise.race([
            summaryRelease,
            new Promise((_, reject) =>
              opts?.signal?.addEventListener("abort", () =>
                reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
              ),
            ),
          ]);
          return yield* [
            { type: "text", delta: "## Goal\nsummary.\n" },
            { type: "finish", reason: "stop" },
            { type: "usage", usage: { promptTokens: 500, completionTokens: 40 } },
          ] as StreamEvent[];
        }
        yield* turn("after", 20);
      },
    };
    return { driver, requests, summaryStarted, release };
  }

  async function pausedOnCompaction() {
    const d = heldSummaryDriver();
    const session = new Session({ config: cfg, driver: d.driver, systemPrompt: "SYS", contextWindow: 1_000 });
    await session.send("one");
    await session.send("two");
    expect(session.status).toBe("awaiting-compaction");
    return { session, ...d };
  }

  for (const scope of ["hard", "soft"] as const) {
    it(`a ${scope} Stop during the summary settles the turn with no further request`, async () => {
      const { session, requests, summaryStarted, release } = await pausedOnCompaction();
      const resolving = session.resolveCompaction(false);
      await summaryStarted;
      expect(session.status).toBe("running");
      session.stop(scope);
      if (scope === "soft") release();
      await resolving;

      const folds = session.conversation.entries.filter((e) => e.type === "compaction");
      expect(folds).toHaveLength(scope === "hard" ? 0 : 1);
      expect(requests).toHaveLength(2); // no model call after the stop
      expect(session.status).toBe("idle");
      expect(session.atIdlePoint).toBe(true);

      await session.send("three");
      expect(requests).toHaveLength(3);
      expect(session.status).toBe("idle");
    });
  }
});

// ---- Review round 10: a throw before the approved tool runs leaves the card's
// status, which a hard Stop recovers.

describe("review round 10: approve throws before the tool runs", () => {
  beforeEach(() => {
    failing = new Set();
    askRounds = 1;
    duringAnswer = undefined;
    titleHold = undefined;
    slowHold = undefined;
  });

  it("a failing onAddRoot leaves awaiting-approval, and a hard Stop recovers the thread", async () => {
    fs.writeFileSync(path.join(dir, "outside.txt"), "outside the fence\n");
    const app = makeApp(scriptDriver);
    const first = await post(app, "/chat", { text: "one" });
    const sessionId = first.json.sessionId as string;
    const card = await post(app, "/chat", { text: "outside: read it", sessionId });
    expect(card.json.status).toBe("awaiting-approval");

    // "Remember this root" persists through the config store — make that throw.
    const good = fs.readFileSync(paths.configFile, "utf8");
    fs.writeFileSync(paths.configFile, "{ not json", "utf8");
    const res = await app.request(`/session/${sessionId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approve: true, addRoot: true }),
    });
    expect(res.status).toBe(500);
    fs.writeFileSync(paths.configFile, good, "utf8");

    const stuck = JSON.parse((await get(app, `/session/${sessionId}/state`)).text) as Record<string, any>;
    expect(stuck.status).toBe("awaiting-approval"); // not a loop-less "running"
    const stopped = await post(app, `/session/${sessionId}/stop`, { scope: "hard" });
    expect(stopped.json.status).toBe("idle");
    const again = await post(app, "/chat", { text: "two", sessionId });
    expect(again.status).toBe(200);
    expect(again.json.status).toBe("idle");
  });
});
