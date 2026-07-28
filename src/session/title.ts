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

/** The ephemeral instruction, appended as a final user message and dropped. */
export function buildTitleInstruction(): string {
  return [
    "Ignore the task for one moment. Name this conversation.",
    "",
    "Reply with a short title — at most 6 words, no quotes, no trailing period,",
    "no preamble. It should say what this thread is about, so it can be told",
    "apart from other threads in a list. Reply with the title and nothing else.",
  ].join("\n");
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
