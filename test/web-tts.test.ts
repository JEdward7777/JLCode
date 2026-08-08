/**
 * Auto-read and the speech channel (X-13, H-07) — `web/src/tts.ts`.
 *
 * Three halves, all Tier-0 and all pure of the DOM.
 *
 * **The channel** is where H-07 lives. Chrome's `speechSynthesis` was measured
 * in a real browser first (VISUAL-LOG "X-13"), and the fake engine below is
 * built to that measurement rather than to the spec's tidier story: an utterance
 * that is replaced ends with `error: "interrupted"` and **no `end`**; a cold
 * engine can fail one outright with `synthesis-failed`; `start` is asynchronous;
 * and `speaking` was seen reading `true` for an utterance that had already
 * failed. Every test here is a state the old `toggleSpeak` could enter and never
 * leave, because it registered `onend` and nothing else.
 *
 * **The script** (`speechFor`) is *what* gets said — the reason a pause stopped,
 * not the paragraph before it, and never the file body an approval would write.
 *
 * **The trigger** (`stepAutoRead`) is *when* — the focused pane only, primed in
 * silence everywhere else, so that switching sessions never reads out an answer
 * you got twenty minutes ago.
 *
 * What no test here can check is that any of it is intelligible out loud; that
 * needs a voice, and this container has none. See VISUAL-LOG.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createSpeaker,
  newAutoReadMemory,
  plainText,
  speechFor,
  stepAutoRead,
  CANCEL_SETTLE_MS,
  KEEPALIVE_MS,
  PROGRESS_GRACE_MS,
  START_TIMEOUT_MS,
  type SpeechEngine,
  type SpeechUtteranceLike,
  type SpeakerHost,
} from "../web/src/tts";
import { newSlice, reduceEvent, type SessionSlice } from "../web/src/session-state";
import type { EntryView, WireEvent } from "../web/src/api";

// ---------------------------------------------------------------------------
// A fake engine that behaves like the one that was measured
// ---------------------------------------------------------------------------

class FakeEngine implements SpeechEngine {
  speaking = false;
  pending = false;
  paused = false;
  /** Every utterance handed over, in order — including ones never started. */
  spoken: SpeechUtteranceLike[] = [];
  cancels = 0;
  resumes = 0;
  /** Set to make `cancel()` leave `speaking` true for a beat, as a real engine
   *  draining asynchronously would. */
  drainsSlowly = false;

  speak(u: SpeechUtteranceLike): void {
    this.spoken.push(u);
    this.speaking = true;
  }
  cancel(): void {
    this.cancels++;
    if (!this.drainsSlowly) this.speaking = false;
    // The utterance's own terminal event follows the cancel, *later* — which is
    // the ordering that makes the generation counter load-bearing.
  }
  resume(): void {
    this.resumes++;
    this.paused = false;
  }

  get last(): SpeechUtteranceLike {
    const u = this.spoken[this.spoken.length - 1];
    if (!u) throw new Error("nothing was spoken");
    return u;
  }
  /** The engine begins reading it. */
  start(u: SpeechUtteranceLike = this.last): void {
    u.onstart?.();
  }
  /** It reaches the end normally. */
  end(u: SpeechUtteranceLike = this.last): void {
    this.speaking = false;
    u.onend?.();
  }
  /** It stops without ending — the common case, and the one the old code had no
   *  handler for. */
  fail(error: string, u: SpeechUtteranceLike = this.last): void {
    this.speaking = false;
    u.onerror?.({ error });
  }
}

function harness(engine: FakeEngine | null = new FakeEngine()) {
  const host: SpeakerHost = {
    engine: () => engine,
    utterance: (text) => ({ text, onstart: null, onend: null, onerror: null }),
    setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>),
  };
  const speaker = createSpeaker(host);
  const changes: (string | null)[] = [];
  speaker.onChange((k) => changes.push(k));
  return { engine, speaker, changes };
}

describe("the speech channel: nothing is spoken before a gesture (X-13, autoplay)", () => {
  it("refuses to speak until armed, and does not touch the engine", () => {
    const { engine, speaker } = harness();
    expect(speaker.armed()).toBe(false);
    expect(speaker.speak("e1", "Hello.")).toBe(false);
    expect(engine!.spoken).toHaveLength(0);
    expect(speaker.speaking()).toBeNull();
  });

  it("speaks once a gesture has happened — sticky activation, not the click itself", () => {
    // Measured in Chrome: `speak()` with no gesture anywhere in the document's
    // history fails `not-allowed`, but one ordinary click is enough for an
    // utterance fired from a timer fourteen seconds later. That is the whole
    // reason auto-read can work at all: it never fires from a click.
    const { speaker } = harness();
    speaker.arm();
    expect(speaker.speak("e1", "Hello.")).toBe(true);
    expect(speaker.speaking()).toBe("e1");
  });

  it("says nothing when there is no engine, and never throws", () => {
    const { speaker } = harness(null);
    speaker.arm();
    expect(speaker.speak("e1", "Hello.")).toBe(false);
    expect(() => speaker.cancel()).not.toThrow();
  });

  it("says nothing for an empty or whitespace-only reply (X-13 d)", () => {
    const { engine, speaker } = harness();
    speaker.arm();
    expect(speaker.speak("e1", "")).toBe(false);
    expect(speaker.speak("e2", "   \n ")).toBe(false);
    expect(engine!.spoken).toHaveLength(0);
  });
});

describe("the speech channel under fake timers (H-07)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Arm, speak, and let the post-cancel settle elapse so the engine has it. */
  function speaking(text = "A settled answer.", key = "e1") {
    const h = harness();
    h.speaker.arm();
    h.speaker.speak(key, text);
    vi.advanceTimersByTime(CANCEL_SETTLE_MS);
    return h;
  }

  it("never calls speak() in the same task as cancel() — the ~5% dropped utterance", () => {
    // Reproduced in Chrome: 20 replies each replacing the last, one of which was
    // accepted by `speak()` and then never started at all. The old code did
    // `cancel(); …; speak()` in one task on every single click.
    const { engine, speaker } = harness();
    speaker.arm();
    speaker.speak("e1", "One.");
    expect(engine!.spoken).toHaveLength(0); // …not yet
    vi.advanceTimersByTime(CANCEL_SETTLE_MS);
    expect(engine!.spoken).toHaveLength(1);
  });

  it("waits for a slow-draining engine rather than speaking over it", () => {
    const { engine, speaker } = harness();
    engine!.drainsSlowly = true;
    engine!.speaking = true;
    speaker.arm();
    speaker.speak("e1", "One.");
    vi.advanceTimersByTime(CANCEL_SETTLE_MS * 3);
    expect(engine!.spoken).toHaveLength(0); // still draining
    engine!.speaking = false;
    vi.advanceTimersByTime(CANCEL_SETTLE_MS);
    expect(engine!.spoken).toHaveLength(1);
  });

  it("clears the UI when an utterance errors instead of ending — H-07's first half", () => {
    // `error` fires *instead of* `end`, and the shipped code registered only
    // `onend`, so this exact sequence left the ◼ up with nothing being read and
    // auto-read believing it was still busy.
    const { engine, speaker, changes } = speaking();
    engine!.start();
    expect(speaker.speaking()).toBe("e1");
    engine!.fail("synthesis-failed");
    expect(speaker.speaking()).toBeNull();
    expect(changes).toEqual(["e1", null]);
  });

  it("clears the UI on a clean end too", () => {
    const { engine, speaker } = speaking();
    engine!.start();
    engine!.end();
    expect(speaker.speaking()).toBeNull();
  });

  it("cannot be un-set by the utterance it replaced (the late `interrupted`)", () => {
    // Measured ordering: the replaced utterance's terminal event lands ~1ms
    // *after* the replacement has already been registered.
    const { engine, speaker } = speaking("First.", "e1");
    engine!.start();
    const first = engine!.last;
    speaker.speak("e2", "Second.");
    vi.advanceTimersByTime(CANCEL_SETTLE_MS);
    expect(speaker.speaking()).toBe("e2");
    engine!.fail("interrupted", first); // the old one, arriving late
    expect(speaker.speaking()).toBe("e2"); // …and unable to touch the new read
    engine!.end(); // the new one finishes properly
    expect(speaker.speaking()).toBeNull();
  });

  it("gives up on an utterance the engine took and never began", () => {
    const { engine, speaker } = speaking();
    expect(speaker.speaking()).toBe("e1");
    vi.advanceTimersByTime(START_TIMEOUT_MS + 1);
    expect(speaker.speaking()).toBeNull();
    expect(engine!.cancels).toBeGreaterThan(0); // and the engine is reset, not left holding it
  });

  it("does not fire the start watchdog on an utterance that did begin", () => {
    const { engine, speaker } = speaking();
    engine!.start();
    vi.advanceTimersByTime(START_TIMEOUT_MS + 1);
    expect(speaker.speaking()).toBe("e1");
  });

  it("gives up on one that began and then went silent — after the keepalive has had its go", () => {
    const { engine, speaker } = speaking("x".repeat(120));
    engine!.start();
    engine!.paused = true; // Chrome pausing its own queue
    vi.advanceTimersByTime(KEEPALIVE_MS + 1);
    expect(engine!.resumes).toBeGreaterThan(0); // nudged…
    expect(engine!.paused).toBe(false);
    expect(speaker.speaking()).toBe("e1"); // …and given the chance to carry on
    vi.advanceTimersByTime(PROGRESS_GRACE_MS + 120_000);
    expect(speaker.speaking()).toBeNull(); // still no `end` → the read is over
  });

  it("keeps nudging the engine while a long read is in flight", () => {
    // The zero-cost hedge for Chrome's long-utterance stall, chosen over
    // chunking because chunking pays a certain ~300ms gap per sentence.
    const { engine, speaker } = speaking("x".repeat(2000));
    engine!.start();
    vi.advanceTimersByTime(KEEPALIVE_MS * 3 + 10);
    expect(engine!.resumes).toBeGreaterThanOrEqual(3);
    expect(speaker.speaking()).toBe("e1");
  });

  it("stops nudging once the read is over", () => {
    const { engine, speaker } = speaking("x".repeat(2000));
    engine!.start();
    engine!.end();
    const before = engine!.resumes;
    vi.advanceTimersByTime(KEEPALIVE_MS * 5);
    expect(engine!.resumes).toBe(before);
    expect(speaker.speaking()).toBeNull();
  });

  it("cancel() is idempotent and safe with nothing in flight", () => {
    const { speaker, changes } = harness();
    speaker.arm();
    speaker.cancel();
    speaker.cancel();
    expect(speaker.speaking()).toBeNull();
    expect(changes).toEqual([]); // nothing changed, so nothing was announced
  });

  it("an explicit cancel silences the engine and the UI together", () => {
    const { engine, speaker } = speaking();
    engine!.start();
    speaker.cancel();
    expect(speaker.speaking()).toBeNull();
    expect(engine!.cancels).toBeGreaterThan(0);
    engine!.fail("interrupted"); // the cancel's own error, arriving after
    expect(speaker.speaking()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The script
// ---------------------------------------------------------------------------

function entry(id: string, patch: Partial<EntryView> = {}): EntryView {
  return { id, parent: null, type: "assistant", ...patch };
}

/** A slice with a linear branch of entries, active leaf at the end. */
function withBranch(entries: EntryView[], patch: Partial<SessionSlice> = {}): SessionSlice {
  return {
    ...newSlice("s1"),
    entries,
    activeLeaf: entries.length ? entries[entries.length - 1]!.id : null,
    treeLoaded: true,
    ...patch,
  };
}

describe("what a settled session says (speechFor, X-13 b/d)", () => {
  it("reads the last assistant reply on the branch, markdown stripped", () => {
    const s = withBranch([
      entry("u1", { type: "user", text: "hi" }),
      entry("a1", { parent: "u1", text: "## Done\nI edited `src/app.ts`." }),
    ]);
    expect(speechFor(s)).toEqual([{ key: "a1", text: "Done\nI edited src/app.ts." }]);
  });

  it("reads the branch in view, not whatever entry happens to be last in the list", () => {
    // A sibling branch's reply is on screen nowhere; reading it aloud would be a
    // lie about what just happened (H-05's hazard, in audio).
    const s = withBranch(
      [
        entry("u1", { type: "user", text: "hi" }),
        entry("a1", { parent: "u1", text: "the branch you are looking at" }),
        entry("a2", { parent: "u1", text: "the sibling you are not" }),
      ],
      { activeLeaf: "a1" },
    );
    expect(speechFor(s)[0]?.text).toBe("the branch you are looking at");
  });

  it("says nothing for a tool-only turn (X-13 d)", () => {
    const s = withBranch([
      entry("u1", { type: "user", text: "hi" }),
      entry("a1", { parent: "u1", text: "", toolCalls: [{ name: "read_file", arguments: "{}" }] }),
      entry("t1", { parent: "a1", type: "tool", name: "read_file", content: "…" }),
    ]);
    expect(speechFor(s)).toEqual([]);
  });

  it("says nothing at all while the turn is still running — settle, never stream", () => {
    const s = withBranch([entry("a1", { text: "half a sen" })], { working: true });
    expect(speechFor(s)).toEqual([]);
  });

  it("reads the reason a pause stopped, not the paragraph before it", () => {
    const base = withBranch([entry("a1", { text: "some earlier prose" })]);
    const approval = speechFor({
      ...base,
      pendingApproval: {
        id: "ap1",
        tool: "run_command",
        kind: "command",
        args: { command: "npm install" },
        reason: "policy",
      },
    });
    expect(approval).toHaveLength(1);
    expect(approval[0]!.key).toBe("approval:ap1");
    expect(approval[0]!.text).toBe("Approval needed to run run_command: npm install.");
  });

  it("never reads the file body an approval would write", () => {
    const body = "line\n".repeat(300);
    const out = speechFor(
      withBranch([], {
        pendingApproval: { id: "ap2", tool: "write_file", kind: "write", args: { path: "src/a.ts", content: body }, reason: "policy" },
      }),
    );
    expect(out[0]!.text).toBe("Approval needed to run write_file: src/a.ts.");
    expect(out[0]!.text).not.toContain("line");
  });

  it("truncates a very long argument rather than reading a whole command line", () => {
    const out = speechFor(
      withBranch([], {
        pendingApproval: { id: "ap3", tool: "run_command", kind: "command", args: { command: "x".repeat(400) }, reason: "policy" },
      }),
    );
    expect(out[0]!.text.length).toBeLessThan(200);
    expect(out[0]!.text).toContain("…");
  });

  it("reads a question, its options, and numbers them when there are several", () => {
    const one = speechFor(
      withBranch([], { pendingAsk: { id: "q1", questions: [{ question: "Which database?", options: ["sqlite", "postgres"] }] } }),
    );
    expect(one[0]!.key).toBe("ask:q1");
    expect(one[0]!.text).toBe("A question for you. Which database? Options: sqlite, postgres.");

    const many = speechFor(
      withBranch([], {
        pendingAsk: {
          id: "q2",
          questions: [
            { header: "Storage", question: "Which database?" },
            { question: "Run the migration now?" },
          ],
        },
      }),
    );
    expect(many[0]!.text).toContain("Question 1 of 2. Storage. Which database?");
    expect(many[0]!.text).toContain("Question 2 of 2. Run the migration now?");
  });

  it("names the other pauses: compaction, the spend cap, a stalled write", () => {
    expect(speechFor(withBranch([], { pendingCompaction: { id: "c1" } as never }))[0]!.text).toMatch(/context window/i);
    expect(speechFor(withBranch([], { capReached: true, spendUsd: 1.5 }))[0]!.text).toMatch(/spend cap/i);
    const fault = speechFor(withBranch([], { persistenceFault: { id: "f1", filePath: "/x", message: "EACCES", pending: 2 } }));
    expect(fault[0]!.key).toBe("fault:f1");
    expect(fault[0]!.text).toContain("EACCES");
  });

  it("puts a stalled write ahead of everything, exactly as attention does", () => {
    const s = withBranch([entry("a1", { text: "prose" })], {
      persistenceFault: { id: "f1", filePath: "/x", message: "EACCES", pending: 1 },
      pendingApproval: { id: "ap1", tool: "run_command", kind: "command", args: {}, reason: "policy" },
    });
    expect(speechFor(s)[0]!.key).toBe("fault:f1");
  });

  it("offers a failed turn's notice behind the reply, so an error is not silent", () => {
    const s = withBranch([entry("a1", { text: "an earlier reply" })], {
      notice: "provider refused the call",
      noticeKind: "error",
    });
    expect(speechFor(s).map((c) => c.key)).toEqual(["a1", "notice:provider refused the call"]);
  });

  it("never reads a Stop you pressed, or a backoff that has not settled", () => {
    const stopped = withBranch([entry("a1", { text: "an earlier reply" })], {
      notice: "Stopped — aborted the turn and killed all tasks.",
      noticeKind: "stopped",
    });
    expect(speechFor(stopped).map((c) => c.key)).toEqual(["a1"]);
    const retrying = withBranch([entry("a1", { text: "an earlier reply" })], {
      notice: "Provider failed — retrying 2/3 in 4s…",
      noticeKind: "retrying",
    });
    expect(speechFor(retrying).map((c) => c.key)).toEqual(["a1"]);
  });

  it("strips the markdown that would otherwise be read out loud", () => {
    expect(plainText("# Title\n**bold** and `code` and [a link](http://x)")).toBe("Title\nbold and code and a link");
    expect(plainText("before\n```js\nconst x = 1;\n```\nafter")).toBe("before\n code block \nafter");
  });
});

describe("a notice now says what raised it (session-state, for X-13)", () => {
  // `noticeKind` used to distinguish only "retrying". Auto-read needs the rest:
  // the notice *text* cannot tell "the provider refused the call" from "you
  // pressed Stop, and know it", and only one of those is worth saying out loud.
  const fold = (e: WireEvent) => reduceEvent(newSlice("s"), e);

  it("labels each cause", () => {
    expect(fold({ type: "error", message: "boom" } as unknown as WireEvent).noticeKind).toBe("error");
    expect(fold({ type: "halted", reason: "loop cap" } as unknown as WireEvent).noticeKind).toBe("halted");
    expect(fold({ type: "stopped", scope: "hard" } as unknown as WireEvent).noticeKind).toBe("stopped");
    expect(fold({ type: "truncation", message: "dropped 3" } as unknown as WireEvent).noticeKind).toBe("truncation");
    expect(fold({ type: "cap-reached", spendUsd: 1, capUsd: 1 } as unknown as WireEvent).noticeKind).toBe("cap");
    expect(fold({ type: "retrying", message: "502", attempt: 1, of: 3, delayMs: 2000 } as unknown as WireEvent).noticeKind).toBe("retrying");
  });

  it("still retires only the backoff notice when a turn lands", () => {
    // The one behaviour that reads `noticeKind`, unchanged by the widening.
    const retrying = fold({ type: "retrying", message: "502", attempt: 1, of: 3, delayMs: 2000 } as unknown as WireEvent);
    expect(reduceEvent(retrying, { type: "assistant-end" } as WireEvent).notice).toBeNull();
    const truncated = fold({ type: "truncation", message: "dropped 3" } as unknown as WireEvent);
    expect(reduceEvent(truncated, { type: "assistant-end" } as WireEvent).notice).toBe("dropped 3");
  });
});

// ---------------------------------------------------------------------------
// The trigger
// ---------------------------------------------------------------------------

describe("when auto-read speaks (stepAutoRead, X-13 a)", () => {
  const ctx = (focusedId: string | null, enabled = true) => ({ focusedId, enabled });
  const reply = (id: string, text: string) =>
    withBranch([entry("u", { type: "user", text: "hi" }), entry(id, { parent: "u", text })], { id: "s1" });

  it("adopts what a session is already saying on first sight, in silence", () => {
    // Otherwise every page load would read out the last thing on screen.
    const s = reply("a1", "an answer from twenty minutes ago");
    const step = stepAutoRead(newAutoReadMemory(), [s], ctx("s1"));
    expect(step.speak).toBeNull();
  });

  it("reads a reply that lands while you are looking at it", () => {
    const before = reply("a1", "first");
    const m = stepAutoRead(newAutoReadMemory(), [before], ctx("s1")).memory;
    const after = withBranch(
      [entry("u", { type: "user", text: "hi" }), entry("a1", { parent: "u", text: "first" }), entry("a2", { parent: "a1", text: "second" })],
      { id: "s1" },
    );
    const step = stepAutoRead(m, [after], ctx("s1"));
    expect(step.speak).toMatchObject({ id: "s1", key: "a2", text: "second" });
  });

  it("says nothing for a session that is not the one in view", () => {
    // Speech is serial and unattributable — a voice out of nowhere gives no clue
    // which of four panes it came from. A background session blips instead.
    const before = reply("a1", "first");
    const m = stepAutoRead(newAutoReadMemory(), [before], ctx("other")).memory;
    const after = withBranch(
      [entry("u", { type: "user", text: "hi" }), entry("a1", { parent: "u", text: "first" }), entry("a2", { parent: "a1", text: "second" })],
      { id: "s1" },
    );
    expect(stepAutoRead(m, [after], ctx("other")).speak).toBeNull();
  });

  it("does not read out what a session said while you were away, on switching to it", () => {
    const quiet = reply("a1", "first");
    let m = stepAutoRead(newAutoReadMemory(), [quiet], ctx("other")).memory;
    const spoke = withBranch(
      [entry("u", { type: "user", text: "hi" }), entry("a1", { parent: "u", text: "first" }), entry("a2", { parent: "a1", text: "second" })],
      { id: "s1" },
    );
    m = stepAutoRead(m, [spoke], ctx("other")).memory; // it settled in the background
    expect(stepAutoRead(m, [spoke], ctx("s1")).speak).toBeNull(); // now you switch to it
  });

  it("reads nothing out of a tree that has only just loaded", () => {
    // A session in the roster carries no entries until it is first focused, so
    // its entire history arrives in one fold and every word of it looks new.
    const unloaded = withBranch([], { id: "s1", treeLoaded: false });
    let m = stepAutoRead(newAutoReadMemory(), [unloaded], ctx("s1")).memory;
    const loaded = reply("a1", "an answer from last week");
    const step = stepAutoRead(m, [loaded], ctx("s1"));
    expect(step.speak).toBeNull();
    m = step.memory;
    expect(stepAutoRead(m, [loaded], ctx("s1")).speak).toBeNull(); // and stays quiet
  });

  it("keeps priming while the preference is off, so turning it on says nothing back", () => {
    const before = reply("a1", "first");
    let m = stepAutoRead(newAutoReadMemory(), [before], ctx("s1", false)).memory;
    const after = withBranch(
      [entry("u", { type: "user", text: "hi" }), entry("a1", { parent: "u", text: "first" }), entry("a2", { parent: "a1", text: "second" })],
      { id: "s1" },
    );
    m = stepAutoRead(m, [after], ctx("s1", false)).memory; // a turn landed, unheard
    expect(stepAutoRead(m, [after], ctx("s1", true)).speak).toBeNull(); // …and stays unheard
  });

  it("does not re-read the last reply after a turn that had nothing to say", () => {
    // A running turn offers no candidates at all, so a memory that simply took
    // the current list would forget the reply and read it again on the next
    // settle. This is why the memory accumulates.
    const settled = reply("a1", "the answer");
    let m = stepAutoRead(newAutoReadMemory(), [settled], ctx("s1")).memory;
    m = stepAutoRead(m, [{ ...settled, working: true }], ctx("s1")).memory; // a new turn runs
    const toolOnly = withBranch(
      [
        entry("u", { type: "user", text: "hi" }),
        entry("a1", { parent: "u", text: "the answer" }),
        entry("a2", { parent: "a1", text: "", toolCalls: [{ name: "read_file", arguments: "{}" }] }),
      ],
      { id: "s1" },
    );
    expect(stepAutoRead(m, [toolOnly], ctx("s1")).speak).toBeNull();
  });

  it("reads a pause once, not on every fold that follows it", () => {
    const idle = reply("a1", "first");
    let m = stepAutoRead(newAutoReadMemory(), [idle], ctx("s1")).memory;
    const paused: SessionSlice = {
      ...idle,
      pendingAsk: { id: "q1", questions: [{ question: "Which one?" }] },
    };
    const first = stepAutoRead(m, [paused], ctx("s1"));
    expect(first.speak?.key).toBe("ask:q1");
    expect(stepAutoRead(first.memory, [paused], ctx("s1")).speak).toBeNull();
  });

  it("speaks at most one thing per fold, however many sessions settled together", () => {
    // There is one voice. X-26 debounces a clatter of chirps; here the
    // alternative does not exist, which is the point of focused-only.
    const a = reply("a1", "first");
    const b = { ...reply("b1", "first"), id: "s2" };
    let m = stepAutoRead(newAutoReadMemory(), [a, b], ctx("s1")).memory;
    const a2 = withBranch([entry("u", { type: "user", text: "hi" }), entry("a2", { parent: "u", text: "A finished" })], { id: "s1" });
    const b2 = { ...withBranch([entry("v", { type: "user", text: "hi" }), entry("b2", { parent: "v", text: "B finished" })]), id: "s2" };
    const step = stepAutoRead(m, [a2, b2], ctx("s1"));
    expect(step.speak?.id).toBe("s1");
  });

  it("forgets a session that closed, and primes it again if the id comes back", () => {
    const s = reply("a1", "first");
    const m = stepAutoRead(newAutoReadMemory(), [s], ctx("s1")).memory;
    const gone = stepAutoRead(m, [], ctx(null));
    expect(gone.memory.said).toEqual({});
    expect(stepAutoRead(gone.memory, [s], ctx("s1")).speak).toBeNull();
  });
});
