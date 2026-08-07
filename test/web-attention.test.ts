/**
 * The attention blip (X-26) — `web/src/attention.ts` + `web/src/blip.ts`.
 *
 * Two halves, both Tier-0. The **watcher** decides *when* a session crossed into
 * wanting you: it must prime silently on first sight (or every page load blips
 * once per already-settled session), must stay quiet for a state you caused and
 * are looking at, and must collapse a batch of simultaneous settles into one
 * note. The **blipper** decides *whether a sound is possible*: it must create no
 * audio at all until a user gesture arms it, because that is the rule browsers
 * actually enforce, and a design that ignores it is silent forever.
 *
 * Sound itself is the one thing no test can hear — what is asserted here is the
 * schedule (two ascending notes, ramped, non-overlapping); that it is *audible*
 * was confirmed by ear and logged in VISUAL-LOG.
 */
import { describe, it, expect } from "vitest";
import {
  attentionOf,
  newAttentionMemory,
  stepAttention,
  BLIP_QUIET_MS,
  type AttentionMemory,
} from "../web/src/attention";
import { createBlipper, type BlipAudio } from "../web/src/blip";
import { newSlice, type SessionSlice } from "../web/src/session-state";
import { tabTitle } from "../web/src/workspace";

/** A slice in whatever shape the case needs. */
function slice(id: string, patch: Partial<SessionSlice> = {}): SessionSlice {
  return { ...newSlice(id), ...patch };
}

const approval = { id: "a1", tool: "run_command", kind: "command", args: {}, reason: "policy" } as SessionSlice["pendingApproval"];
const ask = { id: "q1", question: "which one?" } as unknown as SessionSlice["pendingAsk"];

describe("what counts as wanting you (X-26 trigger states)", () => {
  it("is null while the session is working — busy is not a demand", () => {
    expect(attentionOf(slice("s", { working: true }))).toBeNull();
    expect(attentionOf(slice("s", { status: "running" }))).toBeNull();
  });

  it("names every settled-and-waiting state the row lists", () => {
    expect(attentionOf(slice("s", { pendingApproval: approval }))).toBe("approval");
    expect(attentionOf(slice("s", { pendingAsk: ask }))).toBe("input");
    expect(attentionOf(slice("s", { pendingCompaction: { id: "c1" } as never }))).toBe("compaction");
    expect(attentionOf(slice("s", { capReached: true }))).toBe("cap");
    expect(attentionOf(slice("s", { persistenceFault: { id: "f1" } as never }))).toBe("fault");
    // "arguably plain idle" — a finished answer is also your turn, and it is the
    // headline case: the tab is in the background and the agent stopped.
    expect(attentionOf(slice("s"))).toBe("idle");
  });

  it("lets a pause outrank a stale running status", () => {
    // `status` is a settled snapshot that only refreshes on a state frame, so a
    // tab that connected mid-turn can still read "running" at the pause.
    expect(attentionOf(slice("s", { status: "running", pendingApproval: approval }))).toBe("approval");
  });
});

describe("the watcher (stepAttention)", () => {
  const ctx = { focusedId: "other", hidden: true, now: 100_000 };

  it("primes on first sight and says nothing", () => {
    // Every page load sees a roster of sessions that are already idle. Blipping
    // for those would make the feature fire hardest at the one moment you are
    // demonstrably looking at the screen.
    const step = stepAttention(newAttentionMemory(), [slice("a"), slice("b", { pendingApproval: approval })], ctx);
    expect(step.fired).toEqual([]);
    expect(step.blip).toBe(false);
    expect(step.mark).toBe(false);
    expect(step.memory.seen).toEqual({ a: "idle", b: "approval" });
  });

  it("fires on the crossing from working to settled", () => {
    let mem = stepAttention(newAttentionMemory(), [slice("a", { working: true })], ctx).memory;
    const step = stepAttention(mem, [slice("a")], ctx);
    expect(step.fired).toEqual([{ id: "a", reason: "idle" }]);
    expect(step.blip).toBe(true);
    expect(step.mark).toBe(true); // hidden tab → the title marker latches too
  });

  it("does not fire again while the session sits in the same state", () => {
    let mem = stepAttention(newAttentionMemory(), [slice("a", { working: true })], ctx).memory;
    const first = stepAttention(mem, [slice("a", { pendingApproval: approval })], { ...ctx, now: 100_000 });
    expect(first.blip).toBe(true);
    // Streaming events re-render constantly; an unanswered approval must not
    // become a metronome.
    const again = stepAttention(first.memory, [slice("a", { pendingApproval: approval })], { ...ctx, now: 200_000 });
    expect(again.fired).toEqual([]);
    expect(again.blip).toBe(false);
  });

  it("fires when one demand replaces another without passing through busy", () => {
    let mem = stepAttention(newAttentionMemory(), [slice("a", { pendingApproval: approval })], ctx).memory;
    const step = stepAttention(mem, [slice("a", { pendingAsk: ask })], { ...ctx, now: 200_000 });
    expect(step.fired).toEqual([{ id: "a", reason: "input" }]);
  });

  it("stays quiet for a settle you caused and are watching (X-26e)", () => {
    const busy = [slice("a", { working: true })];
    const mem = stepAttention(newAttentionMemory(), busy, { focusedId: "a", hidden: false, now: 0 }).memory;
    // Visible tab, focused session: you clicked Compact and got the pause you
    // asked for, on screen. Noise.
    const quiet = stepAttention(mem, [slice("a", { pendingCompaction: { id: "c" } as never })], {
      focusedId: "a",
      hidden: false,
      now: 10_000,
    });
    expect(quiet.fired).toEqual([]);
    expect(quiet.mark).toBe(false);
  });

  it("still fires for a background session while you watch another", () => {
    const mem = stepAttention(newAttentionMemory(), [slice("a"), slice("b", { working: true })], {
      focusedId: "a",
      hidden: false,
      now: 0,
    }).memory;
    const step = stepAttention(mem, [slice("a"), slice("b")], { focusedId: "a", hidden: false, now: 10_000 });
    expect(step.fired).toEqual([{ id: "b", reason: "idle" }]);
    expect(step.blip).toBe(true);
    expect(step.mark).toBe(false); // the tab is visible; only the sound applies
  });

  it("fires for the focused session too once the tab is hidden", () => {
    const mem = stepAttention(newAttentionMemory(), [slice("a", { working: true })], {
      focusedId: "a",
      hidden: true,
      now: 0,
    }).memory;
    const step = stepAttention(mem, [slice("a")], { focusedId: "a", hidden: true, now: 10_000 });
    expect(step.blip).toBe(true);
  });

  it("plays once for a batch of sessions settling together (X-26d)", () => {
    const busy = ["a", "b", "c"].map((id) => slice(id, { working: true }));
    const mem = stepAttention(newAttentionMemory(), busy, ctx).memory;
    const step = stepAttention(mem, [slice("a"), slice("b"), slice("c")], { ...ctx, now: 200_000 });
    expect(step.fired.map((f) => f.id)).toEqual(["a", "b", "c"]);
    expect(step.blip).toBe(true); // three crossings, one note
  });

  it("debounces a second crossing inside the quiet window, then allows it after", () => {
    let mem: AttentionMemory = stepAttention(newAttentionMemory(), [slice("a", { working: true }), slice("b", { working: true })], ctx)
      .memory;
    const first = stepAttention(mem, [slice("a"), slice("b", { working: true })], { ...ctx, now: 200_000 });
    expect(first.blip).toBe(true);

    const tooSoon = stepAttention(first.memory, [slice("a"), slice("b")], { ...ctx, now: 200_000 + BLIP_QUIET_MS - 1 });
    expect(tooSoon.fired).toHaveLength(1); // it *did* cross…
    expect(tooSoon.blip).toBe(false); // …but the note was already played

    // A suppressed blip must not push the window along, or a stream of settles
    // could keep the gate shut forever.
    expect(tooSoon.memory.lastBlipAt).toBe(200_000);
    const later = stepAttention(tooSoon.memory, [slice("a"), slice("b", { pendingApproval: approval })], {
      ...ctx,
      now: 200_000 + BLIP_QUIET_MS,
    });
    expect(later.blip).toBe(true);
  });

  it("forgets a session that closed", () => {
    const mem = stepAttention(newAttentionMemory(), [slice("a"), slice("b")], ctx).memory;
    const step = stepAttention(mem, [slice("a")], ctx);
    expect(Object.keys(step.memory.seen)).toEqual(["a"]);
  });
});

describe("the tab-title marker (X-26f)", () => {
  it("prefixes the title, leaving X-09/X-10's composition intact", () => {
    expect(tabTitle("JLCode", "Fix the SSE hang", true)).toBe("● Fix the SSE hang — JLCode");
    expect(tabTitle("JLCode", "Fix the SSE hang", false)).toBe("Fix the SSE hang — JLCode");
    expect(tabTitle(null, null, true)).toBe("● JLCode");
  });
});

// ---- the blipper ----

interface Scheduled {
  freq: number;
  type: string;
  start: number;
  stop: number;
  ramps: [number, number][];
}

/** A fake WebAudio that records the schedule. `state` is settable so the
 *  suspended-context case (an unarmed page) is reachable. */
function fakeAudio(state = "suspended") {
  const notes: Scheduled[] = [];
  let resumed = 0;
  const ctx: BlipAudio & { notes: Scheduled[]; resumes: () => number } = {
    get state() {
      return state;
    },
    currentTime: 5,
    destination: "speakers",
    resume: async () => {
      resumed++;
      state = "running";
    },
    createOscillator() {
      const note: Scheduled = { freq: 0, type: "", start: 0, stop: 0, ramps: [] };
      notes.push(note);
      return {
        set type(v: string) {
          note.type = v;
        },
        get type() {
          return note.type;
        },
        frequency: {
          set value(v: number) {
            note.freq = v;
          },
          get value() {
            return note.freq;
          },
        },
        connect: () => {},
        start: (at: number) => (note.start = at),
        stop: (at: number) => (note.stop = at),
      };
    },
    createGain() {
      const note = notes[notes.length - 1]!;
      return {
        gain: {
          value: 0,
          setValueAtTime: () => {},
          linearRampToValueAtTime: (v: number, at: number) => note.ramps.push([v, at]),
        },
        connect: () => {},
      };
    },
    notes,
    resumes: () => resumed,
  };
  return ctx;
}

describe("the blip (X-26a/b)", () => {
  it("creates no audio context at all until it is armed", () => {
    // The autoplay trap: a context built on page load is born `suspended` and
    // never makes a sound. Nothing may be constructed outside a gesture.
    let made = 0;
    const b = createBlipper(() => {
      made++;
      return fakeAudio();
    });
    expect(made).toBe(0);
    expect(b.armed()).toBe(false);
    expect(b.blip()).toBe(false); // and it is a no-op, not a throw
    expect(made).toBe(0);
  });

  it("arms once and resumes a suspended context", () => {
    let made = 0;
    const ctx = fakeAudio();
    const b = createBlipper(() => {
      made++;
      return ctx;
    });
    b.arm();
    expect(made).toBe(1);
    expect(ctx.resumes()).toBe(1);
    expect(b.armed()).toBe(true);
    b.arm(); // idempotent: a second gesture must not build a second context
    expect(made).toBe(1);
  });

  it("schedules two short ascending notes that do not overlap", () => {
    const ctx = fakeAudio("running");
    const b = createBlipper(() => ctx);
    b.arm();
    expect(b.blip()).toBe(true);
    expect(ctx.notes).toHaveLength(2);
    const [first, second] = ctx.notes as [Scheduled, Scheduled];
    expect(first.type).toBe("sine");
    expect(second.freq).toBeGreaterThan(first.freq); // ascending = "ready", not "failed"
    expect(first.start).toBe(ctx.currentTime); // relative to the context clock
    expect(second.start).toBeGreaterThan(first.stop - 0.011); // gap, no overlap
    expect(second.stop - first.start).toBeLessThan(0.3); // a blip, not a chime
    // Ramped at both ends: a sine cut at full gain clicks louder than the note.
    for (const n of [first, second]) {
      expect(n.ramps[0]![0]).toBeGreaterThan(0);
      expect(n.ramps[n.ramps.length - 1]![0]).toBe(0);
      expect(n.ramps[0]![0]).toBeLessThan(0.2); // a notification, not an alert
    }
  });

  it("stays silent (and quiet about it) when WebAudio is unavailable", () => {
    const b = createBlipper(() => {
      throw new Error("no WebAudio");
    });
    expect(() => b.arm()).not.toThrow();
    expect(b.armed()).toBe(false);
    expect(b.blip()).toBe(false);
  });
});
