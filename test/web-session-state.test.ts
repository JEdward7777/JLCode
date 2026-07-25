/**
 * The browser's per-session state reducer (web/src/session-state.ts) folds the
 * multiplexed bus (D-43) into independent slices so N sessions stay live at once.
 * Tier-0 coverage of the fold: settled snapshots, streaming deltas, tree growth,
 * and the events that flip status/spend/prompt state.
 */
import { describe, it, expect } from "vitest";
import { newSlice, reduceEvent, sliceFromDescriptor, applyState } from "../web/src/session-state";
import type { SessionDescriptor, WireEvent } from "../web/src/api";

describe("session slice from a roster descriptor", () => {
  it("adopts identity + settled state", () => {
    const d: SessionDescriptor = {
      id: "s1",
      model: "gpt-x",
      state: { status: "running", mode: "plan", approval: "auto-safe", spendUsd: 0.5, spendCapUsd: 2, capReached: false },
    };
    const s = sliceFromDescriptor(d);
    expect(s.id).toBe("s1");
    expect(s.model).toBe("gpt-x");
    expect(s.mode).toBe("plan");
    expect(s.approval).toBe("auto-safe");
    expect(s.spendUsd).toBe(0.5);
    expect(s.capUsd).toBe(2);
    expect(s.working).toBe(true); // status running → working
  });

  it("applyState surfaces a pending approval / question", () => {
    const s = applyState(newSlice("s1"), {
      status: "awaiting-approval",
      approvalRequest: { id: "a1", tool: "run_command", kind: "command", args: { command: "ls" }, reason: "policy" },
    });
    expect(s.pendingApproval?.tool).toBe("run_command");
    expect(s.working).toBe(false);
  });

  it("applyState carries the live trigger mode + a pending compaction pause (D-27)", () => {
    const s = applyState(newSlice("s1"), {
      status: "awaiting-compaction",
      triggerMode: "hard",
      needsCompaction: true,
      compactionRequest: { id: "comp1", mode: "hard", cancelable: false, prefixTokens: 900, threshold: 800, window: 1000 },
    });
    expect(s.triggerMode).toBe("hard");
    expect(s.needsCompaction).toBe(true);
    expect(s.pendingCompaction?.cancelable).toBe(false);
  });
});

describe("compaction events fold into the slice (D-27, P6c)", () => {
  it("trigger-mode switches, needs-compaction lights up, compacted clears", () => {
    let s = newSlice("s1");
    s = reduceEvent(s, { type: "trigger-mode", mode: "suggest" } as WireEvent);
    expect(s.triggerMode).toBe("suggest");
    s = reduceEvent(s, { type: "needs-compaction", mode: "suggest", prefixTokens: 1, threshold: 0, window: 2 } as WireEvent);
    expect(s.needsCompaction).toBe(true);
    s = reduceEvent(s, { type: "compacted", entryId: "c1", forced: false, summaryChars: 100 } as WireEvent);
    expect(s.needsCompaction).toBe(false);
    expect(s.pendingCompaction).toBeNull();
  });

  it("awaiting-compaction sets the pause; the held turn starting clears it (Skip path)", () => {
    let s = newSlice("s1");
    s = reduceEvent(s, {
      type: "awaiting-compaction",
      request: { id: "comp1", mode: "cancelable", cancelable: true, prefixTokens: 900, threshold: 800, window: 1000 },
    } as unknown as WireEvent);
    expect(s.pendingCompaction?.cancelable).toBe(true);
    expect(s.working).toBe(false);
    s = reduceEvent(s, { type: "assistant-start" } as WireEvent);
    expect(s.pendingCompaction).toBeNull(); // Skip emits no `compacted`; assistant-start clears it
    expect(s.working).toBe(true);
  });
});

describe("reduceEvent folds live events", () => {
  it("streams reasoning + text into the live overlay, then retires it on the entry", () => {
    let s = newSlice("s1");
    s = reduceEvent(s, { type: "assistant-start" });
    expect(s.working).toBe(true);
    s = reduceEvent(s, { type: "reasoning", delta: "hm" } as WireEvent);
    s = reduceEvent(s, { type: "text", delta: "Hel" } as WireEvent);
    s = reduceEvent(s, { type: "text", delta: "lo" } as WireEvent);
    expect(s.live).toEqual({ text: "Hello", reasoning: "hm" });

    // The assistant entry materializes → the overlay is dropped.
    s = reduceEvent(s, {
      type: "entry",
      entry: { id: "a1", parent: null, type: "assistant", text: "Hello" },
    } as unknown as WireEvent);
    expect(s.live).toBeNull();
    expect(s.entries.map((e) => e.id)).toEqual(["a1"]);
  });

  it("advances the active leaf along the branch being built and dedupes entries", () => {
    let s = newSlice("s1");
    s = reduceEvent(s, { type: "entry", entry: { id: "u1", parent: null, type: "user", text: "q" } } as unknown as WireEvent);
    expect(s.activeLeaf).toBe("u1");
    s = reduceEvent(s, { type: "entry", entry: { id: "a1", parent: "u1", type: "assistant", text: "a" } } as unknown as WireEvent);
    expect(s.activeLeaf).toBe("a1");
    // A duplicate entry frame is ignored.
    s = reduceEvent(s, { type: "entry", entry: { id: "a1", parent: "u1", type: "assistant", text: "a" } } as unknown as WireEvent);
    expect(s.entries.length).toBe(2);
  });

  it("tracks spend, cap, cap-reached and tasks", () => {
    let s = newSlice("s1");
    s = reduceEvent(s, { type: "spend", totalUsd: 1.25 } as WireEvent);
    expect(s.spendUsd).toBe(1.25);
    s = reduceEvent(s, { type: "cap", capUsd: 2 } as WireEvent);
    expect(s.capUsd).toBe(2);
    s = reduceEvent(s, { type: "cap-reached", spendUsd: 2.1, capUsd: 2 } as WireEvent);
    expect(s.capReached).toBe(true);
    expect(s.working).toBe(false);

    s = reduceEvent(s, { type: "task-start", task: { id: "t1", command: "sleep 9", startedAt: 0, status: "running" } } as WireEvent);
    expect(s.tasks.map((t) => t.id)).toEqual(["t1"]);
    s = reduceEvent(s, { type: "task-end", task: { id: "t1", command: "sleep 9", startedAt: 0, status: "killed" } } as WireEvent);
    expect(s.tasks.length).toBe(0);
  });

  it("surfaces awaiting-approval / awaiting-input and clears the overlay", () => {
    let s = reduceEvent(newSlice("s1"), { type: "assistant-start" });
    s = reduceEvent(s, {
      type: "awaiting-approval",
      request: { id: "a1", tool: "write_file", kind: "write", args: {}, reason: "policy" },
    } as unknown as WireEvent);
    expect(s.pendingApproval?.tool).toBe("write_file");
    expect(s.working).toBe(false);
    expect(s.live).toBeNull();
  });

  it("keeps unrelated slices untouched (pure fold)", () => {
    const s = newSlice("s1");
    const next = reduceEvent(s, { type: "spend", totalUsd: 3 } as WireEvent);
    expect(s.spendUsd).toBe(0); // original not mutated
    expect(next.spendUsd).toBe(3);
  });
});
