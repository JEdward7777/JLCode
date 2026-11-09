/**
 * One invariant, every Stop (H-10, P9c): **no user entry is appended, and no
 * turn comes to rest, while the turn's branch tip has a `tool_use` with no
 * result.** Such a branch is D-79's dropped call, and the request it makes is
 * one D-84 found every backend rejecting.
 *
 * Three review rounds found the same defect on three different Stop paths, so
 * this suite does not test paths one by one against a hand-written expectation.
 * It injects a Stop at each point one can land, sends again, and holds every
 * result to the same check (`assertBranchSendable`). A new path that strands a
 * call should fail here without anyone having thought of it.
 *
 * Tier 0: scripted drivers and gated tools; waits are on gates, never clocks.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Session } from "../src/session/session";
import { ToolRegistry } from "../src/tools/registry";
import { fileTools } from "../src/tools/file-tools";
import { Sandbox } from "../src/tools/sandbox";
import { ModeApprovalGate } from "../src/tools/mode-gate";
import { newConversation, appendEntry, pathToLeaf, unansweredToolCalls } from "../src/conversation/tree";
import { endsWithUnansweredToolCall, stripEnvironmentDetails } from "../src/conversation/wire";
import type { ChatMessage, ChatRequest, LlmDriver, StreamEvent, ToolCall } from "../src/llm/types";
import type { ModelConfig } from "../src/config/types";
import type { Tool } from "../src/tools/types";
import { HttpError } from "../src/llm/errors";
import type { AgentHost } from "../src/session/session";

const call = (id: string, name = "read_file"): ToolCall => ({ id, type: "function", function: { name, arguments: "{}" } });

describe("unansweredToolCalls", () => {
  function build() {
    let conv = newConversation();
    const push = (input: Parameters<typeof appendEntry>[1]) => {
      const r = appendEntry(conv, input);
      conv = r.conv;
      return r.entry;
    };
    return { conv: () => conv, push };
  }

  it("is empty with no calls, and when every call has its result", () => {
    const t = build();
    t.push({ type: "user", text: "hi" });
    t.push({ type: "assistant", text: "hello" });
    expect(unansweredToolCalls(t.conv())).toEqual([]);
    t.push({ type: "assistant", text: "", toolCalls: [call("a"), call("b")] });
    t.push({ type: "tool", toolCallId: "a", name: "read_file", content: "x" });
    t.push({ type: "todo", ops: [], by: "agent" }); // todo_write lands its op before its result
    t.push({ type: "tool", toolCallId: "b", name: "read_file", content: "y" });
    expect(unansweredToolCalls(t.conv())).toEqual([]);
  });

  it("names the calls a partly answered batch still owes", () => {
    const t = build();
    t.push({ type: "user", text: "hi" });
    t.push({ type: "assistant", text: "", toolCalls: [call("a"), call("b"), call("c")] });
    t.push({ type: "tool", toolCallId: "b", name: "read_file", content: "x" });
    expect(unansweredToolCalls(t.conv()).map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("is empty once a user entry follows — that branch is past the batch (the damage is already done)", () => {
    const t = build();
    t.push({ type: "assistant", text: "", toolCalls: [call("a")] });
    t.push({ type: "user", text: "later" });
    expect(unansweredToolCalls(t.conv())).toEqual([]);
  });

  it("endsWithUnansweredToolCall sees a partly answered batch, not only a bare call", () => {
    const a: ChatMessage = { role: "assistant", content: null, tool_calls: [call("a"), call("b")] };
    expect(endsWithUnansweredToolCall([a])).toBe(true);
    expect(endsWithUnansweredToolCall([a, { role: "tool", tool_call_id: "a", content: "x" }])).toBe(true);
    const both = [a, { role: "tool", tool_call_id: "a", content: "x" }, { role: "tool", tool_call_id: "b", content: "y" }] as ChatMessage[];
    expect(endsWithUnansweredToolCall(both)).toBe(false);
    // The attachments message rides after the results; it does not hide the gap.
    const img: ChatMessage = { role: "user", content: [{ type: "text", text: "image" }] };
    expect(endsWithUnansweredToolCall([a, { role: "tool", tool_call_id: "a", content: "x" }, img])).toBe(true);
    expect(endsWithUnansweredToolCall([...both, img])).toBe(false);
    expect(endsWithUnansweredToolCall([a, { role: "user", content: "said" }])).toBe(false);
  });
});

// ---- The table.

let dir: string;
let gates: Map<string, { open: () => void; promise: Promise<void>; reached: Promise<void>; reach: () => void }>;
function gate(name: string) {
  let g = gates.get(name);
  if (!g) {
    let open!: () => void;
    let reach!: () => void;
    const promise = new Promise<void>((r) => (open = r));
    const reached = new Promise<void>((r) => (reach = r));
    g = { open, promise, reached, reach };
    gates.set(name, g);
  }
  return g;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-stop-"));
  fs.writeFileSync(path.join(dir, "notes.txt"), "notes\n");
  gates = new Map();
  failed = false;
});
afterEach(() => {
  for (const g of gates.values()) g.open();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Blocks until its gate opens — a long-running tool without a process. */
function gatedTool(name: string, writes: boolean): Tool {
  return {
    name,
    kind: writes ? "write" : "read",
    mutates: writes,
    def: { type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } },
    async execute() {
      gate(name).reach();
      await gate(name).promise;
      return { content: `${name} ran` };
    },
  };
}

const CONFIG: ModelConfig = {
  id: "cfg",
  name: "t",
  openRouterKey: "k",
  model: "m",
  defaultMode: "code",
  defaultApproval: "manual",
  environment: { turnTimestamps: false },
  createdAt: "",
  updatedAt: "",
};

const CONFIG_B: ModelConfig = { ...CONFIG, id: "cfg_b", name: "b", model: "m2" };

const isTitleAsk = (req: ChatRequest) => {
  const last = req.messages.at(-1);
  return typeof last?.content === "string" && last.content.includes("Name this conversation");
};
const said = (req: ChatRequest) => {
  const user = [...req.messages].reverse().find((m) => m.role === "user");
  return typeof user?.content === "string" ? stripEnvironmentDetails(user.content).trim() : "";
};
const calls = (...cs: { id: string; name: string; args?: unknown }[]): StreamEvent[] => [
  ...cs.map((c, index): StreamEvent => ({ type: "tool_call", index, id: c.id, name: c.name, argsDelta: JSON.stringify(c.args ?? {}) })),
  { type: "finish", reason: "tool_calls" },
];
const reply = (t: string): StreamEvent[] => [
  { type: "text", delta: t },
  { type: "finish", reason: "stop" },
];

/** One scripted model for every row, keyed on what the user last said. */
let failed = false;
function driver(log: ChatRequest[]): LlmDriver {
  return {
    async *streamChat(req): AsyncGenerator<StreamEvent> {
      if (isTitleAsk(req)) {
        gate("title").reach();
        await gate("title").promise;
        yield* reply("A title");
        return;
      }
      log.push(req);
      if (req.messages.at(-1)?.role === "tool") {
        // After a title ask the model would have gone on to call more tools —
        // exactly what must not go out after a Stop (row A).
        if (said(req) === "titled") return yield* calls({ id: "t2", name: "read_file", args: { path: "notes.txt" } });
        return yield* reply("done");
      }
      switch (said(req)) {
        case "slow":
          gate("slow").reach();
          await gate("slow").promise;
          return yield* reply("slow done");
        case "read":
          return yield* calls({ id: "r1", name: "read_file", args: { path: "notes.txt" } });
        case "fail":
          if (!failed) {
            failed = true;
            throw new HttpError(400, "OpenRouter 400 Bad Request: boom");
          }
          return yield* reply("recovered");
        case "write":
          return yield* calls({ id: "w1", name: "write_file", args: { path: "out.txt", content: "hi" } }, { id: "w2", name: "read_file", args: { path: "notes.txt" } });
        case "ask":
          return yield* calls({ id: "q1", name: "ask_user", args: { question: "which?" } }, { id: "q2", name: "read_file", args: { path: "notes.txt" } });
        case "batch":
          return yield* calls({ id: "b1", name: "slow_read" }, { id: "b2", name: "read_file", args: { path: "notes.txt" } });
        case "approved":
          return yield* calls({ id: "g1", name: "slow_write" }, { id: "g2", name: "read_file", args: { path: "notes.txt" } });
        case "titled":
          // Text, so the in-loop title ask fires after this batch (X-09).
          yield { type: "text", delta: "working on it" };
          return yield* calls({ id: "t1", name: "read_file", args: { path: "notes.txt" } });
        case "stream":
          yield { type: "text", delta: "let me look" };
          gate("stream").reach();
          await gate("stream").promise;
          return yield* calls({ id: "s1", name: "read_file", args: { path: "notes.txt" } });
        case "cut":
          yield { type: "tool_call", index: 0, id: "c1", name: "read_file", argsDelta: '{"path":"notes.txt"}' };
          yield { type: "finish", reason: "length" };
          return;
        default:
          return yield* reply("ok");
      }
    },
  };
}

function session(log: ChatRequest[], opts: { autoTitle?: boolean; spendCapUsd?: number } = {}) {
  return new Session({
    spendCapUsd: opts.spendCapUsd,
    config: CONFIG,
    driver: driver(log),
    tools: new ToolRegistry([...fileTools(), gatedTool("slow_read", false), gatedTool("slow_write", true)]),
    sandbox: new Sandbox([dir]),
    gate: new ModeApprovalGate("code", "manual"),
    autoTitle: opts.autoTitle,
    // Switchable, so an idle pick can be written over an open tip.
    lookupConfig: (id) => [CONFIG, CONFIG_B].find((c) => c.id === id),
    deriveRetarget: (config) => ({ config, driver: driver(log), watchdogMs: 0, maxToolIterations: 50, acceptsImages: false }),
  });
}

/** The branch in view can be sent on: no call owes a result, no user entry
 *  sits between a call and its result, and no call has two results. */
function assertBranchSendable(s: Session): void {
  const conv = s.conversation;
  expect(unansweredToolCalls(conv, conv.activeLeaf)).toEqual([]);
  const results = new Map<string, number>();
  let open = new Set<string>();
  for (const e of pathToLeaf(conv)) {
    if (e.type === "assistant") {
      expect(open.size, "a model turn over an unanswered call").toBe(0);
      open = new Set((e.toolCalls ?? []).map((c) => c.id));
    } else if (e.type === "tool") {
      results.set(e.toolCallId, (results.get(e.toolCallId) ?? 0) + 1);
      open.delete(e.toolCallId);
    } else if (e.type === "user") {
      expect(open.size, "a user entry under an unanswered call").toBe(0);
    }
  }
  for (const [id, n] of results) expect(n, `results for ${id}`).toBe(1);
  expect(endsWithUnansweredToolCall(s.buildRequest().messages)).toBe(false);
}

/** Send again after the Stop, and hold the result to the same rule. */
async function sendsCleanly(s: Session, log: ChatRequest[], opts: { healedOnSend?: boolean } = {}): Promise<void> {
  if (!opts.healedOnSend) assertBranchSendable(s);
  const before = log.length;
  await s.send("carry on");
  expect(log.length).toBeGreaterThan(before);
  for (const req of log.slice(before)) expect(endsWithUnansweredToolCall(req.messages.slice(0, -1))).toBe(false);
  expect(s.status).toBe("idle");
  assertBranchSendable(s);
}

const resultOf = (s: Session, id: string) => s.conversation.entries.find((e) => e.type === "tool" && e.toolCallId === id);

describe("a Stop at every point it can land leaves the branch sendable", () => {
  for (const scope of ["soft", "hard"] as const) {
    it(`${scope} Stop on an approval card`, async () => {
      const log: ChatRequest[] = [];
      const s = session(log);
      await s.send("write");
      expect(s.status).toBe("awaiting-approval");
      s.stop(scope);
      expect(s.status).toBe("idle");
      expect(resultOf(s, "w1")).toMatchObject({ isError: true, content: expect.stringContaining("stopped by the user") });
      await expect(s.approve({ approve: true })).rejects.toThrow(/No pending approval/);
      await sendsCleanly(s, log);
    });

    it(`${scope} Stop on a question card`, async () => {
      const log: ChatRequest[] = [];
      const s = session(log);
      await s.send("ask");
      expect(s.status).toBe("awaiting-input");
      s.stop(scope);
      expect(resultOf(s, "q1")).toMatchObject({ isError: true });
      expect(resultOf(s, "q2")).toMatchObject({ isError: true });
      await sendsCleanly(s, log);
    });

    it(`${scope} Stop during the in-loop title ask makes no further model call`, async () => {
      const log: ChatRequest[] = [];
      const s = session(log, { autoTitle: true });
      const turn = s.send("titled");
      await gate("title").reached;
      const callsAtStop = log.length;
      s.stop(scope);
      gate("title").open();
      await turn;
      expect(log.length).toBe(callsAtStop); // nothing billed after the Stop
      await sendsCleanly(s, log);
    });

    it(`${scope} Stop on a card while the session is paused on a persistence fault`, async () => {
      const log: ChatRequest[] = [];
      const s = session(log);
      await s.send("write");
      s.raisePersistenceFault({ filePath: "x.jsonl", message: "ENOSPC", pending: 1 });
      expect(s.status).toBe("awaiting-persistence");
      s.stop(scope);
      expect(resultOf(s, "w1")).toMatchObject({ isError: true });
      s.discardPersistence(() => 0);
      await sendsCleanly(s, log);
    });
  }

  it("hard Stop mid-batch: the running call keeps its result, the rest are refused", async () => {
    const log: ChatRequest[] = [];
    const s = session(log);
    const turn = s.send("batch");
    await gate("slow_read").reached;
    s.stop("hard");
    gate("slow_read").open();
    await turn;
    expect(resultOf(s, "b1")).toMatchObject({ isError: false, content: "slow_read ran" });
    expect(resultOf(s, "b2")).toMatchObject({ isError: true, content: expect.stringContaining("stopped by the user") });
    await sendsCleanly(s, log);
  });

  it("soft Stop mid-stream: calls the finished stream made are refused, not run", async () => {
    const log: ChatRequest[] = [];
    const s = session(log);
    const turn = s.send("stream");
    await gate("stream").reached;
    s.stop("soft");
    gate("stream").open();
    await turn;
    expect(resultOf(s, "s1")).toMatchObject({ isError: true, content: expect.stringContaining("stopped by the user") });
    await sendsCleanly(s, log);
  });

  it("hard Stop during an approved call that carried a note: the note does not land under the batch", async () => {
    const log: ChatRequest[] = [];
    const s = session(log);
    await s.send("approved");
    expect(s.status).toBe("awaiting-approval");
    const approving = s.approve({ approve: true, note: "and be quick" });
    await gate("slow_write").reached;
    s.stop("hard");
    gate("slow_write").open();
    await approving;
    expect(resultOf(s, "g1")).toMatchObject({ isError: false }); // it ran; its result stands
    expect(resultOf(s, "g2")).toMatchObject({ isError: true });
    expect(s.conversation.entries.some((e) => e.type === "user" && e.text === "and be quick")).toBe(false);
    await sendsCleanly(s, log);
    // …and it did not survive into the next turn either.
    expect(s.conversation.entries.some((e) => e.type === "user" && e.text === "and be quick")).toBe(false);
  });

  it("a length cut-off mid-call is healed when the next message opens a turn", async () => {
    const log: ChatRequest[] = [];
    const s = session(log);
    await s.send("cut");
    // The pre-existing break: the turn rests with the cut-off call open, and the
    // next message's turn is what answers it.
    expect(unansweredToolCalls(s.conversation).map((c) => c.id)).toEqual(["c1"]);
    await sendsCleanly(s, log, { healedOnSend: true });
    expect(resultOf(s, "c1")).toMatchObject({ isError: true, content: "not run — the conversation continued" });
  });
});

describe("an open tip a later entry sits on top of", () => {
  const assistantWith = (s: Session, id: string) =>
    s.conversation.entries.find((e) => e.type === "assistant" && e.toolCalls?.some((c) => c.id === id))!;

  it("a length cut-off, then a model switch, then a send: the switch does not hide the open call", async () => {
    const log: ChatRequest[] = [];
    const s = session(log);
    await s.send("cut");
    expect(await s.switchModel("cfg_b")).toBe("applied");
    expect(unansweredToolCalls(s.conversation).map((c) => c.id)).toEqual(["c1"]); // seen through the switch
    await sendsCleanly(s, log, { healedOnSend: true });
    expect(log.at(-1)!.model).toBe("m2");
    // The heal landed after the switch: assistant(tc) → switch → result → message.
    const types = pathToLeaf(s.conversation).map((e) => e.type);
    expect(types.slice(1, 5)).toEqual(["assistant", "model-switch", "tool", "user"]);
  });

  it("a rewind onto a call, then a switch, then a send", async () => {
    const log: ChatRequest[] = [];
    const s = session(log);
    await s.send("read");
    s.setActiveLeaf(assistantWith(s, "r1").id);
    s.resyncModel();
    await s.switchModel("cfg_b");
    await sendsCleanly(s, log, { healedOnSend: true });
    expect(resultOf(s, "r1")).toBeDefined();
  });

  it("Retry after rewinding onto a call heals it — a valid request, and a session that is not stuck", async () => {
    const log: ChatRequest[] = [];
    const s = session(log);
    await s.send("read");
    await s.send("fail");
    expect(s.retryable).toBe(true);
    s.setActiveLeaf(assistantWith(s, "r1").id); // the sibling arrows land on a call
    const before = log.length;
    await s.retry();
    expect(s.status).toBe("idle");
    expect(log.length).toBeGreaterThan(before);
    for (const req of log.slice(before)) expect(endsWithUnansweredToolCall(req.messages)).toBe(false);
    assertBranchSendable(s);
    await s.send("still here");
    expect(s.status).toBe("idle");
  });

  it("Compact now over an open call refuses, and sends nothing", async () => {
    const log: ChatRequest[] = [];
    const s = session(log);
    await s.send("cut");
    const errors: string[] = [];
    s.onEvent((e) => {
      if (e.type === "error") errors.push(e.message);
    });
    const before = log.length;
    expect(await s.compactNow()).toBe(false);
    expect(log.length).toBe(before);
    expect(errors[0]).toMatch(/middle of a tool call/);
    expect(s.conversation.entries.some((e) => e.type === "compaction")).toBe(false);
  });
});

describe("a persistence fault over a card", () => {
  it("clears back to the card, so agent traffic queues behind it instead of answering it", async () => {
    const log: ChatRequest[] = [];
    const s = session(log);
    await s.send("write");
    s.raisePersistenceFault({ filePath: "x.jsonl", message: "ENOSPC", pending: 1 });
    expect(await s.retryPersistence(async () => {})).toBe(true);
    expect(s.status).toBe("awaiting-approval");
    expect(s.awaitingApproval).toBeDefined();

    // A child's notice arrives: it waits — it does not open a turn that would
    // answer the person's pending approval for them.
    s.receive({ id: "m1", from: "agent-1", kind: "finished", text: "[Sub-agent finished]" });
    await s.startNext();
    expect(s.status).toBe("awaiting-approval");
    expect(resultOf(s, "w1")).toBeUndefined();
    expect(s.queuedMessages).toHaveLength(1);

    await s.approve({ approve: false, reason: "not now" });
    expect(resultOf(s, "w1")).toMatchObject({ content: expect.stringContaining("denied by user") });
    expect(s.status).toBe("idle");
    assertBranchSendable(s);
  });

  it("discarding the stalled writes restores the card too", async () => {
    const log: ChatRequest[] = [];
    const s = session(log);
    await s.send("ask");
    s.raisePersistenceFault({ filePath: "x.jsonl", message: "ENOSPC", pending: 1 });
    s.discardPersistence(() => 1);
    expect(s.status).toBe("awaiting-input");
    expect(s.awaitingInput).toBeDefined();
  });
});

describe("a spend-cap raise under a persistence fault", () => {
  const FAULT = { filePath: "x.jsonl", message: "ENOSPC", pending: 1 };
  /** A stub tree whose `admit` the test answers. */
  function inTree(s: Session) {
    let slot = false;
    const host: AgentHost = {
      spawn: async () => "",
      send: () => "",
      listModels: () => "",
      admit: () => slot,
      treeSpendUsd: (x) => x.spendUsd,
      subtree: () => ({ agents: 0, running: 0, queued: 0, waiting: 0, spendUsd: 0 }),
    };
    s.setAgentHost(host, { name: "agent-1", depth: 1, parentSessionId: "p", rootSessionId: "p" });
    return { open: () => (slot = true) };
  }
  async function parkedUnderFault(log: ChatRequest[], tree = false) {
    const s = session(log, { spendCapUsd: 0 });
    const t = tree ? inTree(s) : undefined;
    await s.send("hi");
    expect(s.capReached).toBe(true);
    expect(log).toHaveLength(0);
    s.raisePersistenceFault(FAULT);
    expect(s.status).toBe("awaiting-persistence");
    return { s, t };
  }

  it("records the cap but resumes nothing; recovery resumes the park it freed", async () => {
    const log: ChatRequest[] = [];
    const { s } = await parkedUnderFault(log);
    await s.setSpendCap(100);
    expect(s.spendCapUsd).toBe(100);
    expect(log).toHaveLength(0); // no model call under the fault
    expect(s.status).toBe("awaiting-persistence");
    expect(s.capReached).toBe(true); // the park is kept
    expect(await s.retryPersistence(async () => {})).toBe(true);
    await s.recovered;
    expect(log).toHaveLength(1); // resumed, once
    expect(s.status).toBe("idle");
    expect(s.capReached).toBe(false);
  });

  it("in a tree with no slot: neither queued under the fault, and queued (not lost) after it", async () => {
    const log: ChatRequest[] = [];
    const { s, t } = await parkedUnderFault(log, true);
    await s.setSpendCap(100);
    expect(s.status).toBe("awaiting-persistence");
    s.discardPersistence(() => 1);
    await s.recovered;
    expect(s.status).toBe("queued"); // went through admit, like any raise
    expect(log).toHaveLength(0);
    t!.open();
    await s.startQueued();
    expect(log).toHaveLength(1);
    expect(s.status).toBe("idle");
  });

  it("a park the cap still blocks at recovery stays parked for the next raise", async () => {
    const log: ChatRequest[] = [];
    const { s } = await parkedUnderFault(log);
    s.discardPersistence(() => 1);
    await s.recovered;
    expect(s.status).toBe("idle");
    expect(s.capReached).toBe(true);
    expect(log).toHaveLength(0);
    await s.setSpendCap(100);
    expect(log).toHaveLength(1);
  });

  it("recovery answers as soon as the fault clears; the resumed turn runs on without it", async () => {
    const log: ChatRequest[] = [];
    const s = session(log, { spendCapUsd: 0 });
    await s.send("slow");
    s.raisePersistenceFault(FAULT);
    await s.setSpendCap(100);
    expect(s.discardPersistence(() => 1)).toBe(1); // returns while the turn is still to run
    await gate("slow").reached;
    expect(s.status).toBe("running");
    gate("slow").open();
    await s.recovered;
    expect(s.status).toBe("idle");
    expect(log).toHaveLength(1);
  });

  it("two recoveries racing: the late one does not write idle over the live resumed turn", async () => {
    const log: ChatRequest[] = [];
    const s = session(log, { spendCapUsd: 0 });
    await s.send("slow");
    s.raisePersistenceFault(FAULT);
    await s.setSpendCap(100);
    let release!: () => void;
    const first = s.retryPersistence(() => new Promise<void>((r) => (release = r))); // tab A, writes still retrying
    expect(await s.retryPersistence(async () => {})).toBe(true); // tab B clears it and resumes
    await gate("slow").reached;
    expect(s.status).toBe("running");
    release();
    expect(await first).toBe(true); // A succeeded — but has nothing left to restore
    expect(s.status).toBe("running");
    await expect(s.send("a second turn")).rejects.toThrow(/busy/);
    gate("slow").open();
    await s.recovered;
    expect(s.status).toBe("idle");
    expect(s.conversation.entries.filter((e) => e.type === "assistant")).toHaveLength(1);
    expect(log).toHaveLength(1);
  });

  it("a late recovery whose fault was replaced by a newer one leaves the newer fault standing", async () => {
    const log: ChatRequest[] = [];
    const s = session(log);
    await s.send("hi");
    s.raisePersistenceFault(FAULT);
    let release!: () => void;
    const first = s.retryPersistence(() => new Promise<void>((r) => (release = r)));
    s.discardPersistence(() => 1);
    s.raisePersistenceFault({ ...FAULT, message: "EIO" }); // a new fault, a new identity
    release();
    expect(await first).toBe(true);
    expect(s.status).toBe("awaiting-persistence");
    expect(s.awaitingPersistence?.message).toBe("EIO");
  });

  it("agent messages that arrived during a fault start their turn when it clears", async () => {
    const log: ChatRequest[] = [];
    const s = session(log);
    const t = inTree(s);
    t.open();
    await s.send("hi");
    const before = log.length;
    s.raisePersistenceFault(FAULT);
    s.receive({ id: "m1", from: "root", kind: "message", text: '[Message from your parent agent "root"]\n\nany news?' });
    await s.startNext(); // not idle: it waits
    expect(log.length).toBe(before);
    expect(await s.retryPersistence(async () => {})).toBe(true);
    await s.recovered;
    expect(log.length).toBe(before + 1); // the child ran it
    expect(s.queuedMessages).toHaveLength(0);
    expect(s.conversation.entries.at(-2)).toMatchObject({ type: "user", inbound: { id: "m1" } });
    expect(s.status).toBe("idle");
  });
});
