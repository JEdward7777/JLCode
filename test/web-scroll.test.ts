/**
 * Following the transcript's tail without stealing it (D-71) —
 * `web/src/scroll.ts`.
 *
 * The defect: the thread scrolled to `scrollHeight` on every render, so reading
 * something further up during a streaming reply was undone by the next token.
 * The rule is "follow the bottom only while the reader is *at* the bottom", and
 * the interesting cases are all about who gets to re-pin: the reader (by
 * scrolling back, or pressing the button), their own new message, and a view
 * change — a branch switch or a resumed thread that renders at once.
 *
 * Tier-0: the reducer takes scroll metrics as three numbers, so none of this
 * needs a DOM. What a real browser had to answer instead is in VISUAL-LOG
 * ("D-71") — that the sticky button sits where it should, and that a stream
 * genuinely stops yanking the viewport.
 */
import { describe, it, expect } from "vitest";
import { atBottom, isViewSwitch, newFollow, stepFollow, BOTTOM_SLACK_PX, type FollowState, type ScrollMetrics } from "../web/src/scroll";

/** A scroll box 400px tall over 2000px of content, `fromBottom` px off the end. */
function at(fromBottom: number): ScrollMetrics {
  return { scrollHeight: 2000, clientHeight: 400, scrollTop: 1600 - fromBottom };
}

/** Fold a list of events, the way the pane does over a session. */
function run(events: Parameters<typeof stepFollow>[1][], from: FollowState = newFollow()): FollowState {
  return events.reduce(stepFollow, from);
}

describe("what counts as at the bottom", () => {
  it("is a threshold, not an equality", () => {
    // The trap this exists to avoid: on a fractional-DPI display `scrollTop` is
    // fractional while the other two are rounded, so exact equality is false by
    // a fraction of a pixel while the reader is visibly pinned.
    expect(atBottom({ scrollHeight: 2000, clientHeight: 400, scrollTop: 1599.6667 })).toBe(true);
    expect(atBottom(at(0))).toBe(true);
    expect(atBottom(at(BOTTOM_SLACK_PX))).toBe(true);
    expect(atBottom(at(BOTTOM_SLACK_PX + 1))).toBe(false);
  });

  it("treats a container shorter than its viewport as at the bottom", () => {
    // Two messages in a tall pane: nothing to scroll, and "not following" would
    // strand the jump button on screen forever.
    expect(atBottom({ scrollHeight: 300, clientHeight: 400, scrollTop: 0 })).toBe(true);
  });

  it("is still at the bottom when the browser overscrolls past the end", () => {
    expect(atBottom({ scrollHeight: 2000, clientHeight: 400, scrollTop: 1640 })).toBe(true);
  });
});

describe("the tail is followed only while the reader is on it", () => {
  it("starts pinned — a thread you just opened should show its end", () => {
    expect(newFollow()).toEqual({ pinned: true, unseen: 0 });
  });

  it("keeps following while new content lands and nobody has moved", () => {
    const s = run([{ kind: "content", added: 3 }, { kind: "content", added: 1 }]);
    expect(s).toEqual({ pinned: true, unseen: 0 });
  });

  it("lets go the moment the reader scrolls away", () => {
    const s = stepFollow(newFollow(), { kind: "scrolled", metrics: at(500) });
    expect(s.pinned).toBe(false);
  });

  it("does not scroll while the reader is away — it counts instead", () => {
    // The headline case: a streaming reply that lands two entries while you are
    // reading something further up.
    const s = run([
      { kind: "scrolled", metrics: at(500) },
      { kind: "content", added: 1 },
      { kind: "content", added: 1 },
    ]);
    expect(s).toEqual({ pinned: false, unseen: 2 });
  });

  it("counts nothing for a render that added no entry", () => {
    // Stream tokens, a pause card, a working word: the effect fires, the count
    // must not creep. `unseen` is entries, never tokens.
    const s = run([{ kind: "scrolled", metrics: at(500) }, { kind: "content", added: 0 }, { kind: "content", added: 0 }]);
    expect(s.unseen).toBe(0);
    expect(s.pinned).toBe(false);
  });
});

describe("getting back to the bottom", () => {
  it("re-pins and clears the count when the button is pressed", () => {
    const away = run([{ kind: "scrolled", metrics: at(500) }, { kind: "content", added: 4 }]);
    expect(stepFollow(away, { kind: "jumped" })).toEqual({ pinned: true, unseen: 0 });
  });

  it("re-pins and clears the count when the reader scrolls back by hand", () => {
    // Scrolling to the end is the same statement as pressing the button, so the
    // badge must not survive it.
    const away = run([{ kind: "scrolled", metrics: at(500) }, { kind: "content", added: 4 }]);
    expect(stepFollow(away, { kind: "scrolled", metrics: at(2) })).toEqual({ pinned: true, unseen: 0 });
  });

  it("keeps the count while the reader moves around but stays away", () => {
    const s = run([
      { kind: "scrolled", metrics: at(500) },
      { kind: "content", added: 2 },
      { kind: "scrolled", metrics: at(900) },
      { kind: "scrolled", metrics: at(120) },
    ]);
    expect(s).toEqual({ pinned: false, unseen: 2 });
  });
});

describe("what always re-pins", () => {
  it("a message the reader just typed", () => {
    const away = run([{ kind: "scrolled", metrics: at(500) }, { kind: "content", added: 3 }]);
    expect(stepFollow(away, { kind: "sent" })).toEqual({ pinned: true, unseen: 0 });
  });

  it("a user turn that arrives as content — the same message from another tab", () => {
    const away = run([{ kind: "scrolled", metrics: at(500) }, { kind: "content", added: 3 }]);
    expect(stepFollow(away, { kind: "content", added: 1, fromUser: true })).toEqual({ pinned: true, unseen: 0 });
  });

  it("an assistant turn does *not* — that is the whole defect", () => {
    const away = stepFollow(newFollow(), { kind: "scrolled", metrics: at(500) });
    expect(stepFollow(away, { kind: "content", added: 1, fromUser: false }).pinned).toBe(false);
  });

  it("a branch switch, a session switch, or a resumed thread rendered at once", () => {
    // A different thread on screen is a fresh read: it lands at its end, and
    // whatever was unseen on the last one is not news about this one.
    const away = run([{ kind: "scrolled", metrics: at(500) }, { kind: "content", added: 7 }]);
    expect(stepFollow(away, { kind: "reset" })).toEqual({ pinned: true, unseen: 0 });
  });
});

describe("identity: an unchanged fold returns the same object", () => {
  it("so a stream of scroll events cannot re-render the pane", () => {
    // Scrolling fires per frame. The pane folds every one of them against a ref
    // and only calls setState on a real change; that only works if `stepFollow`
    // is honest about "nothing moved".
    const pinned = newFollow();
    expect(stepFollow(pinned, { kind: "scrolled", metrics: at(4) })).toBe(pinned);
    expect(stepFollow(pinned, { kind: "content", added: 0 })).toBe(pinned);
    expect(stepFollow(pinned, { kind: "sent" })).toBe(pinned);

    const away = stepFollow(pinned, { kind: "scrolled", metrics: at(500) });
    expect(away).not.toBe(pinned);
    expect(stepFollow(away, { kind: "scrolled", metrics: at(600) })).toBe(away);
    expect(stepFollow(away, { kind: "content", added: 0 })).toBe(away);
  });
});

describe("the sequence the defect report describes, end to end", () => {
  it("a reply streaming while you read further up leaves the view alone", () => {
    let s = newFollow();
    // …you are at the bottom, a turn is running…
    s = stepFollow(s, { kind: "content", added: 1, fromUser: true });
    expect(s.pinned).toBe(true);
    // …you scroll up to re-read something…
    s = stepFollow(s, { kind: "scrolled", metrics: at(800) });
    // …and the reply keeps arriving, token after token, entry after entry.
    for (let i = 0; i < 30; i++) s = stepFollow(s, { kind: "content", added: 0 });
    s = stepFollow(s, { kind: "content", added: 1 });
    for (let i = 0; i < 30; i++) s = stepFollow(s, { kind: "content", added: 0 });
    s = stepFollow(s, { kind: "content", added: 1 });
    expect(s).toEqual({ pinned: false, unseen: 2 });
    // The way back says how much you missed, and clears it.
    expect(stepFollow(s, { kind: "jumped" })).toEqual({ pinned: true, unseen: 0 });
  });
});

/**
 * The trap that the browser caught and this suite could not: the comparison
 * lived inline in `App.tsx`, so nothing could reach it. `activeLeaf` advances on
 * every appended entry, so reading "the leaf changed" as "the view changed"
 * re-pins the viewport on every message — D-71's own defect, one layer up.
 */
describe("a tip that advanced is not a view that changed", () => {
  const path = (...ids: string[]) => ({ session: "s1", onPath: new Set(ids) });

  it("does not call it a switch when the leaf we were on is still on the branch", () => {
    // Reading at entry e2 while the tip walks on to e3, e4 — ordinary streaming.
    expect(isViewSwitch({ session: "s1", leaf: "e2" }, path("e1", "e2", "e3", "e4"))).toBe(false);
  });

  it("calls it a switch when the leaf we were on has left the rendered branch", () => {
    // A fork or a rewind: the entry we were reading is no longer on the path.
    expect(isViewSwitch({ session: "s1", leaf: "e2" }, path("e1", "f1", "f2"))).toBe(true);
  });

  it("calls a different session a switch, whatever the leaf says", () => {
    expect(isViewSwitch({ session: "s1", leaf: "e2" }, { session: "s2", onPath: new Set(["e2"]) })).toBe(true);
  });

  it("is not a switch before the first render has recorded a leaf", () => {
    expect(isViewSwitch({ session: "s1", leaf: null }, path("e1"))).toBe(false);
  });

  it("holds the reader in place across a whole streamed reply, tip advancing each time", () => {
    // The end-to-end shape: scrolled away at e1, then five entries land.
    let s: FollowState = newFollow();
    s = stepFollow(s, { kind: "scrolled", metrics: { scrollTop: 0, scrollHeight: 4000, clientHeight: 600 } });
    let mark = { session: "s1", leaf: "e1" as string | null };
    for (const [i, leaf] of ["e2", "e3", "e4", "e5", "e6"].entries()) {
      const onPath = new Set(["e1", "e2", "e3", "e4", "e5", "e6"].slice(0, i + 2));
      expect(isViewSwitch(mark, { session: "s1", onPath })).toBe(false);
      s = stepFollow(s, { kind: "content", added: 1 });
      mark = { session: "s1", leaf };
    }
    expect(s.pinned).toBe(false);
    expect(s.unseen).toBe(5);
  });
});
