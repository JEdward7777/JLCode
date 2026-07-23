import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { computeCost } from "../src/session/spend";
import { Session } from "../src/session/session";
import { scriptedDriver } from "../src/session/fake";
import { ToolRegistry } from "../src/tools/registry";
import { Sandbox } from "../src/tools/sandbox";
import type { Tool } from "../src/tools/types";
import type { ModelConfig } from "../src/config/types";
import type { SessionEvent } from "../src/session/types";
import type { AssistantEntry } from "../src/conversation/types";

const config: ModelConfig = {
  id: "cfg_x",
  name: "Test",
  openRouterKey: "sk",
  model: "m",
  defaultMode: "code",
  defaultApproval: "manual",
  createdAt: "",
  updatedAt: "",
};

const noopTool: Tool = {
  name: "noop",
  kind: "read",
  mutates: false,
  def: { type: "function", function: { name: "noop" } },
  execute: async () => ({ content: "ok" }),
};

/** A driver that loops: a tool call until a tool result comes back, then text.
 *  Each model call reports `costUsd` so spend accrues per turn. */
function loopingDriver(costUsd: number) {
  return scriptedDriver((req) => {
    const last = req.messages[req.messages.length - 1];
    if (last?.role === "tool") {
      return [
        { type: "text", delta: "done" },
        { type: "finish", reason: "stop" },
        { type: "usage", usage: { costUsd } },
      ];
    }
    return [
      { type: "tool_call", index: 0, id: "c1", name: "noop", argsDelta: "{}" },
      { type: "finish", reason: "tool_calls" },
      { type: "usage", usage: { costUsd } },
    ];
  });
}

describe("computeCost (D-33)", () => {
  it("prefers the provider's authoritative costUsd", () => {
    expect(computeCost({ costUsd: 0.0042, promptTokens: 999 }, { promptPerMTok: 1000 })).toBe(0.0042);
  });

  it("falls back to config pricing by token counts", () => {
    // 1M prompt @ $2 + 1M completion @ $6 = $8
    const cost = computeCost({ promptTokens: 1_000_000, completionTokens: 1_000_000 }, { promptPerMTok: 2, completionPerMTok: 6 });
    expect(cost).toBeCloseTo(8, 10);
  });

  it("discounts cached prompt tokens at the cached rate", () => {
    // 1M prompt of which 0.5M cached; prompt $10/Mtok, cached $1/Mtok → 0.5*10 + 0.5*1 = 5.5
    const cost = computeCost(
      { promptTokens: 1_000_000, cachedTokens: 500_000 },
      { promptPerMTok: 10, cachedPromptPerMTok: 1 },
    );
    expect(cost).toBeCloseTo(5.5, 10);
  });

  it("is 0 when neither cost nor pricing is available", () => {
    expect(computeCost({ promptTokens: 100 })).toBe(0);
    expect(computeCost(undefined)).toBe(0);
  });
});

describe("Session spend + cap (D-33)", () => {
  function makeSession(spendCapUsd?: number) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-spend-"));
    const session = new Session({
      config,
      driver: loopingDriver(0.002),
      tools: new ToolRegistry([noopTool]),
      sandbox: new Sandbox([tmp]),
      spendCapUsd,
    });
    return { session, tmp };
  }

  it("accrues whole-tree spend and emits a spend event per turn", async () => {
    const { session } = makeSession();
    const events: SessionEvent[] = [];
    session.onEvent((e) => events.push(e));
    await session.send("go");
    // two model calls (tool turn + final text) at $0.002 each
    expect(session.spendUsd).toBeCloseTo(0.004, 10);
    const spends = events.filter((e) => e.type === "spend");
    expect(spends).toHaveLength(2);
    expect((spends[1] as any).totalUsd).toBeCloseTo(0.004, 10);
  });

  it("declines the next LLM call on cap breach without killing anything", async () => {
    const { session } = makeSession(0.001); // first turn ($0.002) already breaches
    const events: SessionEvent[] = [];
    session.onEvent((e) => events.push(e));
    await session.send("go");
    // Only the first (tool) turn ran; the breach paused before the second call.
    const assistants = session.conversation.entries.filter((e) => e.type === "assistant");
    expect(assistants).toHaveLength(1);
    expect(session.capReached).toBe(true);
    expect(session.status).toBe("idle");
    expect(events.some((e) => e.type === "cap-reached")).toBe(true);
  });

  it("resumes the paused loop when the cap is raised", async () => {
    const { session } = makeSession(0.001);
    await session.send("go");
    expect(session.capReached).toBe(true);
    await session.setSpendCap(1);
    expect(session.capReached).toBe(false);
    const assistants = session.conversation.entries.filter((e) => e.type === "assistant") as AssistantEntry[];
    expect(assistants).toHaveLength(2);
    expect(assistants[1]!.text).toBe("done");
    expect(session.spendUsd).toBeCloseTo(0.004, 10);
  });

  it("recomputes whole-tree spend from stored usage on resume", async () => {
    const { session } = makeSession();
    await session.send("go");
    const conversation = session.conversation;
    // A fresh session resuming this conversation starts at the same total.
    const resumed = new Session({ config, driver: loopingDriver(0.002), conversation });
    expect(resumed.spendUsd).toBeCloseTo(0.004, 10);
  });
});
