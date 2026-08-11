/**
 * The agent's todo list (X-31) — **state folded from operations**, not a
 * document that anyone rewrites.
 *
 * The operations live in the conversation's own append-only log as `todo`
 * entries on the branch (D-37), so resume, fork and rewind are correct with no
 * bookkeeping: a rewound branch folds to the list as it stood at that point, a
 * fork inherits its ancestor's list, and a reload replays the same ops in the
 * same order. It also means the list **survives compaction** — the replay cut
 * hides transcript from the model, but the ops are still on the branch, so the
 * fold is unchanged. That is the whole point of the feature: it is the memory
 * that a summary cannot blur.
 *
 * Two writers share it. The agent addresses items **by content or by id** —
 * never by index, because a concurrent edit above an item shifts every index
 * below it and would silently strike the wrong one. Content survives
 * re-ordering, ids survive re-wording, so both are offered and matching is
 * **exact**: fuzzy matching would strike a neighbour, which is the defect
 * wearing a helpful face. A miss fails loudly with the current list attached.
 *
 * The person edits in the browser, and their commit is recorded as a `set`
 * snapshot: they hold the whole list in front of them and are the authority at
 * that moment. The agent is never given `set` — a blind overwrite is exactly the
 * clobber content addressing exists to prevent.
 */
import { newId } from "../util/id.js";
import { pathToLeaf } from "./tree.js";
import type { Conversation } from "./types.js";

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
}

/**
 * One recorded mutation. Ops carry **ids**, resolved when the op was made: the
 * content addressing is the agent's *interface*, not the log format, and a log
 * of resolved ids replays to the same list no matter what was reworded later.
 */
export type TodoOp =
  | { op: "add"; items: { id: string; text: string }[] }
  | { op: "mark"; ids: string[]; done: boolean }
  | { op: "set"; items: TodoItem[] };

/** Fold a branch's ops into the list they describe. */
export function foldTodos(ops: TodoOp[]): TodoItem[] {
  let items: TodoItem[] = [];
  for (const op of ops) {
    if (op.op === "add") {
      items = [...items, ...op.items.map((i) => ({ id: i.id, text: i.text, done: false }))];
    } else if (op.op === "mark") {
      const targets = new Set(op.ids);
      items = items.map((i) => (targets.has(i.id) ? { ...i, done: op.done } : i));
    } else {
      items = op.items.map((i) => ({ ...i }));
    }
  }
  return items;
}

/** The `todo` entries on a branch, root→leaf. */
function todoEntriesOn(conv: Conversation, leafId?: string | null) {
  return pathToLeaf(conv, leafId === undefined ? conv.activeLeaf : leafId).filter(
    (e): e is Extract<typeof e, { type: "todo" }> => e.type === "todo",
  );
}

/** The list as it stands on a branch (defaults to the active leaf). */
export function todosOn(conv: Conversation, leafId?: string | null): TodoItem[] {
  return foldTodos(todoEntriesOn(conv, leafId).flatMap((e) => e.ops));
}

/**
 * The newest todo entry on a branch, or null when the branch has none.
 *
 * This is the read-barrier's version marker: the agent has "seen" the list when
 * its last read (or its own last write) named this id. It is deliberately a
 * *branch* fact rather than a counter — switching branches changes what the list
 * says, so it should also re-arm the barrier.
 */
export function todoTip(conv: Conversation, leafId?: string | null): string | null {
  const entries = todoEntriesOn(conv, leafId);
  return entries.length === 0 ? null : entries[entries.length - 1]!.id;
}

export function undoneCount(items: TodoItem[]): number {
  return items.filter((i) => !i.done).length;
}

/** One-line census, e.g. `4 of 6 items still undone`. */
export function todoCensus(items: TodoItem[]): string {
  const undone = undoneCount(items);
  if (items.length === 0) return "the todo list is empty";
  return `${undone} of ${items.length} ${items.length === 1 ? "item" : "items"} still undone`;
}

/**
 * The list as the model sees it. Ids are echoed on **every** read — that is what
 * makes an unambiguous strike possible when two items happen to read alike.
 */
export function renderTodoList(items: TodoItem[]): string {
  if (items.length === 0) return "The todo list is empty.";
  const lines = items.map((i) => `${i.done ? "[x]" : "[ ]"} ${i.id}  ${i.text}`);
  return `Todo list (${todoCensus(items)}):\n${lines.join("\n")}`;
}

/**
 * How a tool reaches the live list. Implemented by the `Session`, which owns the
 * branch the ops are appended to and the read barrier that guards writes.
 */
export interface TodoAccess {
  /** The current list — and this **is** the read that clears the barrier. */
  read(): TodoItem[];
  /** Apply an agent write, or explain why it didn't apply. */
  write(input: TodoWriteInput): TodoWriteResult;
}

export type TodoWriteResult = { ok: true; items: TodoItem[] } | { ok: false; error: string };

/** What `todo_write` accepts. Every target is matched exactly — see the module note. */
export interface TodoWriteInput {
  add?: string[];
  strike?: string[];
  unstrike?: string[];
}

export type TodoWritePlan =
  | { ok: true; ops: TodoOp[]; items: TodoItem[] }
  | { ok: false; error: string };

/** Resolve one agent-supplied target: an item id, else an exact text match. */
function resolve(items: TodoItem[], target: string): { id: string } | { error: string } {
  const byId = items.find((i) => i.id === target);
  if (byId) return { id: byId.id };
  const matches = items.filter((i) => i.text === target);
  if (matches.length === 1) return { id: matches[0]!.id };
  if (matches.length === 0) return { error: `no item matches ${JSON.stringify(target)}` };
  return {
    error:
      `${matches.length} items read exactly ${JSON.stringify(target)} — ` +
      `strike it by id instead (${matches.map((m) => m.id).join(", ")})`,
  };
}

/**
 * Plan a write against the current list. **Atomic**: one bad target and nothing
 * applies, because a half-applied batch leaves the agent guessing which half.
 * The failure carries the current list so the retry is made with the truth in
 * hand rather than from memory.
 */
export function planTodoWrite(items: TodoItem[], input: TodoWriteInput): TodoWritePlan {
  const add = (input.add ?? []).map((t) => t.trim()).filter((t) => t !== "");
  const strike = input.strike ?? [];
  const unstrike = input.unstrike ?? [];
  const fail = (why: string): TodoWritePlan => ({ ok: false, error: `${why}\n\n${renderTodoList(items)}` });

  if (add.length === 0 && strike.length === 0 && unstrike.length === 0) {
    return fail("todo_write did nothing: pass `add`, `strike` or `unstrike`.");
  }

  // Text must stay unique, or a later strike-by-text is ambiguous by
  // construction. Rejecting the duplicate here is what keeps the addressing
  // usable; a person's browser edit can still create one, and *that* is what the
  // ids are the escape hatch for.
  const seen = new Set(items.map((i) => i.text));
  for (const text of add) {
    if (seen.has(text)) return fail(`"${text}" is already on the list — reword it, or unstrike the existing item.`);
    seen.add(text);
  }

  const ops: TodoOp[] = [];
  let next = items;
  if (add.length > 0) {
    const op: TodoOp = { op: "add", items: add.map((text) => ({ id: newId("td"), text })) };
    ops.push(op);
    next = foldTodos([{ op: "set", items: next }, op]);
  }
  for (const [targets, done] of [
    [strike, true],
    [unstrike, false],
  ] as const) {
    if (targets.length === 0) continue;
    const ids: string[] = [];
    for (const target of targets) {
      const hit = resolve(next, target);
      if ("error" in hit) return fail(`${done ? "strike" : "unstrike"}: ${hit.error}.`);
      ids.push(hit.id);
    }
    const op: TodoOp = { op: "mark", ids, done };
    ops.push(op);
    next = foldTodos([{ op: "set", items: next }, op]);
  }
  return { ok: true, ops, items: next };
}

/**
 * The person's browser commit: a whole-list snapshot, with ids minted for the
 * rows they typed. Returns `null` when nothing actually changed — opening edit
 * mode and closing it again is not news, and must not cost the agent a queued
 * message or a re-armed barrier.
 */
export function planTodoSnapshot(
  current: TodoItem[],
  desired: { id?: string; text: string; done?: boolean }[],
): TodoOp | null {
  const known = new Set(current.map((i) => i.id));
  const items: TodoItem[] = [];
  const used = new Set<string>();
  for (const row of desired) {
    const text = row.text.trim();
    if (text === "") continue; // an emptied row is a deletion, not a blank item
    // Keep the id when it is a row that already existed and hasn't been claimed
    // twice; anything else is a new item and gets a fresh one.
    const id = row.id && known.has(row.id) && !used.has(row.id) ? row.id : newId("td");
    used.add(id);
    items.push({ id, text, done: row.done === true });
  }
  const same =
    items.length === current.length &&
    items.every((i, n) => {
      const was = current[n]!;
      return i.id === was.id && i.text === was.text && i.done === was.done;
    });
  return same ? null : { op: "set", items };
}
