/**
 * Pure operations over the append-only conversation tree (D-17). Append sets a
 * new entry's parent to the current `activeLeaf` (unless overridden — that's a
 * fork) and advances `activeLeaf`. Rewind just moves `activeLeaf` up.
 *
 * `activeLeaf` is the *reader's* pointer, so an append only moves it when the
 * append continues the branch it already points at (H-05). A turn pinned to the
 * branch it started on can then keep appending while the reader is off looking
 * at a sibling, without dragging them back.
 */
import { newId } from "../util/id.js";
import type { ToolCall } from "../llm/types.js";
import type { Conversation, Entry, ModelSwitchEntry } from "./types.js";

/** Distributive Omit so union members keep their discriminant fields. */
type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

export type EntryInput = DistributiveOmit<Entry, "id" | "parent" | "ts">;

export function newConversation(id: string = newId("cv")): Conversation {
  const now = new Date().toISOString();
  return { id, entries: [], activeLeaf: null, createdAt: now, updatedAt: now };
}

/** Append an entry. Omitting `parent` continues the active branch; passing an
 *  ancestor id forks a sibling branch off that point. */
export function appendEntry(
  conv: Conversation,
  input: EntryInput,
  parent?: string | null,
): { conv: Conversation; entry: Entry } {
  const now = new Date().toISOString();
  const parentId = parent !== undefined ? parent : conv.activeLeaf;
  const entry = { ...input, id: newId("e"), parent: parentId, ts: now } as Entry;
  // Follow the append only when it extends the branch in view; an append onto
  // any other branch leaves the reader where they are (H-05).
  const activeLeaf = parentId === conv.activeLeaf ? entry.id : conv.activeLeaf;
  return {
    conv: { ...conv, entries: [...conv.entries, entry], activeLeaf, updatedAt: now },
    entry,
  };
}

function indexBy(entries: Entry[]): Map<string, Entry> {
  return new Map(entries.map((e) => [e.id, e]));
}

/** Root→leaf chain for a leaf (defaults to the active leaf). */
export function pathToLeaf(conv: Conversation, leafId: string | null = conv.activeLeaf): Entry[] {
  const byId = indexBy(conv.entries);
  const path: Entry[] = [];
  let cursor: string | null = leafId;
  const seen = new Set<string>();
  while (cursor !== null) {
    if (seen.has(cursor)) break; // guard against a malformed cycle
    seen.add(cursor);
    const entry = byId.get(cursor);
    if (!entry) break;
    path.unshift(entry);
    cursor = entry.parent;
  }
  return path;
}

/** Entry kinds `buildWireMessages` emits no message for. Keep in step with it:
 *  a kind the wire skips but this walk stops at would hide an open call. */
const WIRE_SILENT: ReadonlySet<Entry["type"]> = new Set(["todo", "model-switch"]);

/**
 * The tool calls at a branch tip that have no result yet — what makes the
 * branch unsendable (D-79's dropped call; D-84's request every backend
 * rejects). Walk back from the leaf over the batch's results to the assistant
 * entry that issued them; whatever it called that none of them answered is
 * dangling. Entries that put **no message on the wire** are stepped over —
 * `todo` (`todo_write` lands its op *before* its own result) and
 * `model-switch` (an idle pick can land on an open tip) — because the wire
 * steps over them too, and a call this walk cannot see still reaches the
 * request. Anything else — a user message, a compaction (the wire restarts
 * there), the root — means the tip is not inside a batch at all.
 *
 * One rule, read by every place a turn may append or come to rest (P9c): a
 * user entry never lands, and a turn never settles, over a non-empty answer.
 */
export function unansweredToolCalls(conv: Conversation, leafId: string | null = conv.activeLeaf): ToolCall[] {
  const byId = indexBy(conv.entries);
  const answered = new Set<string>();
  const seen = new Set<string>();
  let cursor = leafId;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const entry = byId.get(cursor);
    if (!entry) return [];
    if (entry.type === "tool") answered.add(entry.toolCallId);
    else if (entry.type === "assistant") return (entry.toolCalls ?? []).filter((c) => !answered.has(c.id));
    else if (!WIRE_SILENT.has(entry.type)) return [];
    cursor = entry.parent;
  }
  return [];
}

export function setActiveLeaf(conv: Conversation, leafId: string | null): Conversation {
  return { ...conv, activeLeaf: leafId, updatedAt: new Date().toISOString() };
}

/** Children of an entry (siblings share a parent) — powers the ‹2/3› arrows. */
export function childrenOf(conv: Conversation, parentId: string | null): Entry[] {
  return conv.entries.filter((e) => e.parent === parentId);
}

/** Descend from an entry along the latest child at each step to a branch tip. */
export function leafOf(conv: Conversation, entryId: string): string {
  let cursor = entryId;
  for (;;) {
    const kids = childrenOf(conv, cursor);
    if (kids.length === 0) return cursor;
    cursor = kids[kids.length - 1]!.id;
  }
}

/**
 * The model switch governing a leaf (X-56, D-87): the nearest `model-switch`
 * entry on the path above it, or undefined when the branch has none — in which
 * case the folder binding governs, as it always has (D-82a). Folding from the
 * tree is what makes a fork above a switch revert the model with no state of
 * its own: the forked branch simply doesn't contain the entry.
 */
export function governingSwitch(
  conv: Conversation,
  leafId: string | null = conv.activeLeaf,
): ModelSwitchEntry | undefined {
  const path = pathToLeaf(conv, leafId);
  for (let i = path.length - 1; i >= 0; i--) {
    const entry = path[i]!;
    if (entry.type === "model-switch") return entry;
  }
  return undefined;
}
