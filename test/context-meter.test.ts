/**
 * X-24 — the context meter's number: how full the window is, continuously.
 *
 * The defect this covers is that the figure existed but only surfaced at the
 * moment it was too late to act on (the compaction card). So the assertions here
 * are mostly about the *uncrossed* case: a turn well under budget must still
 * report a reading, on the session, on the state frame, and on the live bus.
 *
 * Tier-0: scripted offline driver, no spend.
 */
import { describe, it, expect } from "vitest";
import { Session } from "../src/session/session";
import type { ModelConfig } from "../src/config/types";
import type { ChatRequest, LlmDriver, StreamEvent, Usage } from "../src/llm/types";
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

function turn(text: string, usage: Usage): StreamEvent[] {
  return [{ type: "text", delta: text }, { type: "finish", reason: "stop" }, { type: "usage", usage }];
}

function sequenceDriver(steps: StreamEvent[][]) {
  const requests: ChatRequest[] = [];
  let i = 0;
  const driver: LlmDriver = {
    // eslint-disable-next-line require-yield
    async *streamChat(req): AsyncGenerator<StreamEvent> {
      requests.push(req);
      const step = steps[i++];
      if (!step) throw new Error(`sequenceDriver: no step #${i - 1} (script exhausted)`);
      for (const ev of step) yield ev;
    },
  };
  return { driver, requests };
}

describe("contextTokens — the meter's reading (X-24)", () => {
  it("is 0 before anything has been measured", () => {
    const { driver } = sequenceDriver([]);
    const session = new Session({ config: baseConfig, driver, systemPrompt: SYS, contextWindow: 200_000 });
    expect(session.contextTokens).toBe(0);
  });

  it("reports the last turn's ground truth even when the budget is nowhere near crossed", async () => {
    // The whole point of X-24: this turn triggers nothing, and must still read.
    const { driver } = sequenceDriver([turn("hi", { promptTokens: 1200, completionTokens: 300 })]);
    const session = new Session({ config: baseConfig, driver, systemPrompt: SYS, contextWindow: 200_000 });
    await session.send("hello");
    expect(session.needsCompaction).toBe(false); // nowhere near the threshold
    expect(session.contextTokens).toBe(1500); // prompt + completion (D-44)
  });

  it("is announced on the bus every round trip, not only when the budget is crossed", async () => {
    const { driver } = sequenceDriver([turn("hi", { promptTokens: 1200, completionTokens: 300 })]);
    const session = new Session({ config: baseConfig, driver, systemPrompt: SYS, contextWindow: 200_000 });
    const events: SessionEvent[] = [];
    session.onEvent((e) => events.push(e));
    await session.send("hello");
    const ctx = events.filter((e) => e.type === "context");
    expect(ctx).toHaveLength(1);
    expect(ctx[0]).toMatchObject({ tokens: 1500, window: 200_000, threshold: 180_000 });
    // …and nothing said the budget was crossed, which is exactly the case the
    // old surface (the compaction card) could not report.
    expect(events.some((e) => e.type === "needs-compaction")).toBe(false);
  });

  it("still emits a reading when no window is known (nothing to measure against)", async () => {
    const { driver } = sequenceDriver([turn("hi", { promptTokens: 900, completionTokens: 100 })]);
    const session = new Session({ config: baseConfig, driver, systemPrompt: SYS }); // no window
    const events: SessionEvent[] = [];
    session.onEvent((e) => events.push(e));
    await session.send("hello");
    expect(session.compactionBudget()).toBeUndefined();
    const ctx = events.filter((e) => e.type === "context");
    expect(ctx).toHaveLength(1);
    expect(ctx[0]).toMatchObject({ tokens: 1000 });
    expect((ctx[0] as { window?: number }).window).toBeUndefined();
  });

  it("tracks a second turn (it is a reading, not a running total)", async () => {
    const { driver } = sequenceDriver([
      turn("one", { promptTokens: 1000, completionTokens: 200 }),
      turn("two", { promptTokens: 2000, completionTokens: 400 }),
    ]);
    const session = new Session({ config: baseConfig, driver, systemPrompt: SYS, contextWindow: 200_000 });
    await session.send("a");
    expect(session.contextTokens).toBe(1200);
    await session.send("b");
    expect(session.contextTokens).toBe(2400);
  });

  it("survives a resume: derived from the branch, so a loaded conversation reads correctly", async () => {
    const { driver } = sequenceDriver([turn("one", { promptTokens: 5000, completionTokens: 500 })]);
    const first = new Session({ config: baseConfig, driver, systemPrompt: SYS, contextWindow: 200_000 });
    await first.send("a");
    // Same tree, brand-new Session — nothing latched carries over, and the
    // reading must still be right or a resumed thread shows a lying empty meter.
    const resumed = new Session({
      config: baseConfig,
      driver,
      systemPrompt: SYS,
      contextWindow: 200_000,
      conversation: first.conversation,
    });
    expect(resumed.contextTokens).toBe(5500);
  });

  it("falls back to 0 across a compaction cut — the old prefix is no longer sent", async () => {
    const { driver } = sequenceDriver([
      turn("one", { promptTokens: 5000, completionTokens: 500 }),
      turn("SUMMARY", { promptTokens: 5500, completionTokens: 60 }), // the summary call
    ]);
    const session = new Session({ config: baseConfig, driver, systemPrompt: SYS, contextWindow: 200_000 });
    await session.send("a");
    expect(session.contextTokens).toBe(5500);
    const events: SessionEvent[] = [];
    session.onEvent((e) => events.push(e));
    expect(await session.compactNow()).toBe(true);
    // Back to unmeasured: everything above the replay cut is gone, and the
    // summary call's own usage is not this branch's prefix.
    expect(session.contextTokens).toBe(0);
    expect(events.filter((e) => e.type === "context")).toEqual([{ type: "context", tokens: 0 }]);
  });

  it("follows the active leaf: reading a branch with no measured turn reports 0", async () => {
    const { driver } = sequenceDriver([turn("one", { promptTokens: 5000, completionTokens: 500 })]);
    const session = new Session({ config: baseConfig, driver, systemPrompt: SYS, contextWindow: 200_000 });
    await session.send("a");
    const userEntry = session.conversation.entries.find((e) => e.type === "user")!;
    const events: SessionEvent[] = [];
    session.onEvent((e) => events.push(e));
    session.setActiveLeaf(userEntry.id); // rewind above the assistant turn
    expect(session.contextTokens).toBe(0);
    expect(events.some((e) => e.type === "context" && e.tokens === 0)).toBe(true);
  });
});
