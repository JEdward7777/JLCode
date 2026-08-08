/**
 * Following the tail of a transcript — and letting go of it (D-71).
 *
 * The defect: the thread scrolled to `scrollHeight` on **every** render caused by
 * a token, an entry, a pause card or a branch move. So scrolling up to re-read
 * something during a streaming reply was undone by the next token — the app was
 * right about the data and wrong about what the human was looking at.
 *
 * The rule everything here encodes: **follow the bottom only while the reader is
 * at the bottom.** Scroll away and the transcript stays where you put it; the
 * new content is counted instead, and a "jump to latest" affordance carries you
 * back. Three things always re-pin, because in each case the reader has just
 * asked to be at the bottom: a **new user message** (you typed it), a **jump**,
 * and a **reset** — a branch switch, a session switch, or a resumed thread whose
 * whole transcript renders at once.
 *
 * Pure and DOM-free on purpose, in the shape `attention.ts` established: the
 * metrics come in as numbers, so "what counts as at the bottom" and "when does a
 * count reset" are Tier-0 testable without a browser. `App` owns the element, the
 * scroll listener and the ref this state lives in.
 */

/** The three numbers a scroll container knows about itself. */
export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * How near the true bottom still counts as *at* the bottom, in CSS pixels.
 *
 * An exact comparison is a trap, not a nicety: on a fractional-DPI display
 * `scrollTop` is fractional and `scrollHeight`/`clientHeight` are rounded, so
 * `scrollTop + clientHeight === scrollHeight` can be false by a fraction of a
 * pixel while the reader is visibly pinned to the bottom — and the transcript
 * would silently stop following for no reason they could see. 24px is also about
 * a line of text, which makes the threshold mean something to a person: nudge the
 * wheel one notch and you have left the tail.
 */
export const BOTTOM_SLACK_PX = 24;

export function atBottom(m: ScrollMetrics, slack: number = BOTTOM_SLACK_PX): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= slack;
}

/** Whether the transcript is following its tail, and how much has landed since
 *  it stopped. `unseen` counts **entries**, not tokens: a reply that is still
 *  streaming is one message in progress, and counting its tokens would produce a
 *  badge that raced upward and meant nothing. */
export interface FollowState {
  pinned: boolean;
  unseen: number;
}

export type FollowEvent =
  /** The container reported where it now is (a user scroll, or our own). */
  | { kind: "scrolled"; metrics: ScrollMetrics }
  /** `added` rendered entries appeared; `fromUser` if any of them is a user turn. */
  | { kind: "content"; added: number; fromUser?: boolean }
  /** The composer sent or queued something. */
  | { kind: "sent" }
  /** "Jump to latest" was pressed. */
  | { kind: "jumped" }
  /** A different thread, branch or session is now on screen. */
  | { kind: "reset" };

export const newFollow = (): FollowState => ({ pinned: true, unseen: 0 });

/** Keep the old object when nothing changed, so a caller can use identity to
 *  decide whether to re-render. */
function settle(prev: FollowState, next: FollowState): FollowState {
  return prev.pinned === next.pinned && prev.unseen === next.unseen ? prev : next;
}

/** Fold one event. Pure: the caller does the scrolling, using `pinned`. */
export function stepFollow(s: FollowState, ev: FollowEvent): FollowState {
  switch (ev.kind) {
    case "scrolled":
      // Reaching the bottom by hand is the same statement as pressing the
      // button, so it clears the count too.
      return settle(s, atBottom(ev.metrics) ? { pinned: true, unseen: 0 } : { pinned: false, unseen: s.unseen });
    case "content":
      // A user turn re-pins wherever the reader was: you just typed it, so the
      // bottom is where you want to be. Otherwise new content either rides the
      // tail we are already following, or is counted and left alone.
      if (ev.fromUser || s.pinned) return settle(s, { pinned: true, unseen: 0 });
      return settle(s, { pinned: false, unseen: s.unseen + Math.max(0, ev.added) });
    case "sent":
    case "jumped":
    case "reset":
      return settle(s, { pinned: true, unseen: 0 });
  }
}

/** What the transcript pane was last looking at, for `isViewSwitch`. */
export interface ViewMark {
  session: string;
  /** The active leaf at that moment; `null` before the first render. */
  leaf: string | null;
}

/**
 * Whether the thread on screen has been *replaced* rather than *extended* — a
 * branch switch (H-05), a session swap, or a resumed thread whose whole
 * transcript renders at once. Only a replacement re-pins; new content on the
 * branch you were already reading must not.
 *
 * **The trap this exists to name.** `activeLeaf` moves on every appended entry
 * (`reduceEvent` walks the tip forward whenever `entry.parent === activeLeaf`),
 * so "the leaf changed" reads as a changed view on every single message — which
 * re-pins the viewport mid-stream, i.e. the exact defect D-71 fixes, wearing a
 * new hat. It was caught in the browser and not by the fold tests, because the
 * comparison lived inline in the component where nothing could reach it; hence
 * this function, and hence the two tests below it.
 *
 * The honest discriminator is not whether the leaf moved but whether the leaf we
 * were reading is **still on the branch now rendered**. A tip advancing keeps
 * every earlier entry on the path; a branch switch does not.
 */
export function isViewSwitch(prev: ViewMark, now: { session: string; onPath: ReadonlySet<string> }): boolean {
  if (prev.session !== now.session) return true;
  // No leaf yet (first render) is not a switch: `newFollow()` already starts
  // pinned, and treating it as one would only re-pin something already pinned.
  if (prev.leaf === null) return false;
  return !now.onPath.has(prev.leaf);
}
