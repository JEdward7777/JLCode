/**
 * When does a session want you? (X-26)
 *
 * The blip's whole job is "the agent stopped and you weren't looking". That is a
 * **transition**, not a state: a session sitting in `awaiting-approval` is not
 * news every render, and a freshly-opened idle session is not news at all. So
 * this module folds the slice map (D-43) against what it saw last time and
 * reports only the edges.
 *
 * Pure and DOM-free on purpose — `document.hidden`, the clock and the sound all
 * come in as arguments, so the interesting rules (prime-on-first-sight, the
 * caused-it-yourself suppression, the multi-session debounce) are Tier-0
 * testable without a browser. `App` owns the ref this state lives in; `blip.ts`
 * owns making noise.
 */
import type { SessionSlice } from "./session-state";

/** Why a session is asking for you. Ordered by how much it outranks: a stalled
 *  write stops everything (D-46), a pause is a demand, and `idle` is the mildest
 *  — the turn simply landed, which is still "your turn" (X-26's trigger list). */
export type AttentionReason = "fault" | "approval" | "input" | "compaction" | "cap" | "idle";

/**
 * What this session is waiting on right now, or `null` while it is busy.
 *
 * Busy is read off `working` alone — the live flag the stream drives, and the
 * one `applyState` derives from a settled `status: "running"` anyway. Reading
 * `status` directly here would be worse than useless: it is a snapshot that only
 * refreshes when a state frame arrives, so a tab that connected mid-turn would
 * hold "running" long after the turn ended and go silent forever.
 */
export function attentionOf(s: SessionSlice): AttentionReason | null {
  if (s.persistenceFault) return "fault";
  if (s.pendingApproval) return "approval";
  if (s.pendingAsk) return "input";
  if (s.pendingCompaction) return "compaction";
  if (s.capReached) return "cap";
  if (s.working) return null;
  return "idle";
}

/** One blip at most per this window. With N multiplexed sessions settling
 *  together (D-43) — or a compaction pause that lands a beat after the turn it
 *  interrupted — the alternative is a clatter, and a clatter is worse than a
 *  missed note. Two genuinely separate settles further apart than this still get
 *  their own blip. */
export const BLIP_QUIET_MS = 1500;

/** What the watcher remembers between folds. Opaque to callers; hold it in a ref
 *  and hand it straight back. */
export interface AttentionMemory {
  /** Last observation per live session id. A session **absent** from this map
   *  has never been seen, and is primed silently — otherwise every page load
   *  would blip once per already-settled session. */
  seen: Record<string, { reason: AttentionReason | null; seq: number }>;
  /** When the last blip actually sounded (`Date.now()`), for the debounce. */
  lastBlipAt: number;
}

export function newAttentionMemory(): AttentionMemory {
  return { seen: {}, lastBlipAt: 0 };
}

export interface AttentionStep {
  /** Feed this back in next time. */
  memory: AttentionMemory;
  /** Sessions that crossed into wanting you *and* are not the one you are
   *  already looking at. Empty most folds. */
  fired: { id: string; reason: AttentionReason }[];
  /** Make a noise now (i.e. `fired` is non-empty and the debounce allows it).
   *  Still subject to the user's preference — that gate is the caller's. */
  blip: boolean;
  /** Latch the tab-title marker (X-26f): something crossed while the tab was
   *  hidden. Not gated on the sound preference — the marker is the silent half
   *  and costs nothing. */
  mark: boolean;
}

export interface AttentionContext {
  /** The session on screen. A settle you are already watching is not news. */
  focusedId: string | null;
  /** `document.hidden`. */
  hidden: boolean;
  /** `Date.now()`, injected so the debounce is testable. */
  now: number;
}

/**
 * Fold the current slices against memory and report the edges.
 *
 * **Two independent edges, because neither alone is enough.** `settleSeq` is the
 * wire saying "your turn" and is immune to React batching — a turn that starts
 * and finishes inside one render still bumps it, where a before/after look at
 * the *level* would see idle→idle and say nothing (measured in a real background
 * tab: Chrome throttles it hard enough that a whole fake turn collapsed into a
 * single DOM mutation). The level change is the belt to that brace: it catches a
 * session that settled while the SSE bus was disconnected, whose new state
 * arrives in a roster frame that bumps no counter.
 *
 * The suppression rule (X-26e) is the cheap one the row names: an edge is only
 * audible when the tab is hidden **or** it happened somewhere other than the
 * pane you are looking at. Clicking *Compact now* and getting the pause you
 * asked for, on screen, in a focused tab, makes no sound.
 */
export function stepAttention(
  prev: AttentionMemory,
  slices: SessionSlice[],
  ctx: AttentionContext,
): AttentionStep {
  const seen: AttentionMemory["seen"] = {};
  const fired: { id: string; reason: AttentionReason }[] = [];
  for (const s of slices) {
    const reason = attentionOf(s);
    seen[s.id] = { reason, seq: s.settleSeq };
    const before = prev.seen[s.id];
    if (!before) continue; // first sight: adopt the state, say nothing
    // A *different* pending reason counts as much as a new settle (an approval
    // resolved and it immediately asks a question): the demand changed, so it is
    // news again. Still busy → nothing to want you for, whatever the counter did.
    if (reason === null) continue;
    if (s.settleSeq === before.seq && reason === before.reason) continue;
    if (ctx.hidden || s.id !== ctx.focusedId) fired.push({ id: s.id, reason });
  }
  const blip = fired.length > 0 && ctx.now - prev.lastBlipAt >= BLIP_QUIET_MS;
  return {
    // Sessions that closed simply drop out — a re-opened id is a new session and
    // is primed again, which is the honest reading of "never seen".
    memory: { seen, lastBlipAt: blip ? ctx.now : prev.lastBlipAt },
    fired,
    blip,
    mark: fired.length > 0 && ctx.hidden,
  };
}
