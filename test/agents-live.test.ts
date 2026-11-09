/**
 * P9c's one Tier-1 test — a real model spawns a sub-agent and messages it (X-56,
 * D-88).
 *
 * Every other P9c test drives the tree with the fake driver, which calls the
 * agent tools because it was *written* to. This is the only test that asks
 * whether a model, reading nothing but the tool descriptions and the
 * attribution lines, actually uses them the way the design needs: spawn, end
 * its turn, message the child by the name it was given, and have the child
 * answer its parent with `send_message` rather than into the void of its own
 * reply. The assertions are deliberately weak properties (TESTING.md) — which
 * calls happened, where the word arrived — never wording.
 *
 * ## Recorded through the request-keyed cache (D-24) — and NOT YET RECORDED
 *
 * Recording is a paid live run, and P9c had no grant for it: the fixture is
 * P9g's to record, at the level Joshua picks. Until then this **skips** — see
 * `RECORDED` below — so `npm test` stays free and green. Record with
 * `JLCODE_LIVE=1 npx vitest run test/agents-live.test.ts` and a key.
 *
 * ## Two things that keep a recorded replay replayable
 *
 * **Nothing varies with the clock** — `turnTimestamps: false`, as every recorded
 * suite here (TESTING.md, Joshua 2026-08-09).
 *
 * **Nothing varies with timing.** A tree is concurrent, and the moment a
 * message lands in a busy agent changes that agent's next request — and a
 * replay is microtask-fast where the recording waited on the network. So the
 * root's config sets **`agentConcurrency: 1`**: only one agent of the tree runs
 * at a time, each agent-started turn waits `queued` for the one before it to
 * finish, and a message therefore only ever reaches an agent between turns.
 * That is also the width brake (D-89) doing its job against a live model.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Session, type SessionRetarget } from "../src/session/session";
import { AgentCoordinator } from "../src/session/agents";
import { ToolRegistry } from "../src/tools/registry";
import { agentTools } from "../src/tools/agent-tools";
import { Sandbox } from "../src/tools/sandbox";
import { LlmCache } from "../src/llm/cache";
import type { ChatRequest, LlmDriver } from "../src/llm/types";
import type { ModelConfig } from "../src/config/types";
import type { Conversation, Entry } from "../src/conversation/types";
import { liveDriver, LIVE, CACHE_DIR } from "./helpers/live";

const MODEL = process.env.JLCODE_AGENTS_MODEL ?? "openai/gpt-4o-mini";
const SYS = "You are JLCode, a concise coding agent. Keep replies short.";
const WORD = "PINEAPPLE";

const FIRST = `Start one sub-agent with spawn_agent. Its task: wait for a message from you containing a secret word, then send that word back to you with send_message.`;
const SECOND = `Tell your sub-agent that the secret word is ${WORD}.`;

function config(): ModelConfig {
  return {
    id: "cfg_agents_live",
    name: "Agents — Test",
    openRouterKey: "unused-through-caching",
    model: MODEL,
    sampling: { maxTokens: 512 },
    defaultMode: "code",
    defaultApproval: "full-auto",
    compaction: { auto: false, contextLength: 128_000 },
    // See the header: the one-at-a-time tree, and no clock on the wire.
    commands: { agentConcurrency: 1 },
    environment: { turnTimestamps: false },
    createdAt: "",
    updatedAt: "",
  };
}

const SANDBOX = new Sandbox([os.tmpdir()]); // the agent tools touch no file

function session(cfg: ModelConfig, driver: () => LlmDriver, conversation?: Conversation): Session {
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
    tools: new ToolRegistry(agentTools()),
    sandbox: SANDBOX,
    conversation,
    lookupConfig: (id) => (id === cfg.id ? cfg : undefined),
    deriveRetarget: retarget,
  });
}

function tree(driver: () => LlmDriver) {
  const cfg = config();
  const sessions: Session[] = [];
  const agents = new AgentCoordinator({
    listConfigs: () => [cfg],
    startAgent: ({ config: c, conversation }) => {
      const s = session(c, driver, conversation);
      sessions.push(s);
      return s;
    },
    agentRecords: () => [],
    loadConversation: () => undefined,
  });
  const root = session(cfg, driver);
  agents.adoptRoot(root);
  return { root, agents, sessions };
}

/**
 * Has the run been recorded? Probed by building the root's **first** request
 * exactly as the test will and asking the committed cache for it. "Any fixture
 * exists" — the other recorded suites' gate — is not enough here: the cache
 * already holds other suites' fixtures, so that gate would run this test and
 * fail on a miss instead of skipping it.
 */
async function firstRequestRecorded(): Promise<boolean> {
  let first: ChatRequest | undefined;
  const capture: LlmDriver = {
    // eslint-disable-next-line require-yield
    async *streamChat(req) {
      first ??= req;
      throw new Error("probe");
    },
  };
  const { root } = tree(() => capture);
  await root.send(FIRST).catch(() => {});
  return first !== undefined && new LlmCache(CACHE_DIR).get(first) !== undefined;
}

const RECORDED = await firstRequestRecorded();
const RUN = LIVE || RECORDED;

const calls = (s: Session, name: string) =>
  s.conversation.entries.flatMap((e) =>
    e.type === "assistant" ? (e.toolCalls ?? []).filter((c) => c.function.name === name) : [],
  );
const results = (s: Session, name: string) =>
  s.conversation.entries.filter((e): e is Extract<Entry, { type: "tool" }> => e.type === "tool" && e.name === name);
const inbound = (s: Session) =>
  s.conversation.entries.filter((e): e is Extract<Entry, { type: "user" }> => e.type === "user" && e.inbound !== undefined);

describe.skipIf(!RUN)("a live model runs a sub-agent (Tier 1, P9c)", () => {
  it("spawns a child, messages it by name, and gets the answer back by message", { timeout: 300_000 }, async () => {
    expect(fs.existsSync(CACHE_DIR) || LIVE).toBe(true);
    const { root, agents, sessions } = tree(liveDriver);

    await root.send(FIRST);
    await agents.idle();
    // It spawned, and its turn ended on the spawn: the child exists by name.
    expect(results(root, "spawn_agent").some((r) => !r.isError)).toBe(true);
    const child = sessions.find((s) => s.agentInfo?.name === "agent-1");
    if (!child) throw new Error("the model never spawned a sub-agent");

    await root.send(SECOND);
    await agents.idle();

    // The parent addressed the child by the name spawn_agent returned…
    const sent = calls(root, "send_message").map((c) => JSON.parse(c.function.arguments) as { to?: string; text?: string });
    expect(sent.some((a) => a.to === "agent-1" && (a.text ?? "").toUpperCase().includes(WORD))).toBe(true);
    expect(inbound(child).some((e) => e.inbound!.from === "root" && e.text.toUpperCase().includes(WORD))).toBe(true);

    // …and the child answered with send_message, not just in its own reply.
    const back = calls(child, "send_message").map((c) => JSON.parse(c.function.arguments) as { to?: string; text?: string });
    expect(back.some((a) => (a.to === "parent" || a.to === "root") && (a.text ?? "").toUpperCase().includes(WORD))).toBe(true);
    expect(
      inbound(root).some((e) => e.inbound!.from === "agent-1" && e.inbound!.kind === "message" && e.text.toUpperCase().includes(WORD)),
    ).toBe(true);
    expect(root.status).toBe("idle");
    expect(child.status).toBe("idle");
  });
});

// A skipped suite still reports *why* it skipped, so "unrecorded" is never
// mistaken for "passed".
describe.skipIf(RUN)("a live model runs a sub-agent (Tier 1, P9c) — not recorded yet", () => {
  it.skip(`no fixture for the first request in ${path.relative(process.cwd(), CACHE_DIR)} — P9g records it (paid, ask Joshua)`, () => {});
});
