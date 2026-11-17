/**
 * H-25 — nothing thrown inside a turn may leave a session silently stuck (D-99).
 *
 * The incident: a sub-agent's per-request config re-read (D-87) parsed a
 * config.json that was mid hand-edit, the SyntaxError escaped the turn, and the
 * session sat `running` forever — no `error`, no `settled`, so its parent was
 * never told. Two layers, held in place here:
 *
 *   - an unreadable config store is not a deleted config: the turn keeps
 *     running under what it holds, noted once in the diagnostic hook;
 *   - the generic backstop in `advance`: any other throw ends the turn as a
 *     retryable failure — `error`, `idle`, `settled` "failed" — and a Retry
 *     carries on from the branch's tip;
 *   - and for a sub-agent, that `settled` reaches the parent (D-88).
 *
 * Tier 0: scripted / fake drivers, temp config + data dirs, no network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Session } from "../src/session/session";
import { ToolRegistry } from "../src/tools/registry";
import { fileTools } from "../src/tools/file-tools";
import { Sandbox } from "../src/tools/sandbox";
import { ModeApprovalGate } from "../src/tools/mode-gate";
import { unansweredToolCalls } from "../src/conversation/tree";
import { stripEnvironmentDetails } from "../src/conversation/wire";
import { createServer } from "../src/server/server";
import { createSessionFactory } from "../src/server/session-factory";
import { ConversationStore } from "../src/persist/conversation-store";
import { ModelCatalog } from "../src/llm/models";
import { loadConfig, saveConfig, defaultConfig } from "../src/config/store";
import { addModelConfig, resolveForCwd, setBinding } from "../src/config/operations";
import { resolvePaths, type JlcodePaths } from "../src/paths";
import { fakeAgentDriver } from "../src/session/fake";
import type { ChatRequest, LlmDriver, StreamEvent } from "../src/llm/types";
import type { ModelConfig } from "../src/config/types";
import type { Entry } from "../src/conversation/types";
import type { SessionEvent } from "../src/session/session";
import type { Tool } from "../src/tools/types";
import type { AgentHost } from "../src/session/session";

let dir: string;
const saved = { config: process.env.JLCODE_CONFIG_DIR, data: process.env.JLCODE_DATA_DIR };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-h25-"));
  process.env.JLCODE_CONFIG_DIR = path.join(dir, "config");
  process.env.JLCODE_DATA_DIR = path.join(dir, "data");
  fs.writeFileSync(path.join(dir, "notes.txt"), "the notes\n");
});

afterEach(() => {
  process.env.JLCODE_CONFIG_DIR = saved.config;
  process.env.JLCODE_DATA_DIR = saved.data;
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- The session alone.

const CONFIG: ModelConfig = {
  id: "cfg",
  name: "t",
  openRouterKey: "k",
  model: "m",
  defaultMode: "code",
  defaultApproval: "full-auto",
  environment: { turnTimestamps: false },
  createdAt: "",
  updatedAt: "",
};

const calls = (...cs: { id: string; name: string; args?: unknown }[]): StreamEvent[] => [
  ...cs.map((c, index): StreamEvent => ({ type: "tool_call", index, id: c.id, name: c.name, argsDelta: JSON.stringify(c.args ?? {}) })),
  { type: "finish", reason: "tool_calls" },
];
const reply = (t: string): StreamEvent[] => [
  { type: "text", delta: t },
  { type: "finish", reason: "stop" },
];
const said = (req: ChatRequest): string => {
  const user = [...req.messages].reverse().find((m) => m.role === "user");
  return typeof user?.content === "string" ? stripEnvironmentDetails(user.content).trim() : "";
};
const toolsAfterLastUser = (req: ChatRequest): number => {
  let n = 0;
  for (let i = req.messages.length - 1; i >= 0 && req.messages[i]!.role !== "user"; i--) if (req.messages[i]!.role === "tool") n++;
  return n;
};

/** A tool whose execute throws — an infrastructure fault, not a tool error. */
const boomTool: Tool = {
  name: "boom",
  kind: "read",
  mutates: false,
  def: { type: "function", function: { name: "boom", description: "boom", parameters: { type: "object", properties: {} } } },
  async execute() {
    throw new Error("kaboom");
  },
};
/** The same, as a write — so a manual gate puts a card in front of it. */
const boomWriteTool: Tool = { ...boomTool, name: "boom_write", kind: "write", mutates: true, def: { type: "function", function: { name: "boom_write", description: "boom", parameters: { type: "object", properties: {} } } } };

interface Note {
  context: string;
  err: unknown;
  level: "warn" | "error";
}

function harness(opts: {
  lookup?: (id: string) => ModelConfig | undefined;
  binding?: () => ModelConfig | undefined;
  derive?: (config: ModelConfig) => void;
  approval?: "manual" | "full-auto";
  /** The fence; the temp dir by default. */
  root?: string;
  onAddRoot?: (dir: string) => void;
  extraTools?: Tool[];
  maxToolIterations?: number;
  /** Called at the top of every model request, with its 1-based index. */
  onRequest?: (n: number, req: ChatRequest) => void;
}) {
  const requests: ChatRequest[] = [];
  const events: SessionEvent[] = [];
  const notes: Note[] = [];
  const driver: LlmDriver = {
    async *streamChat(req): AsyncGenerator<StreamEvent> {
      requests.push(req);
      opts.onRequest?.(requests.length, req);
      const rounds = toolsAfterLastUser(req);
      switch (said(req)) {
        case "read twice":
          // Two tool rounds, so the store is re-read more than once mid-turn.
          if (rounds < 2) return yield* calls({ id: `r${rounds}`, name: "read_file", args: { path: "notes.txt" } });
          return yield* reply("read both");
        case "read":
          if (rounds === 0) return yield* calls({ id: "r0", name: "read_file", args: { path: "notes.txt" } });
          return yield* reply("read it");
        case "approve boom":
          if (rounds === 0) return yield* calls({ id: "w1", name: "boom_write" }, { id: "w2", name: "read_file", args: { path: "notes.txt" } });
          return yield* reply("recovered");
        case "ask parent":
          if (rounds === 0) return yield* calls({ id: "q1", name: "ask", args: { question: "which?", to: "parent" } });
          return yield* reply("thanks");
        case "ask":
          if (rounds === 0) return yield* calls({ id: "q1", name: "ask", args: { question: "which?" } });
          return yield* reply("thanks");
        case "read outside":
          if (rounds === 0) return yield* calls({ id: "o1", name: "read_file", args: { path: path.join(dir, "notes.txt") } });
          return yield* reply("read outside");
        case "learn boom":
          if (rounds === 0) return yield* calls({ id: "l1", name: "learny" });
          return yield* reply("after learn");
        case "cut":
          yield { type: "tool_call", index: 0, id: "c1", name: "read_file", argsDelta: '{"path":"notes.txt"}' };
          yield { type: "finish", reason: "length" };
          return;
        case "boom":
          if (rounds === 0) return yield* calls({ id: "b1", name: "boom" }, { id: "b2", name: "read_file", args: { path: "notes.txt" } });
          return yield* reply("recovered");
        default:
          return yield* reply("ok");
      }
    },
  };
  const sandbox = new Sandbox([opts.root ?? dir]);
  const s = new Session({
    config: CONFIG,
    driver,
    maxToolIterations: opts.maxToolIterations,
    tools: new ToolRegistry([...fileTools(), boomTool, boomWriteTool, ...(opts.extraTools ?? [])]),
    sandbox,
    onAddRoot: opts.onAddRoot,
    gate: new ModeApprovalGate("code", opts.approval ?? "full-auto"),
    lookupConfig: opts.lookup,
    bindingConfig: opts.binding,
    deriveRetarget: (config) => {
      opts.derive?.(config);
      return { config, driver, watchdogMs: 0, maxToolIterations: 50, acceptsImages: false };
    },
    onInternalError: (context, err, level) => notes.push({ context, err, level }),
  });
  s.onEvent((e) => events.push(e));
  return { s, requests, events, notes, sandbox };
}

const ofType = <T extends SessionEvent["type"]>(events: SessionEvent[], type: T) =>
  events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type);
const toolEntries = (s: Session) => s.conversation.entries.filter((e): e is Extract<Entry, { type: "tool" }> => e.type === "tool");

describe("an unreadable config store is not a deleted config (D-99)", () => {
  it("a switched thread whose store stops parsing mid-turn finishes the turn under the config it holds, noted once", async () => {
    let broken = false;
    const h = harness({
      lookup: (id) => {
        if (broken) throw new SyntaxError("Unexpected token } in JSON at position 812");
        return id === CONFIG.id ? CONFIG : undefined;
      },
      // The person saves a half-edited config.json while the first request is out.
      onRequest: (n) => {
        if (n === 1) broken = true;
      },
    });
    await h.s.switchModel(CONFIG.id); // governed by a switch entry → read per request
    await h.s.send("read twice");

    expect(h.requests).toHaveLength(3); // both re-reads failed, both rounds still went out
    expect(h.requests.every((r) => r.model === "m")).toBe(true);
    expect(h.s.status).toBe("idle");
    expect(ofType(h.events, "error")).toEqual([]);
    expect(ofType(h.events, "settled").at(-1)?.outcome).toBe("finished");
    expect(h.s.modelMissing).toBeUndefined(); // unreadable is not "deleted"
    // One note for the whole failing streak, as a warning, carrying the error.
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]).toMatchObject({ level: "warn" });
    expect(h.notes[0]!.context).toMatch(/config store unreadable/);
    expect(h.notes[0]!.err).toBeInstanceOf(SyntaxError);

    // A good read ends the streak; the next failure is noted afresh.
    broken = false;
    await h.s.send("hello");
    broken = true;
    await h.s.send("hello again");
    expect(h.notes).toHaveLength(2);
  });

  it("a deleted config still refuses — only a throw is ridden out", async () => {
    let deleted = false;
    const h = harness({
      lookup: (id) => (!deleted && id === CONFIG.id ? CONFIG : undefined),
      onRequest: (n) => {
        if (n === 1) deleted = true;
      },
    });
    await h.s.switchModel(CONFIG.id);
    await h.s.send("read");
    expect(h.requests).toHaveLength(1);
    expect(ofType(h.events, "error").at(-1)?.message).toMatch(/no longer exists|deleted|not found/i);
    expect(h.notes).toEqual([]);
  });

  it("an unreadable binding at a turn's top keeps the held config", async () => {
    const h = harness({
      binding: () => {
        throw Object.assign(new Error("EACCES: permission denied, open 'config.json'"), { code: "EACCES" });
      },
    });
    await h.s.send("hello");
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.model).toBe("m");
    expect(ofType(h.events, "settled").at(-1)?.outcome).toBe("finished");
    expect(h.notes.map((n) => n.level)).toEqual(["warn"]);
  });
});

describe("an unreadable binding never runs a branch on a sibling's switched model (D-99, D-87)", () => {
  it("held config is a switch's, reader rewinds to an unswitched branch, binding unreadable → the send refuses", async () => {
    const CONFIG_B: ModelConfig = { ...CONFIG, id: "cfg_b", name: "b", model: "m2", openRouterKey: "kB" };
    const h = harness({
      lookup: (id) => [CONFIG, CONFIG_B].find((c) => c.id === id),
      binding: () => {
        throw new SyntaxError("Unexpected end of JSON input");
      },
    });
    // Unswitched branch, binding unreadable from the start: the held config is
    // the binding's own, so it runs on model-A.
    await h.s.send("hello");
    expect(h.requests.at(-1)!.model).toBe("m");
    const unswitched = h.s.conversation.activeLeaf;
    // Switch this thread to model-B and use it.
    await h.s.switchModel(CONFIG_B.id);
    await h.s.send("on b");
    expect(h.requests.at(-1)!.model).toBe("m2");
    const sent = h.requests.length;
    // Back to the branch above the switch, where the binding governs.
    h.s.setActiveLeaf(unswitched);
    await expect(h.s.send("on a again")).rejects.toThrow(/JSON/);
    expect(h.requests).toHaveLength(sent); // nothing went out under model-B
    expect(h.s.status).toBe("idle");
  });
});

describe("the backstop: a throw inside a turn ends it as a retryable failure (D-99)", () => {
  it("a throw mid-batch → error (retryable), idle, settled failed, open calls answered; Retry carries on", async () => {
    const h = harness({});
    await h.s.send("boom");

    const errors = ofType(h.events, "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ retryable: true });
    expect(errors[0]!.message).toMatch(/internal error: kaboom/);
    expect(h.s.status).toBe("idle");
    expect(ofType(h.events, "settled").at(-1)?.outcome).toBe("failed");
    expect(h.s.restedAs).toBe("failed");
    // Logged with the error itself (its stack is what diagnostic.log needs).
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]).toMatchObject({ level: "error" });
    expect((h.notes[0]!.err as Error).message).toBe("kaboom");
    // Nothing comes to rest over a call with no result (H-10) — neither the
    // call that threw nor the one behind it, which never ran.
    expect(unansweredToolCalls(h.s.conversation, h.s.conversation.activeLeaf)).toEqual([]);
    const results = toolEntries(h.s);
    expect(results.map((t) => t.toolCallId)).toEqual(["b1", "b2"]);
    expect(results.every((t) => t.isError && /internal error/.test(t.content))).toBe(true);

    // Retry: the model is asked again from the tip, sees both failed results,
    // and the turn finishes normally. Nothing is re-run behind its back.
    await h.s.retry();
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]!.messages.filter((m) => m.role === "tool")).toHaveLength(2);
    expect(h.s.status).toBe("idle");
    expect(ofType(h.events, "settled").at(-1)?.outcome).toBe("finished");
    expect(h.s.conversation.entries.at(-1)).toMatchObject({ type: "assistant", text: "recovered" });
  });

  it("a throw before a request (the per-request re-derive) → Retry re-sends the same prefix", async () => {
    const edited = { ...CONFIG, updatedAt: "later", systemPromptAddendum: "edited" };
    let current = CONFIG;
    let explode = 0;
    const h = harness({
      lookup: (id) => (id === CONFIG.id ? current : undefined),
      derive: () => {
        if (explode > 0) {
          explode--;
          throw new Error("derive exploded");
        }
      },
      onRequest: (n) => {
        if (n === 1) {
          current = edited; // an edit to the governing config (same model)…
          explode = 1; // …whose re-derive throws, once
        }
      },
    });
    await h.s.switchModel(CONFIG.id);
    await h.s.send("read");
    expect(h.requests).toHaveLength(1);
    expect(ofType(h.events, "error").at(-1)).toMatchObject({ retryable: true });
    expect(ofType(h.events, "settled").at(-1)?.outcome).toBe("failed");
    expect(h.s.status).toBe("idle");
    // The read ran and its result is on the tree; nothing dangles.
    expect(toolEntries(h.s).map((t) => [t.toolCallId, t.isError])).toEqual([["r0", false]]);

    await h.s.retry();
    expect(h.requests).toHaveLength(2);
    // The retried request is the one that never went: it answers the read.
    expect(h.requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "r0" });
    expect(h.requests[1]!.messages.at(0)?.content).toContain("edited"); // and under the edit
    expect(ofType(h.events, "settled").at(-1)?.outcome).toBe("finished");
  });

  it("approving a tool that throws ends the turn as a failure, not a stuck `running`", async () => {
    const h = harness({ approval: "manual" });
    await h.s.send("approve boom");
    expect(h.s.status).toBe("awaiting-approval");

    await h.s.approve({ approve: true }); // resolves: the backstop owns the throw
    expect(h.s.status).toBe("idle");
    expect(ofType(h.events, "error").at(-1)).toMatchObject({ retryable: true });
    expect(ofType(h.events, "error").at(-1)!.message).toMatch(/kaboom/);
    expect(ofType(h.events, "settled").at(-1)?.outcome).toBe("failed");
    expect(unansweredToolCalls(h.s.conversation, h.s.conversation.activeLeaf)).toEqual([]);
    expect(toolEntries(h.s).map((t) => [t.toolCallId, t.isError, /internal error/.test(t.content)])).toEqual([
      ["w1", true, true],
      ["w2", true, true],
    ]);

    await h.s.retry();
    expect(ofType(h.events, "settled").at(-1)?.outcome).toBe("finished");
    expect(h.s.conversation.entries.at(-1)).toMatchObject({ type: "assistant", text: "recovered" });
  });

  it("a compaction that throws after its card is resolved ends the turn as a failure", async () => {
    const steps: StreamEvent[][] = [
      [{ type: "text", delta: "first" }, { type: "finish", reason: "stop" }, { type: "usage", usage: { promptTokens: 950, completionTokens: 100 } }],
      [{ type: "text", delta: "## Goal\nsummary." }, { type: "finish", reason: "stop" }, { type: "usage", usage: { promptTokens: 500, completionTokens: 40 } }],
    ];
    let i = 0;
    const driver: LlmDriver = {
      async *streamChat(): AsyncGenerator<StreamEvent> {
        const step = steps[i++];
        if (!step) throw new Error("script exhausted");
        for (const ev of step) yield ev;
      },
    };
    const notes: Note[] = [];
    const s = new Session({
      config: { ...CONFIG, compaction: { auto: false, triggerModes: ["cancelable"], bufferTokens: 100 } },
      driver,
      contextWindow: 1_000,
      onInternalError: (context, err, level) => notes.push({ context, err, level }),
    });
    const events: SessionEvent[] = [];
    s.onEvent((e) => events.push(e));
    await s.send("one");
    await s.send("two");
    expect(s.status).toBe("awaiting-compaction");
    // A subscriber that falls over on the compaction's spend report: a throw
    // from inside `compact()`, after the card was consumed.
    let armed = true;
    s.onEvent((e) => {
      if (armed && e.type === "spend") {
        armed = false;
        throw new Error("listener fell over");
      }
    });

    await s.resolveCompaction(false);
    expect(s.status).toBe("idle");
    expect(ofType(events, "error").at(-1)).toMatchObject({ retryable: true });
    expect(ofType(events, "error").at(-1)!.message).toMatch(/listener fell over/);
    expect(ofType(events, "settled").at(-1)?.outcome).toBe("failed");
    expect(notes.map((n) => n.level)).toEqual(["error"]);
  });

  it("a queued message refused before its turn opens goes back on the queue, said aloud, and does not spin", async () => {
    const edited = { ...CONFIG, updatedAt: "later" };
    let current = CONFIG;
    let derives = 0;
    let explode = false;
    const h = harness({
      lookup: (id) => (id === CONFIG.id ? current : undefined),
      derive: () => {
        derives++;
        if (explode) throw new Error("derive exploded");
      },
    });
    await h.s.switchModel(CONFIG.id);
    await h.s.send("hello");
    const sent = h.requests.length;
    // The governing config was edited; re-deriving it at the next turn's top throws.
    current = edited;
    explode = true;
    derives = 0;
    await h.s.enqueue("queued words");
    expect(h.requests).toHaveLength(sent); // no turn opened
    expect(h.s.queuedMessages.map((m) => m.text)).toEqual(["queued words"]);
    expect(ofType(h.events, "error").at(-1)!.message).toMatch(/still queued: derive exploded/);
    expect(h.s.status).toBe("idle");
    expect(derives).toBe(1); // tried once; nothing re-drives it on its own
    expect(h.notes.at(-1)).toMatchObject({ level: "error", context: "queued message could not open a turn" });

    // The next trigger sends it — along with whatever joined it.
    explode = false;
    await h.s.enqueue("more words");
    expect(h.requests).toHaveLength(sent + 1);
    const users = h.requests.at(-1)!.messages.filter((m) => m.role === "user").map((m) => stripEnvironmentDetails(String(m.content)).trim());
    expect(users.slice(-2)).toEqual(["queued words", "more words"]);
    expect(h.s.queuedMessages).toEqual([]);
  });

  it("remembering an approved root fails (config.json mid-edit): the call still runs, and the person is told", async () => {
    const work = path.join(dir, "work");
    fs.mkdirSync(work);
    const h = harness({
      approval: "manual",
      root: work,
      onAddRoot: () => {
        throw new SyntaxError("Unexpected end of JSON input");
      },
    });
    await h.s.send("read outside");
    expect(h.s.status).toBe("awaiting-approval");
    await h.s.approve({ approve: true, addRoot: true });

    const result = toolEntries(h.s).find((t) => t.toolCallId === "o1")!;
    expect(result.isError).toBe(false);
    expect(result.content).toContain("the notes");
    expect(ofType(h.events, "error").map((e) => e.message)).toEqual([expect.stringMatching(/allowed for this session, but couldn't be remembered in config: Unexpected end of JSON/)]);
    expect(h.notes.map((n) => n.level)).toEqual(["warn"]);
    expect(ofType(h.events, "settled").at(-1)?.outcome).toBe("finished");
  });

  it("any other throw before the approved call runs puts the card back, actionable", async () => {
    const learny: Tool = {
      ...boomWriteTool,
      name: "learny",
      def: { type: "function", function: { name: "learny", description: "l", parameters: { type: "object", properties: {} } } },
      rememberWrite: () => {
        throw new Error("hook broke");
      },
      async execute() {
        return { content: "learny ran" };
      },
    };
    const h = harness({ approval: "manual", extraTools: [learny] });
    await h.s.send("learn boom");
    const card = h.s.awaitingApproval;
    expect(card).toBeDefined();

    await expect(h.s.approve({ approve: true, learned: { writes: true } })).rejects.toThrow(/hook broke/);
    expect(h.s.awaitingApproval).toBe(card); // the same card, still answerable
    expect(h.s.status).toBe("awaiting-approval");
    expect(toolEntries(h.s)).toEqual([]); // nothing ran, nothing was written
    expect(h.notes.at(-1)).toMatchObject({ level: "error" });

    await h.s.approve({ approve: true }); // without the broken answer it goes
    expect(toolEntries(h.s).map((t) => t.content)).toEqual(["learny ran"]);
    expect(ofType(h.events, "settled").at(-1)?.outcome).toBe("finished");
  });

  it("a throw while a turn opens — before its message is written — fails the turn and keeps the message", async () => {
    const h = harness({});
    await h.s.send("cut"); // leaves a call open at the tip, for the next turn to heal
    // A subscriber that falls over on the heal's result: inside the opening.
    let armed = true;
    h.s.onEvent((e) => {
      if (armed && e.type === "entry" && e.entry.type === "tool") {
        armed = false;
        throw new Error("listener fell over");
      }
    });
    const before = h.requests.length;
    await h.s.send("hello");
    expect(h.requests).toHaveLength(before);
    expect(h.s.status).toBe("idle");
    expect(ofType(h.events, "error").at(-1)).toMatchObject({ retryable: true });
    expect(ofType(h.events, "settled").at(-1)?.outcome).toBe("failed");
    expect(h.s.queuedMessages.map((m) => m.text)).toEqual(["hello"]);
    expect(h.s.conversation.entries.filter((e) => e.type === "user").map((e) => (e as { text: string }).text)).toEqual(["cut"]);

    // Retry lands the kept message and answers it — once.
    await h.s.retry();
    expect(h.s.queuedMessages).toEqual([]);
    expect(h.s.conversation.entries.filter((e) => e.type === "user").map((e) => (e as { text: string }).text)).toEqual(["cut", "hello"]);
    expect(ofType(h.events, "settled").at(-1)?.outcome).toBe("finished");
  });

  it("a throw announcing the opening message (already written) fails the turn without queueing it twice", async () => {
    const h = harness({});
    let armed = true;
    h.s.onEvent((e) => {
      if (armed && e.type === "user") {
        armed = false;
        throw new Error("listener fell over");
      }
    });
    await h.s.send("hello");
    expect(h.requests).toHaveLength(0);
    expect(h.s.queuedMessages).toEqual([]);
    expect(ofType(h.events, "settled").at(-1)?.outcome).toBe("failed");
    await h.s.retry();
    expect(h.requests).toHaveLength(1);
    expect(h.s.conversation.entries.filter((e) => e.type === "user")).toHaveLength(1);
    expect(ofType(h.events, "settled").at(-1)?.outcome).toBe("finished");
  });

  /** A subscriber that throws once on the first event matching `when`. */
  function tripOnce(s: Session, when: (e: SessionEvent) => boolean): void {
    let armed = true;
    s.onEvent((e) => {
      if (armed && when(e)) {
        armed = false;
        throw new Error("listener fell over");
      }
    });
  }
  const resultIds = (s: Session) => toolEntries(s).map((t) => t.toolCallId);

  it("a deny whose result lands and then throws fails the turn — no card restored, no second result", async () => {
    const h = harness({ approval: "manual" });
    await h.s.send("approve boom");
    expect(h.s.status).toBe("awaiting-approval");
    tripOnce(h.s, (e) => e.type === "tool-end");

    await h.s.approve({ approve: false, reason: "no" });
    expect(h.s.awaitingApproval).toBeUndefined();
    expect(h.s.status).toBe("idle");
    expect(ofType(h.events, "error").at(-1)).toMatchObject({ retryable: true });
    expect(ofType(h.events, "settled").at(-1)?.outcome).toBe("failed");
    expect(resultIds(h.s)).toEqual(["w1", "w2"]); // one result per call
    await expect(h.s.approve({ approve: false })).rejects.toThrow(/No pending approval/);

    await h.s.retry();
    const toolMsgs = h.requests.at(-1)!.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    expect(toolMsgs).toEqual(["w1", "w2"]);
    expect(ofType(h.events, "settled").at(-1)?.outcome).toBe("finished");
  });

  it("an answer whose write throws fails the turn instead of stranding a card-less awaiting-input", async () => {
    const h = harness({});
    await h.s.send("ask");
    expect(h.s.status).toBe("awaiting-input");
    tripOnce(h.s, (e) => e.type === "tool-end");

    await h.s.answer("A");
    expect(h.s.awaitingInput).toBeUndefined();
    expect(h.s.status).toBe("idle");
    expect(ofType(h.events, "settled").at(-1)?.outcome).toBe("failed");
    expect(resultIds(h.s)).toEqual(["q1"]);

    await h.s.retry();
    expect(ofType(h.events, "settled").at(-1)?.outcome).toBe("finished");
    expect(h.s.conversation.entries.at(-1)).toMatchObject({ type: "assistant", text: "thanks" });
  });

  it("a Continue whose mark throws on announcement fails the turn, card gone, and Retry resumes", async () => {
    const h = harness({ maxToolIterations: 1 });
    await h.s.send("read");
    expect(h.s.status).toBe("awaiting-continue");
    tripOnce(h.s, (e) => e.type === "rounds-off");

    await h.s.continueRun({ dontAskAgain: true });
    expect(h.s.awaitingContinue).toBeUndefined();
    expect(h.s.status).toBe("idle");
    expect(ofType(h.events, "settled").at(-1)?.outcome).toBe("failed");
    await h.s.retry();
    expect(h.s.conversation.entries.at(-1)).toMatchObject({ type: "assistant", text: "read it" });
  });

  describe("a parent's answer to a sub-agent's question (answerFromParent)", () => {
    function child() {
      const h = harness({});
      const host: AgentHost = {
        spawn: async () => "",
        send: () => "",
        listModels: () => "",
        listAgents: () => "",
        closeChild: () => "",
        wakeAgents: () => "",
        setAgentMode: () => "",
        admit: () => true,
        treeSpendUsd: (x) => x.spendUsd,
        subtree: () => ({ agents: 0, running: 0, queued: 0, waiting: 0, spendUsd: 0 }),
      };
      h.s.setAgentHost(host, { name: "agent-1", depth: 1, parentSessionId: "p", rootSessionId: "p" });
      return h;
    }

    it("a throw before the answer lands keeps the card and returns false (the reply queues as a message)", async () => {
      const h = child();
      await h.s.send("ask parent");
      expect(h.s.asksParent).toBe(true);
      const internals = h.s as unknown as { pushEntry: (...a: unknown[]) => unknown };
      const real = internals.pushEntry;
      internals.pushEntry = () => {
        throw new Error("tree refused");
      };
      expect(h.s.answerFromParent("root", "blue")).toBe(false);
      internals.pushEntry = real;
      expect(h.s.asksParent).toBe(true);
      expect(h.s.status).toBe("awaiting-input");
      expect(resultIds(h.s)).toEqual([]);
      expect(h.notes.at(-1)).toMatchObject({ level: "error" });
      // Still answerable — by the parent's next reply, or the person.
      expect(h.s.answerFromParent("root", "blue")).toBe(true);
      await h.s.resumeAnswered();
      expect(ofType(h.events, "settled").at(-1)?.outcome).toBe("finished");
    });

    it("a throw after the answer lands keeps the answered resume", async () => {
      const h = child();
      await h.s.send("ask parent");
      tripOnce(h.s, (e) => e.type === "tool-end");
      expect(h.s.answerFromParent("root", "blue")).toBe(true);
      expect(h.s.status).toBe("queued");
      expect(resultIds(h.s)).toEqual(["q1"]);
      await h.s.resumeAnswered();
      expect(ofType(h.events, "settled").at(-1)?.outcome).toBe("finished");
      expect(resultIds(h.s)).toEqual(["q1"]);
    });
  });

  it("a throw after the fence was widened narrows it back to the snapshot, and keeps the card", async () => {
    const work = path.join(dir, "work");
    fs.mkdirSync(work);
    const h = harness({ approval: "manual", root: work });
    await h.s.send("read outside");
    const card = h.s.awaitingApproval;
    const before = [...h.sandbox.roots];
    const real = h.sandbox.addRoot.bind(h.sandbox);
    h.sandbox.addRoot = (d: string) => {
      real(d);
      throw new Error("after widening");
    };
    await expect(h.s.approve({ approve: true, addRoot: true })).rejects.toThrow(/after widening/);
    expect(h.sandbox.roots).toEqual(before);
    expect(h.s.awaitingApproval).toBe(card);
    expect(h.s.status).toBe("awaiting-approval");
  });

  it("a hard Stop of a card whose idle-point tail throws still says `settled` \"stopped\", once", async () => {
    const h = harness({ approval: "manual" });
    await h.s.send("approve boom");
    expect(h.s.status).toBe("awaiting-approval");
    // A parent's mode change, held behind the open batch (P9f2)…
    h.s.setModeFromParent("ask", { id: "in1", from: "root", kind: "message", text: "mode changed" });
    // …lands in Stop's tail, where a listener falls over on it.
    tripOnce(h.s, (e) => e.type === "mode");
    h.s.stop("hard");
    expect(h.s.status).toBe("idle");
    expect(ofType(h.events, "settled").map((e) => e.outcome)).toEqual(["stopped"]);
    expect(h.notes.at(-1)).toMatchObject({ level: "error" });
  });

  it("a listener throwing as the queue's head is taken off requeues it, not loses it", async () => {
    const h = harness({});
    await h.s.send("hello");
    const sent = h.requests.length;
    // Throws on the announcement of the emptied queue — the drain's own shift.
    tripOnce(h.s, (e) => e.type === "queue" && e.queue.length === 0);
    await h.s.enqueue("queued words");
    expect(h.requests).toHaveLength(sent);
    expect(h.s.queuedMessages.map((m) => m.text)).toEqual(["queued words"]);
    expect(h.s.status).toBe("idle");
    expect(ofType(h.events, "error").at(-1)!.message).toMatch(/still queued/);

    await h.s.enqueue("more words");
    expect(h.requests).toHaveLength(sent + 1);
    expect(h.s.queuedMessages).toEqual([]);
  });

  it("a broken diagnostic hook is not a second failure", async () => {
    const h = harness({});
    const s = h.s as unknown as { onInternalError: () => void };
    Object.defineProperty(s, "onInternalError", {
      value: () => {
        throw new Error("logger down");
      },
    });
    await h.s.send("boom");
    expect(h.s.status).toBe("idle");
    expect(ofType(h.events, "settled").at(-1)?.outcome).toBe("failed");
  });
});

// ---- Through the server: a sub-agent's parent hears it (D-88).

const OPUS = "anthropic/claude-opus-5";
const KEY_A = "sk-or-v1-client-a-0000000000aaaa";

describe("a sub-agent that hits either fault does not hang its parent", () => {
  let paths: JlcodePaths;
  let workspace: string;
  let store: ConversationStore;
  let opus: ModelConfig;
  let gates: Map<string, { open: () => void; promise: Promise<void> }>;
  let requests: { said: string; req: ChatRequest }[];
  let deriveBombs: number;
  let logged: { level: string; msg: string; fields?: Record<string, unknown> }[];

  const gateFor = (name: string) => {
    let g = gates.get(name);
    if (!g) {
      let open!: () => void;
      const promise = new Promise<void>((r) => (open = r));
      g = { open, promise };
      gates.set(name, g);
    }
    return g;
  };

  beforeEach(() => {
    paths = resolvePaths();
    fs.mkdirSync(path.dirname(paths.modelsCacheFile), { recursive: true });
    fs.writeFileSync(
      paths.modelsCacheFile,
      JSON.stringify({ fetchedAt: "2099-01-01T00:00:00.000Z", windows: { [OPUS]: 1_000_000 }, modalities: { [OPUS]: ["text"] }, prices: {}, limits: {} }),
      "utf8",
    );
    workspace = path.join(dir, "work");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "notes.txt"), "the notes\n");
    store = new ConversationStore(path.join(dir, "conversations"), { fsync: false });
    gates = new Map();
    requests = [];
    deriveBombs = 0;
    logged = [];
    const a = addModelConfig(defaultConfig(), {
      name: "opus",
      model: OPUS,
      openRouterKey: KEY_A,
      defaultMode: "code",
      defaultApproval: "full-auto",
      environment: { turnTimestamps: false },
    });
    saveConfig(setBinding(a.config, workspace, a.added.id), paths);
    opus = a.added;
  });

  afterEach(async () => {
    for (const g of gates.values()) g.open();
    await store.close();
  });

  /** The fake agent driver, plus `holdread:<g>`: once gate g opens, call
   *  read_file — so the child's turn has a next request to re-read config for. */
  function makeDriver(): LlmDriver {
    if (deriveBombs > 0) {
      deriveBombs--;
      throw new Error("derive exploded");
    }
    const fake = fakeAgentDriver();
    return {
      async *streamChat(req, opts): AsyncGenerator<StreamEvent> {
        const last = req.messages.at(-1);
        const text = last?.role === "user" && typeof last.content === "string" ? stripEnvironmentDetails(last.content).trim() : "";
        requests.push({ said: text, req });
        // Anchored to a line start: the parent's own "spawn: holdread:g1" must
        // not match — only the child's task, under its attribution header.
        const held = /(?:^|\n)holdread:(\S+)/.exec(text);
        if (held) {
          await gateFor(held[1]!).promise;
          yield { type: "tool_call", index: 0, id: `read_${held[1]}`, name: "read_file", argsDelta: JSON.stringify({ path: "notes.txt" }) };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        yield* fake.streamChat(req, opts);
      },
    };
  }

  function makeServer() {
    const logger = {
      error: (msg: string, fields?: Record<string, unknown>) => logged.push({ level: "error", msg, fields }),
      warn: (msg: string, fields?: Record<string, unknown>) => logged.push({ level: "warn", msg, fields }),
    };
    const catalog = new ModelCatalog({ file: paths.modelsCacheFile });
    const deps = { paths, cwd: workspace, makeDriver, mcpTools: () => [], catalog, logger };
    return createServer({
      resolveConfig: () => resolveForCwd(loadConfig(paths), workspace),
      newSession: createSessionFactory(deps),
      listConfigs: () => loadConfig(paths).modelConfigs,
      store,
      workingDir: workspace,
      version: "0.0.0",
      logger,
    });
  }

  async function startChild(app: ReturnType<typeof makeServer>["app"], manager: ReturnType<typeof makeServer>["manager"]) {
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "spawn: holdread:g1" }),
    });
    const root = manager.get(((await res.json()) as { sessionId: string }).sessionId)!;
    await vi.waitFor(() => expect(requests.some((r) => /(?:^|\n)holdread:g1/.test(r.said))).toBe(true));
    const child = manager.list().find((s) => s.agentInfo?.name === "agent-1")!;
    return { root, child };
  }

  const notices = (s: Session) =>
    s.conversation.entries.filter((e): e is Extract<Entry, { type: "user" }> => e.type === "user" && e.inbound?.kind === "finished");

  it("the incident: config.json goes invalid mid-turn — the child finishes, and the parent hears it finished", async () => {
    const { app, manager, agents } = makeServer();
    const { root, child } = await startChild(app, manager);
    // Joshua saves a half-edited config.json while the child's request is out.
    const good = fs.readFileSync(paths.configFile, "utf8");
    fs.writeFileSync(paths.configFile, good.slice(0, good.length / 2), "utf8");
    gateFor("g1").open();
    await agents.idle();

    expect(child.status).toBe("idle");
    expect(child.restedAs).toBe("finished");
    expect(toolEntries(child).some((t) => t.name === "read_file" && !t.isError)).toBe(true);
    expect(notices(root).map((e) => e.text)).toEqual([expect.stringContaining('"agent-1" has finished its turn')]);
    expect(logged.filter((l) => l.level === "warn" && /config store unreadable/.test(l.msg)).length).toBeGreaterThanOrEqual(1);
    expect(logged.filter((l) => l.level === "error")).toEqual([]);
    fs.writeFileSync(paths.configFile, good, "utf8");
  });

  it("a generic throw mid-turn — the child fails visibly, and the parent hears it failed", async () => {
    const { app, manager, agents } = makeServer();
    const { root, child } = await startChild(app, manager);
    // An edit to the child's config (same model) is re-derived on its next
    // request (D-87) — and that derive throws, once.
    const cfg = loadConfig(paths);
    saveConfig(
      {
        ...cfg,
        modelConfigs: cfg.modelConfigs.map((m) => (m.id === opus.id ? { ...m, systemPromptAddendum: "edited", updatedAt: new Date(Date.now() + 1000).toISOString() } : m)),
      },
      paths,
    );
    const errors: string[] = [];
    child.onEvent((e) => {
      if (e.type === "error") errors.push(e.message);
    });
    deriveBombs = 1;
    gateFor("g1").open();
    await agents.idle();

    expect(child.status).toBe("idle");
    expect(child.restedAs).toBe("failed");
    expect(errors).toEqual([expect.stringContaining("derive exploded")]);
    expect(notices(root).map((e) => e.text)).toEqual([expect.stringContaining('"agent-1" stopped on an error and is idle')]);
    // The parent took a turn on the notice rather than waiting on a ghost.
    expect(root.status).toBe("idle");
    expect(root.conversation.entries.at(-1)?.type).toBe("assistant");
    const fault = logged.find((l) => l.level === "error" && /turn failed on an unexpected error/.test(l.msg));
    expect(fault?.fields).toMatchObject({ conversationId: child.conversation.id });
    expect((fault?.fields?.err as Error).message).toBe("derive exploded");

    // Retry works on the sub-agent too: it finishes the turn it lost.
    await child.retry();
    await agents.idle();
    expect(child.restedAs).toBe("finished");
    expect(child.conversation.entries.at(-1)?.type).toBe("assistant");
  });
});
