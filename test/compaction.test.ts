/**
 * P6a — compaction trigger detection (D-44/D-27). Pure budget/trigger math plus
 * the Session integration that latches + announces `needs-compaction` from
 * ground-truth usage, one turn late, with no model call. Compaction itself is P6b.
 */
import { describe, it, expect } from "vitest";
import {
  activeTriggerMode,
  applyCompactorFit,
  computeBudget,
  evaluateTrigger,
  isOverWindowError,
  knownPrefixTokens,
  DEFAULT_BUFFER_TOKENS,
  DEFAULT_TRIGGER_MODE,
} from "../src/session/compaction";
import { Session } from "../src/session/session";
import { scriptedDriver, throwingDriver } from "../src/session/fake";
import type { ModelConfig, CompactionSettings } from "../src/config/types";
import type { StreamEvent, Usage } from "../src/llm/types";
import type { SessionEvent } from "../src/session/types";

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

function configWith(compaction?: Partial<CompactionSettings>, model = "work-model"): ModelConfig {
  return {
    ...baseConfig,
    model,
    compaction: compaction ? { auto: false, ...compaction } : undefined,
  };
}

/** A driver whose single turn reports fixed authoritative usage — the ground
 *  truth the trigger reads (D-44). */
function usageDriver(usage: Usage) {
  return scriptedDriver((): StreamEvent[] => [
    { type: "text", delta: "ok" },
    { type: "finish", reason: "stop" },
    { type: "usage", usage },
  ]);
}

describe("compaction budget math (D-27/D-44)", () => {
  it("threshold is window − buffer, defaulting the buffer to ~20K", () => {
    expect(computeBudget(100_000)).toEqual({
      window: 100_000,
      buffer: DEFAULT_BUFFER_TOKENS,
      threshold: 100_000 - DEFAULT_BUFFER_TOKENS,
    });
  });

  it("honors a configured buffer and floors the threshold at 0", () => {
    expect(computeBudget(1_000, 100).threshold).toBe(900);
    expect(computeBudget(50, 100).threshold).toBe(0); // buffer > window → 0, not negative
  });

  it("known prefix is last prompt + completion, tolerant of gaps", () => {
    expect(knownPrefixTokens({ promptTokens: 8_000, completionTokens: 2_000 })).toBe(10_000);
    expect(knownPrefixTokens({ promptTokens: 8_000 })).toBe(8_000);
    expect(knownPrefixTokens(undefined)).toBe(0);
  });

  it("triggers strictly above the threshold (one turn late)", () => {
    const budget = computeBudget(1_000, 100); // threshold 900
    expect(evaluateTrigger({ promptTokens: 800, completionTokens: 200 }, budget).needsCompaction).toBe(true);
    expect(evaluateTrigger({ promptTokens: 700, completionTokens: 200 }, budget).needsCompaction).toBe(false);
    // exactly at the threshold is not over
    expect(evaluateTrigger({ promptTokens: 900, completionTokens: 0 }, budget).needsCompaction).toBe(false);
  });
});

describe("compactor-fit guard (D-44a)", () => {
  const budget = computeBudget(100_000, 20_000); // working threshold 80K

  it("tightens the threshold for a smaller compactor window", () => {
    // compactor window 50K, buffer 20K → 30K, which is tighter than 80K.
    expect(applyCompactorFit(budget, 50_000, 20_000).threshold).toBe(30_000);
  });

  it("leaves the budget unchanged for an equal/larger or unknown compactor", () => {
    expect(applyCompactorFit(budget, 100_000, 20_000).threshold).toBe(80_000);
    expect(applyCompactorFit(budget, 200_000, 20_000).threshold).toBe(80_000);
    expect(applyCompactorFit(budget, undefined, 20_000).threshold).toBe(80_000);
  });
});

describe("active trigger mode (D-27)", () => {
  it("auto wins when set", () => {
    expect(activeTriggerMode({ auto: true })).toBe("auto");
  });
  it("otherwise the first configured mode, else the cancelable default", () => {
    expect(activeTriggerMode({ auto: false, triggerModes: ["hard", "manual"] })).toBe("hard");
    expect(activeTriggerMode({ auto: false })).toBe(DEFAULT_TRIGGER_MODE);
    expect(activeTriggerMode(undefined)).toBe(DEFAULT_TRIGGER_MODE);
  });
});

describe("over-window error recognition (D-44b)", () => {
  it("matches the common provider phrasings", () => {
    expect(isOverWindowError(new Error("This model's maximum context length is 8192 tokens"))).toBe(true);
    expect(isOverWindowError(new Error("prompt is too long: 200000 tokens > 128000"))).toBe(true);
    expect(isOverWindowError(new Error("Please reduce the length of the messages"))).toBe(true);
    expect(isOverWindowError("context_length_exceeded")).toBe(true);
  });
  it("ignores unrelated errors", () => {
    expect(isOverWindowError(new Error("rate limited"))).toBe(false);
    expect(isOverWindowError(new Error("ECONNRESET"))).toBe(false);
  });
});

describe("Session trigger detection (D-44)", () => {
  it("announces needs-compaction from ground-truth usage, one turn late", async () => {
    const session = new Session({
      config: configWith({ bufferTokens: 100 }),
      driver: usageDriver({ promptTokens: 800, completionTokens: 200 }), // prefix 1000
      contextWindow: 1_000, // threshold 900 < 1000
    });
    const events: SessionEvent[] = [];
    session.onEvent((e) => events.push(e));
    await session.send("hi");
    expect(session.needsCompaction).toBe(true);
    const signal = events.find((e) => e.type === "needs-compaction");
    expect(signal).toMatchObject({
      mode: DEFAULT_TRIGGER_MODE,
      prefixTokens: 1_000,
      threshold: 900,
      window: 1_000,
    });
    // Detection only — the turn still completed (the accepted one-turn overshoot).
    expect(session.status).toBe("idle");
    expect(session.conversation.entries.some((e) => e.type === "assistant")).toBe(true);
  });

  it("stays quiet under budget", async () => {
    const session = new Session({
      config: configWith({ bufferTokens: 100 }),
      driver: usageDriver({ promptTokens: 500, completionTokens: 100 }), // prefix 600 < 900
      contextWindow: 1_000,
    });
    const events: SessionEvent[] = [];
    session.onEvent((e) => events.push(e));
    await session.send("hi");
    expect(session.needsCompaction).toBe(false);
    expect(events.some((e) => e.type === "needs-compaction")).toBe(false);
  });

  it("never fires when no window is known", async () => {
    const session = new Session({
      config: configWith({ bufferTokens: 100 }), // no contextLength, no injected window
      driver: usageDriver({ promptTokens: 5_000, completionTokens: 5_000 }),
    });
    await session.send("hi");
    expect(session.compactionBudget()).toBeUndefined();
    expect(session.needsCompaction).toBe(false);
  });

  it("falls back to the config contextLength override", async () => {
    const session = new Session({
      config: configWith({ bufferTokens: 100, contextLength: 1_000 }),
      driver: usageDriver({ promptTokens: 950, completionTokens: 100 }), // 1050 > 900
    });
    await session.send("hi");
    expect(session.needsCompaction).toBe(true);
  });

  it("reports the configured trigger mode (auto)", async () => {
    const session = new Session({
      config: configWith({ auto: true, bufferTokens: 100 }),
      driver: usageDriver({ promptTokens: 950, completionTokens: 100 }),
      contextWindow: 1_000,
    });
    const events: SessionEvent[] = [];
    session.onEvent((e) => events.push(e));
    await session.send("hi");
    expect(events.find((e) => e.type === "needs-compaction")).toMatchObject({ mode: "auto" });
  });

  it("compactor-fit guard triggers earlier for a smaller summarizer", async () => {
    // Working window 1000, buffer 100 → working threshold 900. Prefix 850 would
    // NOT trip the working model, but a 700-window compactor (threshold 600) does.
    const usage = { promptTokens: 700, completionTokens: 150 }; // prefix 850
    const under = new Session({
      config: configWith({ bufferTokens: 100 }),
      driver: usageDriver(usage),
      contextWindow: 1_000,
    });
    await under.send("hi");
    expect(under.needsCompaction).toBe(false); // fits the working model

    const withGuard = new Session({
      config: configWith({ bufferTokens: 100, model: "cheap-compactor" }),
      driver: usageDriver(usage),
      contextWindow: 1_000,
      compactorWindow: 700, // threshold 600 < 850
    });
    await withGuard.send("hi");
    expect(withGuard.needsCompaction).toBe(true);
  });

  it("flags an over-window rejection as forced, without halting (D-44b)", async () => {
    const session = new Session({
      config: configWith({ bufferTokens: 100, contextLength: 1_000 }),
      driver: throwingDriver("This model's maximum context length is 1000 tokens"),
    });
    const events: SessionEvent[] = [];
    session.onEvent((e) => events.push(e));
    await session.send("a huge message");
    expect(session.needsCompaction).toBe(true);
    expect(session.status).toBe("idle"); // not halted — recoverable by compaction
    const signal = events.find((e) => e.type === "needs-compaction");
    expect(signal).toMatchObject({ forced: true, mode: DEFAULT_TRIGGER_MODE });
  });
});
