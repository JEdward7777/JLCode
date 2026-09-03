/**
 * Provider-side prompt-cache breakpoints (D-26).
 *
 * This is the *input-token* discount the provider gives for a repeated prefix —
 * distinct from the local content-addressed response cache (D-24). Anthropic
 * bills a cached prefix at ~0.1x input, and a cache write at 1.25x, so on a long
 * agentic conversation (where every turn resends the whole transcript) this is
 * the single biggest cost lever there is.
 *
 * Placement lives *here*, at the wire boundary, and deliberately not in
 * `buildWireMessages`: `requestSignature` (D-24) hashes `req.messages`, so
 * markers in the transcript would change every local cache key and throw away a
 * test cache we paid real money for. The transcript carries no `cache_control`;
 * the marker is a wire detail. (Since P8b the transcript *can* carry content
 * parts — an attachment message, D-78f — so "plain strings" is no longer the
 * distinction; "no marker" still is.)
 *
 * Wire format is a *content-part* field, not a message field. OpenRouter passes
 * `cache_control` through on individual content blocks:
 *
 *     {"role":"system","content":[{"type":"text","text":"…",
 *                                  "cache_control":{"type":"ephemeral"}}]}
 *
 * A `cache_control` on the message object itself — which is what `ChatMessage`
 * has carried since D-26 was written — is silently ignored by the provider. That
 * is exactly the bug this file fixes: JLCode declared the field, never set it,
 * and would have had it ignored anyway.
 */
import type { ChatMessage, ContentPart } from "./types.js";

/**
 * A content part as it goes on the wire: a transcript part (D-78f) plus the
 * marker, which exists only out here. A `cache_control` in the transcript would
 * change `requestSignature` and throw away a test cache we paid real money for —
 * the reason placement lives in this file at all.
 */
export type WirePart = ContentPart & { cache_control?: { type: "ephemeral" } };

/** A message as it goes on the wire: content may be parts once we mark it. */
export type WireMessage = Omit<ChatMessage, "content"> & {
  content: string | WirePart[] | null;
};

/**
 * Anthropic allows at most 4 breakpoints per request. We spend 3 and leave one
 * spare:
 *
 *   1. the system message — the stable tools+system prefix (tools render before
 *      system, so a marker here covers both);
 *   2. an *anchor* one turn back — the read point. The newest turn's content is
 *      by definition not cached yet, so without this the read would have to come
 *      from the previous request's trailing marker; keeping our own anchor makes
 *      the hit independent of how the last turn happened to be shaped;
 *   3. the last message — writes the extended prefix for the *next* turn to read.
 */
const MAX_BREAKPOINTS = 4;

/** Only Anthropic-family models honor `cache_control`; others may reject parts. */
export function supportsCacheControl(model: string): boolean {
  const m = model.toLowerCase();
  return m.includes("anthropic/") || m.includes("claude");
}

/**
 * A message can carry a marker only if it has real content. Assistant turns that
 * are pure tool calls have `content: null`, and a `tool` result whose content is
 * empty gives the provider nothing to hash — marking either is at best a wasted
 * breakpoint.
 *
 * **Parts count (P8b, D-78f).** This test used to be `typeof content === "string"`,
 * which was true of every message JLCode had ever built — until an attachment
 * message arrived. It would have placed **zero** breakpoints on a request
 * carrying an image, with no error and no way to notice: D-58's silent 12.3x
 * wearing a new hat.
 */
function markable(msg: ChatMessage): boolean {
  if (typeof msg.content === "string") return msg.content.length > 0;
  return Array.isArray(msg.content) && msg.content.length > 0;
}

/**
 * A breakpoint caches the prefix **up to and including the block it sits on**,
 * so on a multi-part message it goes on the *last* part — marking the leading
 * text part would leave the images that follow it outside the cached prefix,
 * which is the expensive half of the message.
 */
function mark(msg: ChatMessage): WireMessage {
  const { content, ...rest } = msg;
  const parts: WirePart[] =
    typeof content === "string" ? [{ type: "text", text: content }] : [...(content as ContentPart[])];
  parts[parts.length - 1] = { ...parts[parts.length - 1]!, cache_control: { type: "ephemeral" } };
  return { ...rest, content: parts };
}

function plain(msg: ChatMessage): WireMessage {
  return msg;
}

/**
 * Return the messages with cache breakpoints applied. Pure — the input array is
 * not mutated, so the caller's transcript (and its D-24 hash) is untouched.
 */
export function applyCacheBreakpoints(messages: ChatMessage[], model: string): WireMessage[] {
  if (!supportsCacheControl(model)) return messages.map(plain);

  const indices = new Set<number>();

  // (1) The stable prefix: tools + system.
  if (messages.length > 0 && messages[0]!.role === "system" && markable(messages[0]!)) {
    indices.add(0);
  }

  // (3) The write point: the last markable message. Its prefix is what the *next*
  // request will read.
  let writePoint = -1;
  for (let i = messages.length - 1; i >= 1; i--) {
    if (markable(messages[i]!)) {
      writePoint = i;
      break;
    }
  }

  // (2) The anchor: the most recent markable `user` message strictly before the
  // write point — a *turn* boundary, not just the previous message. Anchoring on
  // "second-to-last markable message" looks equivalent and isn't: a tool-heavy
  // turn ends with a run of adjacent `tool` results, so that rule puts the anchor
  // one slot from the write point, where it covers a near-identical prefix and
  // buys nothing. A user message is where a turn actually starts, so the anchor
  // stays a genuinely distinct read point as the turn grows — which is why the
  // test here is for a *typed* turn, not merely a markable one. The attachment
  // message (P8b) is a `user` message that starts no turn: it sits mid-turn,
  // right after the tool results whose images it carries, so it would land the
  // anchor one slot from the write point again. A turn the person typed is a
  // bare string; parts mean JLCode wrote it.
  let anchor = -1;
  for (let i = writePoint - 1; i >= 1; i--) {
    const msg = messages[i]!;
    if (msg.role === "user" && typeof msg.content === "string" && msg.content.length > 0) {
      anchor = i;
      break;
    }
  }

  for (const i of [anchor, writePoint]) {
    if (i >= 0 && indices.size < MAX_BREAKPOINTS) indices.add(i);
  }

  return messages.map((msg, i) => (indices.has(i) ? mark(msg) : plain(msg)));
}
