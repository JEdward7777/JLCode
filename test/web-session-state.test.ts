/**
 * The browser's per-session state reducer (web/src/session-state.ts) folds the
 * multiplexed bus (D-43) into independent slices so N sessions stay live at once.
 * Tier-0 coverage of the fold: settled snapshots, streaming deltas, tree growth,
 * and the events that flip status/spend/prompt state.
 */
import { describe, it, expect } from "vitest";
import { newSlice, reduceEvent, sliceFromDescriptor, applyState, isUnresumable } from "../web/src/session-state";
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

  it("tracks the branch a streaming turn belongs to (H-05)", () => {
    let s = newSlice("s1");
    s = reduceEvent(s, { type: "entry", entry: { id: "u1", parent: null, type: "user", text: "q" } } as unknown as WireEvent);
    s = reduceEvent(s, { type: "assistant-start", parent: "u1" } as unknown as WireEvent);
    // On the turn's branch → the overlay is ours to render.
    expect(s.liveParent).toBe("u1");
    expect(s.activeLeaf).toBe(s.liveParent);
    // Read a sibling mid-turn → the overlay no longer belongs to what's on screen.
    s = reduceEvent(s, { type: "active-leaf", leaf: "other" } as unknown as WireEvent);
    expect(s.activeLeaf).not.toBe(s.liveParent);
    // An entry appended to the turn's branch must not drag the pointer back.
    s = reduceEvent(s, { type: "entry", entry: { id: "a1", parent: "u1", type: "assistant", text: "a" } } as unknown as WireEvent);
    expect(s.activeLeaf).toBe("other");
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

describe("persistence-fault events fold into the slice (D-46)", () => {
  const fault = { id: "p1", filePath: "/data/conv-1.jsonl", message: "ENOSPC: no space left", pending: 3 };

  it("awaiting-persistence stops the live view and raises the blocking banner", () => {
    const s = { ...newSlice("s1"), working: true, live: { text: "partial", reasoning: "" } };
    const next = reduceEvent(s, { type: "awaiting-persistence", fault } as unknown as WireEvent);
    expect(next.persistenceFault).toEqual(fault);
    // The turn was aborted via the hard-stop path, so the in-flight view clears.
    expect(next.working).toBe(false);
    expect(next.live).toBeNull();
  });

  it("persistence-recovered clears it", () => {
    const s = { ...newSlice("s1"), persistenceFault: fault };
    const next = reduceEvent(s, { type: "persistence-recovered", discarded: 0 } as unknown as WireEvent);
    expect(next.persistenceFault).toBeNull();
  });

  it("a settled state carrying a fault restores it (e.g. reconnect mid-fault)", () => {
    const next = applyState(newSlice("s1"), { status: "awaiting-persistence", persistenceFault: fault });
    expect(next.persistenceFault).toEqual(fault);
  });
});

describe("conversation label (X-09)", () => {
  it("folds a title event into the slice", () => {
    let s = newSlice("s1", "some/model");
    expect(s.title).toBeNull();
    s = reduceEvent(s, { type: "title", title: "Fix the SSE hang", source: "auto" } as unknown as WireEvent);
    expect(s.title).toBe("Fix the SSE hang");
    s = reduceEvent(s, { type: "title", title: "What I call it", source: "manual" } as unknown as WireEvent);
    expect(s.title).toBe("What I call it");
  });

  it("takes the title off a settled snapshot, and lets a rename clear back to unnamed", () => {
    let s = applyState(newSlice("s1"), { title: "Named" });
    expect(s.title).toBe("Named");
    s = applyState(s, { status: "idle" }); // a snapshot without the field leaves it alone
    expect(s.title).toBe("Named");
    s = applyState(s, { title: null }); // an untitled thread reports null, not absent
    expect(s.title).toBeNull();
  });
});

describe("isUnresumable (X-12)", () => {
  it("recognizes the pre-H-04 replay rejection in the provider's wording", () => {
    // The message is relayed through /chat's 409 body — there is no typed code
    // to match on, so the string is the contract.
    expect(isUnresumable("Invalid signature in thinking block")).toBe(true);
    expect(isUnresumable("provider error: invalid signature")).toBe(true);
  });

  it("does not condemn a thread over an ordinary failure", () => {
    // Offering "start a fresh thread" for a transient error would throw away a
    // perfectly good conversation, so this must not over-match.
    expect(isUnresumable("no model config selected for the server directory")).toBe(false);
    expect(isUnresumable("session is busy; queue the message instead")).toBe(false);
    expect(isUnresumable("request failed (500)")).toBe(false);
  });
});

describe("retry state (D-57)", () => {
  it("lights the Retry button only on a failure the button can fix", () => {
    let s = reduceEvent(newSlice("s1"), { type: "error", message: "402 Insufficient credits", retryable: true } as unknown as WireEvent);
    expect(s.retryable).toBe(true);
    expect(s.working).toBe(false);
    // An over-window wall or a failed compaction sends a bare error: offering a
    // button there would just fail twice and blame the user for clicking.
    s = reduceEvent(newSlice("s1"), { type: "error", message: "context length exceeded" } as unknown as WireEvent);
    expect(s.retryable).toBe(false);
  });

  it("keeps the button on a tripped breaker, and takes it away once a turn starts", () => {
    let s = reduceEvent(newSlice("s1"), { type: "halted", reason: "3 consecutive failures", retryable: true } as unknown as WireEvent);
    expect(s.retryable).toBe(true);
    s = reduceEvent(s, { type: "assistant-start", parent: null } as unknown as WireEvent);
    expect(s.retryable).toBe(false);
    expect(s.working).toBe(true);
  });

  it("reads an automatic retry as still-working, not as a stall", () => {
    // The user must not "helpfully" retry by hand on top of a retry already in
    // flight, so the backoff says what it is instead of going quiet.
    const s = reduceEvent(newSlice("s1"), {
      type: "retrying",
      attempt: 2,
      of: 3,
      delayMs: 4000,
      message: "503 upstream unavailable",
    } as unknown as WireEvent);
    expect(s.notice).toMatch(/retrying 2\/3 in 4s/);
    expect(s.retryable).toBe(false);
  });

  it("stamps a sign of life on every event, for the hung detector", () => {
    // Silence is the only symptom available: a wedged socket looks exactly like
    // a model thinking hard, so what's timed is "anything at all arriving".
    const before = newSlice("s1");
    before.lastEventAt = 0;
    const s = reduceEvent(before, { type: "text", delta: "hi" } as unknown as WireEvent);
    expect(s.lastEventAt).toBeGreaterThan(0);
  });

  it("takes `retryable` off a settled snapshot, so a reloaded tab still offers it", () => {
    expect(applyState(newSlice("s1"), { retryable: true }).retryable).toBe(true);
    expect(applyState(newSlice("s1"), { status: "idle" }).retryable).toBe(false);
  });
});
