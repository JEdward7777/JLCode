/**
 * P6b — the safe-harbor compaction engine (D-28/D-29/D-38, filling the D-44b
 * over-window hook). Covers the pure instruction/truncation pieces plus the
 * Session engine: cache-reuse summary request, the overlay entry + reset wire,
 * auto-in-loop compaction on a budget crossing, the evolving summary, and the
 * forced compact-and-retry. Tier-1 (offline scripted driver — no live spend).
 */
import { describe, it, expect } from "vitest";
import {
  buildCompactionInstruction,
  truncateToolOutputsForSummary,
  COMPACTION_SECTIONS,
  COMPACTION_MAX_TOKENS,
  SUMMARY_TOOL_OUTPUT_CAP_CHARS,
} from "../src/session/compaction";
import { Session } from "../src/session/session";
import { buildWireMessages } from "../src/conversation/wire";
import type { ModelConfig, CompactionSettings } from "../src/config/types";
import type { ChatMessage, ChatRequest, LlmDriver, StreamEvent, Usage } from "../src/llm/types";
import type { SessionEvent } from "../src/session/types";

const SYS = "SYS";

const baseConfig: ModelConfig = {
  id: "cfg",
  name: "Test",
  openRouterKey: "sk",
  model: "work-model",
  defaultMode: "code",
  defaultApproval: "manual",
  createdAt: "",
  updatedAt: "",
};

function configWith(compaction?: Partial<CompactionSettings>): ModelConfig {
  return { ...baseConfig, compaction: compaction ? { auto: false, ...compaction } : undefined };
}

/** A turn's events with authoritative usage — the ground truth the trigger reads. */
function turn(text: string, usage: Usage): StreamEvent[] {
  return [{ type: "text", delta: text }, { type: "finish", reason: "stop" }, { type: "usage", usage }];
}

/** A summary reply for the compaction call. */
function summary(text: string, usage: Usage = { promptTokens: 500, completionTokens: 40 }): StreamEvent[] {
  return [{ type: "text", delta: text }, { type: "finish", reason: "stop" }, { type: "usage", usage }];
}

/** A driver that plays one scripted step per call (throwing when a step is a
 *  `{throw}`), recording every request it received. Overrunning the script
 *  throws, so a miscounted call fails loudly. */
function sequenceDriver(steps: Array<StreamEvent[] | { throw: string }>) {
  const requests: ChatRequest[] = [];
  let i = 0;
  const driver: LlmDriver = {
    // eslint-disable-next-line require-yield
    async *streamChat(req): AsyncGenerator<StreamEvent> {
      requests.push(req);
      const step = steps[i++];
      if (!step) throw new Error(`sequenceDriver: no step #${i - 1} (script exhausted)`);
      if ("throw" in step) throw new Error(step.throw);
      for (const ev of step) yield ev;
    },
  };
  return { driver, requests };
}

describe("compaction instruction (D-28)", () => {
  it("names every anchored section, in order, and asks for bookend quoting", () => {
    const instr = buildCompactionInstruction();
    for (const s of COMPACTION_SECTIONS) expect(instr).toContain(`## ${s}`);
    // sections appear in the documented order
    const positions = COMPACTION_SECTIONS.map((s) => instr.indexOf(`## ${s}`));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(instr).toContain("near-verbatim");
    expect(instr).toContain("[compaction]");
  });

  it("adds a fold-in line only when a prior summary is present (evolving, D-28)", () => {
    expect(buildCompactionInstruction({ hasPriorSummary: false })).not.toContain("already appears above");
    expect(buildCompactionInstruction({ hasPriorSummary: true })).toContain("already appears above");
  });
});

describe("summary-input truncation (D-44b forced fallback)", () => {
  it("caps oversized tool outputs, keeps the tail + marker, leaves the rest", () => {
    const long = "x".repeat(SUMMARY_TOOL_OUTPUT_CAP_CHARS + 500);
    const msgs: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "u".repeat(SUMMARY_TOOL_OUTPUT_CAP_CHARS + 500) }, // user text is NOT capped
      { role: "tool", tool_call_id: "t1", name: "run", content: long },
      { role: "tool", tool_call_id: "t2", name: "read", content: "short" },
    ];
    const out = truncateToolOutputsForSummary(msgs);
    expect(out[0]).toBe(msgs[0]); // untouched refs when nothing to cap
    expect(out[1]).toBe(msgs[1]); // user text preserved whole
    expect(out[3]).toBe(msgs[3]); // short tool output preserved whole
    expect((out[2].content as string).length).toBeLessThan(long.length);
    expect(out[2].content).toContain("truncated for summary");
    expect(out[2].content as string).toContain("x".repeat(100)); // kept the tail
    expect(msgs[2].content).toBe(long); // input array not mutated
  });
});

describe("Session.compact() — the engine (D-28/D-29)", () => {
  it("folds the branch into an overlay entry via the cache-reuse path", async () => {
    const { driver, requests } = sequenceDriver([
      turn("first answer", { promptTokens: 50, completionTokens: 10 }),
      summary("## Goal\nShip the thing.\n"),
    ]);
    const session = new Session({ config: configWith(), driver, systemPrompt: SYS, contextWindow: 200_000 });
    const events: SessionEvent[] = [];
    session.onEvent((e) => events.push(e));

    await session.send("original request");
    const prefix = buildWireMessages(session.conversation, { system: SYS });
    const ok = await session.compact();
    expect(ok).toBe(true);

    // The overlay entry carries the summary + the replay cut.
    const comp = session.conversation.entries.find((e) => e.type === "compaction");
    expect(comp).toMatchObject({ type: "compaction", replayCut: true });
    expect((comp as { summary: string }).summary).toContain("## Goal");
    expect(session.needsCompaction).toBe(false);
    expect(events.find((e) => e.type === "compacted")).toMatchObject({ forced: false, entryId: comp!.id });
    // Spend was charged for the summary call.
    expect(events.some((e) => e.type === "spend")).toBe(true);

    // Cache-reuse (D-29): the exact live prefix + one ephemeral instruction,
    // tool_choice none, capped output. Nothing about the prefix was reshaped.
    const req = requests[1]!;
    expect(req.tool_choice).toBe("none");
    expect(req.max_tokens).toBe(COMPACTION_MAX_TOKENS);
    expect(req.messages.slice(0, -1)).toEqual(prefix);
    const instr = req.messages[req.messages.length - 1]!;
    expect(instr.role).toBe("user");
    expect(String(instr.content)).toContain("[compaction]");

    // The instruction is ephemeral — it never entered the tree.
    expect(session.conversation.entries.some((e) => e.type === "user" && e.text.includes("[compaction]"))).toBe(false);

    // Wire now replays only system + summary.
    const after = buildWireMessages(session.conversation, { system: SYS });
    expect(after.map((m) => m.role)).toEqual(["system", "user"]);
    expect(String(after[1]!.content)).toContain("Ship the thing");
  });

  it("returns false and makes no call when there is nothing to compact", async () => {
    const { driver, requests } = sequenceDriver([summary("unused")]);
    const session = new Session({ config: configWith(), driver, systemPrompt: SYS, contextWindow: 200_000 });
    expect(await session.compact()).toBe(false);
    expect(requests).toHaveLength(0);
    expect(session.conversation.entries.some((e) => e.type === "compaction")).toBe(false);
  });
});

describe("auto-compaction in the loop (D-44/D-27)", () => {
  it("compacts before the next send once the budget is crossed, then continues", async () => {
    const { driver, requests } = sequenceDriver([
      turn("first answer", { promptTokens: 950, completionTokens: 100 }), // prefix 1050 > threshold 900
      summary("## Goal\nsummarized so far.\n"), // auto compaction on the next send
      turn("second answer", { promptTokens: 20, completionTokens: 5 }), // the turn against the compacted wire
    ]);
    const session = new Session({
      config: configWith({ auto: true, bufferTokens: 100 }),
      driver,
      systemPrompt: SYS,
      contextWindow: 1_000,
    });

    await session.send("one");
    expect(session.needsCompaction).toBe(true); // latched from turn 1

    await session.send("two");
    // Exactly one compaction landed, latch cleared.
    expect(session.conversation.entries.filter((e) => e.type === "compaction")).toHaveLength(1);
    expect(session.needsCompaction).toBe(false);
    // Turn 2 replayed only system + summary (the safe-harbor reset).
    const turn2 = requests[2]!;
    expect(turn2.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(String(turn2.messages[1]!.content)).toContain("summarized so far");
    // …and it produced the second answer coherently.
    expect(session.conversation.entries.some((e) => e.type === "assistant" && e.text === "second answer")).toBe(true);
    expect(session.status).toBe("idle");
  });

  it("does not compact when the trigger mode is not auto (routes to the UI, P6c)", async () => {
    const { driver } = sequenceDriver([
      turn("a", { promptTokens: 950, completionTokens: 100 }),
      turn("b", { promptTokens: 950, completionTokens: 100 }),
    ]);
    const session = new Session({
      config: configWith({ triggerModes: ["manual"], bufferTokens: 100 }),
      driver,
      systemPrompt: SYS,
      contextWindow: 1_000,
    });
    await session.send("one");
    await session.send("two");
    expect(session.conversation.entries.some((e) => e.type === "compaction")).toBe(false);
  });

  it("evolves the summary on a later compaction (D-28)", async () => {
    const { driver, requests } = sequenceDriver([
      turn("first answer", { promptTokens: 50, completionTokens: 10 }),
      summary("## Goal\nfirst summary.\n"),
      turn("second answer", { promptTokens: 50, completionTokens: 10 }),
      summary("## Goal\nupdated summary.\n"),
    ]);
    const session = new Session({ config: configWith(), driver, systemPrompt: SYS, contextWindow: 200_000 });

    await session.send("one");
    await session.compact();
    await session.send("two");
    await session.compact();

    // The second compaction's instruction knew a prior summary was in the prefix.
    const secondInstr = requests[3]!.messages.at(-1)!;
    expect(String(secondInstr.content)).toContain("already appears above");
    // The second summary request replayed the first summary (evolving), not the raw start.
    expect(requests[3]!.messages.some((m) => String(m.content).includes("first summary"))).toBe(true);
    // Wire replays only the latest summary.
    const after = buildWireMessages(session.conversation, { system: SYS });
    expect(after.map((m) => m.role)).toEqual(["system", "user"]);
    expect(String(after[1]!.content)).toContain("updated summary");
    expect(String(after[1]!.content)).not.toContain("first summary");
  });
});

describe("forced over-window compact-and-retry (D-44b)", () => {
  it("compacts on an over-window rejection and retries the turn", async () => {
    const { driver, requests } = sequenceDriver([
      { throw: "This model's maximum context length is 1000 tokens" }, // turn 1 over-window
      summary("## Goal\nrecovered summary.\n"), // forced compaction
      turn("recovered answer", { promptTokens: 30, completionTokens: 5 }), // retry
    ]);
    const session = new Session({
      config: configWith({ bufferTokens: 100, contextLength: 1_000 }),
      driver,
      systemPrompt: SYS,
    });
    const events: SessionEvent[] = [];
    session.onEvent((e) => events.push(e));

    await session.send("a huge message");

    // A forced compaction landed and the turn recovered.
    const comp = session.conversation.entries.find((e) => e.type === "compaction");
    expect(comp).toBeTruthy();
    expect(events.find((e) => e.type === "compacted")).toMatchObject({ forced: true });
    expect(events.find((e) => e.type === "needs-compaction")).toMatchObject({ forced: true });
    expect(session.conversation.entries.some((e) => e.type === "assistant" && e.text === "recovered answer")).toBe(true);
    expect(session.needsCompaction).toBe(false); // cleared by the recovery
    expect(session.status).toBe("idle");
    expect(requests).toHaveLength(3);
  });

  it("gives up cleanly (idle) when even the summary call over-windows", async () => {
    const { driver } = sequenceDriver([
      { throw: "maximum context length exceeded" }, // turn 1
      { throw: "maximum context length exceeded" }, // the forced summary call too
    ]);
    const session = new Session({
      config: configWith({ bufferTokens: 100, contextLength: 1_000 }),
      driver,
      systemPrompt: SYS,
    });
    await session.send("a huge message");
    expect(session.status).toBe("idle"); // not halted — recoverable in principle
    expect(session.needsCompaction).toBe(true); // still flagged; nothing was compacted
    expect(session.conversation.entries.some((e) => e.type === "compaction")).toBe(false);
  });
});
