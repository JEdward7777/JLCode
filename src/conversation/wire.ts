/**
 * Assemble the wire messages sent to the model from the active branch (D-15).
 * Walks root→leaf; on a compaction (`replayCut`) entry it drops everything
 * above and injects the summary — the lossless-overlay behaviour. Assistant
 * `reasoning` (reasoning_details) is replayed verbatim (D-14).
 *
 * X-25: each **user** turn is rendered with the time it was sent, in an
 * `<environment_details>` block appended after the user's own words. The stamp
 * is the entry's stored `ts` — already on disk since the tree existed — so this
 * is a *rendering* change, not a storage one: every past conversation gains its
 * timestamps with no migration, and the replayed prefix stays byte-identical
 * across turns because each stamp was frozen when the entry was appended.
 * Deliberately **not** in the system message: a date there would re-render every
 * turn and invalidate the whole cached prefix — the defect D-58 fixed at 12.3x.
 */
import type { ChatMessage, ContentPart } from "../llm/types.js";
import type { Attachment, Conversation, Entry } from "./types.js";
import { pathToLeaf } from "./tree.js";

export interface WireOptions {
  system?: string;
  leafId?: string | null;
  /** Stamp each user turn with the time it was sent (X-25). Default **on** —
   *  silently wrong dates are the failure this fixes, so it takes an explicit
   *  `false` (the `environment.turnTimestamps` opt-out) to render without them. */
  stamps?: boolean;
  /** IANA zone the stamps are described in; defaults to the host's. Injectable
   *  so tests don't depend on where they run. */
  timeZone?: string;
}

/**
 * One named section of the per-turn `<environment_details>` block (X-25).
 *
 * This is the **injection seam X-25 shares with X-15** (`AGENTS.md`): anything
 * that varies per turn — the time now, and later a cwd / mode / cost line the
 * way KiloCode carries them — is a section added here. Anything *static* for the
 * whole conversation (X-15's file contents) belongs in the system prompt
 * instead, exactly the split KiloCode makes between its `staticEnvLines` and its
 * `environmentDetails`, and for the cache reason: static text in the system
 * message is cached once, per-turn text must never touch it.
 */
export interface EnvSection {
  heading: string;
  lines: string[];
}

const ENV_OPEN = "<environment_details>";
const ENV_CLOSE = "</environment_details>";

/** Render sections into the block. Empty sections are dropped; no sections at
 *  all renders nothing, so a caller never has to special-case "nothing to say". */
export function renderEnvironmentDetails(sections: EnvSection[]): string {
  const body = sections
    .filter((s) => s.lines.length > 0)
    .map((s) => [`# ${s.heading}`, ...s.lines].join("\n"))
    .join("\n\n");
  return body === "" ? "" : `${ENV_OPEN}\n${body}\n${ENV_CLOSE}`;
}

/** Append the block *after* the user's words, so the model can tell our framing
 *  from what the user actually typed. */
export function withEnvironmentDetails(text: string, sections: EnvSection[]): string {
  const block = renderEnvironmentDetails(sections);
  if (block === "") return text;
  return text === "" ? block : `${text}\n\n${block}`;
}

/** Strip any `<environment_details>` block back off a rendered user message —
 *  what something reading a user's *own words* back out of the wire wants (the
 *  offline fake drivers). We never store the block, so unlike KiloCode classic
 *  (which bakes it into the stored message) this is never needed to avoid
 *  double-stamping; it is only for reading the text back. */
export function stripEnvironmentDetails(text: string): string {
  const at = text.lastIndexOf(ENV_OPEN);
  if (at < 0 || !text.trimEnd().endsWith(ENV_CLOSE)) return text;
  return text.slice(0, at).trimEnd();
}

/** The zone's UTC offset **at that instant** (so a summer stamp reads −05:00 and
 *  a winter one −06:00), formatted `UTC±HH:MM`. Undefined if the zone is not
 *  resolvable — a stamp with no zone line beats throwing on the wire builder. */
function utcOffset(at: Date, timeZone: string): string | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(at);
    const name = parts.find((p) => p.type === "timeZoneName")?.value;
    if (!name) return undefined;
    // "GMT-05:00" → "UTC-05:00"; plain "GMT" (UTC itself) → "UTC+00:00".
    if (name === "GMT" || name === "UTC") return "UTC+00:00";
    return name.replace(/^GMT/, "UTC");
  } catch {
    return undefined;
  }
}

function hostTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** The `# Current Time` section for one turn (X-25a) — KiloCode classic's shape:
 *  an unambiguous ISO 8601 UTC instant, plus the user's zone and its offset,
 *  which is what makes "yesterday morning" mean anything. Undefined when `ts` is
 *  not a parseable instant (a hand-edited log), so a bad line costs its own stamp
 *  and nothing else. */
export function currentTimeSection(ts: string, timeZone?: string): EnvSection | undefined {
  const at = new Date(ts);
  if (Number.isNaN(at.getTime())) return undefined;
  const zone = timeZone ?? hostTimeZone();
  const offset = zone ? utcOffset(at, zone) : undefined;
  const lines = [`Current time in ISO 8601 UTC format: ${at.toISOString()}`];
  if (zone && offset) lines.push(`User time zone: ${zone}, ${offset}`);
  return { heading: "Current Time", lines };
}

/** The span a compaction summary stands in for (X-25d): the summary replaces
 *  every turn above the cut, so without this a compacted thread silently loses
 *  its whole history of time — the model would see one undated block and then
 *  today. Rendered from the entries themselves, so it is as retroactive as the
 *  stamps are. */
export function summarySpanSection(from: string, to: string, timeZone?: string): EnvSection | undefined {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return undefined;
  const zone = timeZone ?? hostTimeZone();
  const offset = zone ? utcOffset(end, zone) : undefined;
  const lines = [
    `The summary above replaces the conversation from ${start.toISOString()} to ${end.toISOString()} (ISO 8601 UTC).`,
  ];
  if (zone && offset) lines.push(`User time zone: ${zone}, ${offset}`);
  return { heading: "Summarized History", lines };
}

/** The sections a user turn carries (X-25c: user turns only — assistant and tool
 *  entries carry a `ts` too, but stamping all three triples the noise while the
 *  user turns already mark every gap worth seeing). Exported as the seam: X-15's
 *  per-turn half, if it ever grows one, extends this list. */
export function turnSections(entry: Entry, timeZone?: string): EnvSection[] {
  const time = currentTimeSection(entry.ts, timeZone);
  return time ? [time] : [];
}

/**
 * The `user` message that carries a run of tool attachments (P8b, D-78a).
 *
 * It exists because the wire will not take the bytes where they belong: an
 * `image_url` part inside a `role:"tool"` message is rejected outright, so the
 * tool answers its `tool_call_id` with text and the picture arrives *next*, in
 * the one role that accepts parts. That is a seam the model has to be told
 * about, or it reads a stray image with no idea which of the three files it just
 * asked for this is — hence a label part before each image rather than
 * KiloCode's bare `content: pendingImages`.
 *
 * Text first is OpenRouter's own recommendation for mixed content. The whole
 * message is a pure function of the entries, so it renders byte-identically on
 * every later turn and the cached prefix (D-26) survives.
 */
export function attachmentsMessage(attachments: Attachment[]): ChatMessage {
  const parts: ContentPart[] = [
    {
      type: "text",
      text:
        attachments.length === 1
          ? "The tool result above produced an image. Images cannot be returned inside a tool message, so it is attached here:"
          : `The tool results above produced ${attachments.length} images. Images cannot be returned inside a tool message, so they are attached here, in order:`,
    },
  ];
  attachments.forEach((att, i) => {
    const label = att.name ?? `attachment ${i + 1}`;
    parts.push({ type: "text", text: `[${i + 1}] ${label} (${att.mime})` });
    parts.push({ type: "image_url", image_url: { url: `data:${att.mime};base64,${att.data}` } });
  });
  return { role: "user", content: parts };
}

export function buildWireMessages(conv: Conversation, options: WireOptions = {}): ChatMessage[] {
  const system = options.system?.trim();
  const path = pathToLeaf(conv, options.leafId ?? conv.activeLeaf);
  const systemMsg: ChatMessage[] = system ? [{ role: "system", content: system }] : [];
  const stamps = options.stamps !== false;
  const tz = options.timeZone;
  // Where the replayed window starts, for the compaction span (X-25d). A later
  // compaction folds any earlier summary into itself (D-28), so the summary
  // always stands for everything from the root of the branch.
  const branchStart = path[0]?.ts;
  let messages: ChatMessage[] = [];
  // Attachments accumulate across a run of adjacent tool results and flush as
  // **one** user message before the next non-tool message (KiloCode's
  // `pendingImages`/`flushImages`). Three parallel screenshot reads therefore
  // make three tool messages and one user message, not three interleaved pairs —
  // which matters because every `tool` message must sit unbroken after the
  // assistant turn that called it.
  let pending: Attachment[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    messages.push(attachmentsMessage(pending));
    pending = [];
  };

  for (const entry of path) {
    switch (entry.type) {
      case "compaction": {
        // Reset: everything above is summarized away; keep only the summary —
        // including any attachment that had not flushed yet, which belongs to a
        // turn that no longer exists.
        pending = [];
        const summary = `[Summary of the earlier conversation]\n${entry.summary}`;
        const span = stamps && branchStart ? summarySpanSection(branchStart, entry.ts, tz) : undefined;
        messages = [{ role: "user", content: span ? withEnvironmentDetails(summary, [span]) : summary }];
        break;
      }
      case "user":
        flush();
        messages.push({
          role: "user",
          content: stamps ? withEnvironmentDetails(entry.text, turnSections(entry, tz)) : entry.text,
        });
        break;
      case "assistant": {
        flush();
        const msg: ChatMessage = { role: "assistant", content: entry.text === "" ? null : entry.text };
        if (entry.toolCalls && entry.toolCalls.length > 0) msg.tool_calls = entry.toolCalls;
        if (entry.reasoning !== undefined) msg.reasoning_details = entry.reasoning;
        messages.push(msg);
        break;
      }
      case "tool":
        messages.push({ role: "tool", tool_call_id: entry.toolCallId, name: entry.name, content: entry.content });
        if (entry.attachments && entry.attachments.length > 0) pending.push(...entry.attachments);
        break;
    }
  }
  flush();
  return [...systemMsg, ...messages];
}

/**
 * The backend this conversation is pinned to (D-49/H-02), or undefined to let
 * OpenRouter route freely.
 *
 * Anthropic `thinking` blocks carry a signature only the provider that minted
 * it can verify, and we replay `reasoning_details` verbatim (D-14) — so once a
 * turn has been served, every later turn in the same replayed window must go
 * back to the same place or the provider rejects the history.
 *
 * Derived from the *replayed* window rather than stored as separate state: it
 * walks the same path and honors the same `replayCut` reset as the wire build
 * above. That gives two properties for free — old logs (no `provider` recorded)
 * simply don't pin, and compaction releases the pin, since the summary drops
 * `reasoning_details` and leaves no signature to protect.
 */
export function pinnedProvider(conv: Conversation, leafId?: string | null): string | undefined {
  const path = pathToLeaf(conv, leafId ?? conv.activeLeaf);
  let pin: string | undefined;
  for (const entry of path) {
    if (entry.type === "compaction") pin = undefined; // everything above is gone
    else if (entry.type === "assistant" && pin === undefined) pin = entry.provider;
  }
  return pin;
}
