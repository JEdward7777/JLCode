/**
 * Client-side reads over the conversation tree (D-17), mirroring the pure ops in
 * `src/conversation/tree.ts`. The server ships the full entry list + `activeLeaf`
 * (GET /session/:id); the browser walks it to render the active branch and to
 * draw the ‹i/n› sibling arrows that switch branches (rewind, D-10).
 */
import type { EntryView } from "./api";

function indexBy(entries: EntryView[]): Map<string, EntryView> {
  return new Map(entries.map((e) => [e.id, e]));
}

/** Root→leaf chain for a leaf (defaults to the active leaf). */
export function pathToLeaf(entries: EntryView[], leafId: string | null): EntryView[] {
  const byId = indexBy(entries);
  const path: EntryView[] = [];
  let cursor: string | null = leafId;
  const seen = new Set<string>();
  while (cursor !== null) {
    if (seen.has(cursor)) break; // guard a malformed cycle
    seen.add(cursor);
    const entry = byId.get(cursor);
    if (!entry) break;
    path.unshift(entry);
    cursor = entry.parent;
  }
  return path;
}

/** Children of an entry (siblings share a parent) — powers the ‹i/n› arrows. */
export function childrenOf(entries: EntryView[], parentId: string | null): EntryView[] {
  return entries.filter((e) => e.parent === parentId);
}

/** Descend from an entry along the latest child at each step to a branch tip. */
export function leafOf(entries: EntryView[], entryId: string): string {
  let cursor = entryId;
  for (;;) {
    const kids = childrenOf(entries, cursor);
    if (kids.length === 0) return cursor;
    cursor = kids[kids.length - 1]!.id;
  }
}
