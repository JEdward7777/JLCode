/**
 * Pure operations over the append-only conversation tree (D-17). Append sets a
 * new entry's parent to the current `activeLeaf` (unless overridden — that's a
 * fork) and advances `activeLeaf`. Rewind just moves `activeLeaf` up.
 */
import { newId } from "../util/id.js";
import type { Conversation, Entry } from "./types.js";

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
  return {
    conv: { ...conv, entries: [...conv.entries, entry], activeLeaf: entry.id, updatedAt: now },
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

export function setActiveLeaf(conv: Conversation, leafId: string): Conversation {
  return { ...conv, activeLeaf: leafId, updatedAt: new Date().toISOString() };
}

/** Children of an entry (siblings share a parent) — powers the ‹2/3› arrows. */
export function childrenOf(conv: Conversation, parentId: string | null): Entry[] {
  return conv.entries.filter((e) => e.parent === parentId);
}
