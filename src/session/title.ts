/**
 * Conversation titles (X-09). The history list and the session rail showed only
 * opaque ids, so threads were indistinguishable. Joshua's design: after the
 * first exchange, tag an **ephemeral** question onto the end of the live
 * conversation asking the active model for a short title — it is never appended
 * to the tree, so nothing has to be flattened or re-sent in a different shape,
 * and the same prompt-cache reuse that makes same-model compaction cheap (D-29)
 * applies here too. These are the pure pieces: the instruction and the cleanup
 * of whatever the model says back.
 */

/** Small on purpose — a title is a handful of words, and this call is billed. */
export const TITLE_MAX_TOKENS = 64;

/** Longest title we keep; the rail and the tab strip are both narrow. */
export const TITLE_MAX_CHARS = 60;

/** The ephemeral instruction, appended as a final user message and dropped.
 *  With a `current` name it becomes the **re**-title question (X-17): the model
 *  is shown the name the thread already carries and told it may keep it, so an
 *  undrifted thread answers with the name it has and nothing is rewritten. */
export function buildTitleInstruction(current?: string): string {
  const lines = ["Ignore the task for one moment. Name this conversation.", ""];
  if (current) {
    lines.push(
      `This conversation is currently named "${current}". If that still describes what it`,
      "is about, reply with exactly that name. Only rename it if the thread has moved on",
      "to something the name no longer covers.",
      "",
    );
  }
  lines.push(
    "Reply with a short title — at most 6 words, no quotes, no trailing period,",
    "no preamble. It should say what this thread is about, so it can be told",
    "apart from other threads in a list. Reply with the title and nothing else.",
  );
  return lines.join("\n");
}

// ---- Re-titling on drift (X-17) ----------------------------------------------
//
// A thread is named from its opening exchange and then keeps working; the label
// stops describing what it became. Re-titling fixes that, but **every re-title
// is a billed model call**, so the whole design is in *when* to ask. Two rules,
// both measured against the branch position at the moment the current name was
// chosen (`TitleMark`):
//
//   1. **Geometric growth.** The thread must have roughly *doubled* in user
//      turns since it was last named, and grown by at least a floor of turns.
//      Cost over a thread of T turns is ~log2(T) calls — a 200-turn thread pays
//      about eight, not two hundred. The longer a thread runs, the more it has
//      to grow before it is worth asking again, which is also the honest model
//      of drift: three new turns on top of forty change little.
//   2. **A compaction is drift.** A fold is the system saying the early topic is
//      no longer being sent; that is the strongest "this is a different thread
//      now" signal we have, and it arrives beside a summarization call that
//      costs far more than the title, so the marginal spend is noise.
//
// The cheap-but-not-free part is D-29's trick: the question rides the live
// prefix, so the provider serves it from prompt cache (D-26 breakpoints) and
// only the instruction + ~6 words of output are billed at full rate.

/** How much a thread must grow, in user turns, before it is worth re-asking. */
export const RETITLE_GROWTH = 2;

/** …and never sooner than this many new user turns, so short threads don't
 *  re-title on turn two just because doubling one is easy. */
export const RETITLE_MIN_TURNS = 6;

/** Where a branch stood when the current title was chosen (X-17). Both counts
 *  are read off the *active branch*, so a fork or a rewind is measured on the
 *  branch actually in view rather than against the whole tree. */
export interface TitleMark {
  /** User entries on the branch. */
  turns: number;
  /** Compaction overlays on the branch. */
  folds: number;
}

/** Has the thread drifted far enough from `mark` to spend another title call?
 *  Pure so the trigger policy — the part that costs money — is testable without
 *  a driver, a session or a clock. */
export function driftedEnough(mark: TitleMark, now: TitleMark): boolean {
  if (now.folds > mark.folds) return true; // a fold is the topic changing (rule 2)
  return now.turns >= mark.turns + RETITLE_MIN_TURNS && now.turns >= mark.turns * RETITLE_GROWTH;
}

/** Turn a model's answer into a usable label, or "" if there's nothing usable.
 *  Models like to oblige with `Title: "Fixing the SSE hang."` — strip the
 *  wrapping rather than storing the decoration. */
export function sanitizeTitle(raw: string, maxChars = TITLE_MAX_CHARS): string {
  const firstLine = raw
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (!firstLine) return "";
  let text = firstLine.replace(/^(?:title|conversation title)\s*[:\-–]\s*/i, "");
  text = text.replace(/^["'`“”‘’*_#\s]+/, "").replace(/["'`“”‘’*_\s]+$/, "");
  text = text.replace(/\s+/g, " ").replace(/\.+$/, "").trim();
  if (text.length <= maxChars) return text;
  // Clamp on a word boundary when there is one reasonably near the end.
  const cut = text.slice(0, maxChars);
  const space = cut.lastIndexOf(" ");
  return (space > maxChars * 0.6 ? cut.slice(0, space) : cut).trimEnd() + "…";
}
