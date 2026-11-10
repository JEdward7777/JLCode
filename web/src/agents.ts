/**
 * Sub-agents in the browser (P9e, X-56 Q11): the rail's tree, the status dot
 * each agent wears, what a collapsed parent shows of its subtree, and how the
 * transcript turns agent traffic into compact cards.
 *
 * Everything here is pure — slices and entries in, plain data out — so the
 * decisions are Tier-0 testable; `App.tsx` only draws what these return.
 */
import type { ClosedAgent, EntryView, InboundMeta } from "./api";
import { isAwaiting, type SessionSlice } from "./session-state";

// ---- The status dot. ----

/** The rail's status dot for one session (X-56 Q11): `attn` is "waiting for
 *  you", `asking` a question put to its parent agent (P9d — not yours to
 *  answer, though you may), `done` a sub-agent that finished its turn (dimmed,
 *  Q18), `halt` a stalled write or a halted loop. `wake` is at rest but cut
 *  off — interrupted mid-turn, or owed a reply by another agent (P9f): what
 *  Wake resumes. `closed` is a closed sub-agent's grey row (Q18). */
export type AgentDot = "attn" | "halt" | "busy" | "asking" | "wake" | "queued" | "idle" | "done" | "closed";

export interface AgentStatus {
  dot: AgentDot;
  label: string;
}

/** The fields a dot is decided from. */
export type StatusSlice = Pick<
  SessionSlice,
  | "status"
  | "working"
  | "persistenceFault"
  | "pendingApproval"
  | "pendingAsk"
  | "pendingStall"
  | "pendingCompaction"
  | "capReached"
  | "tasks"
  | "restedAs"
  | "rest"
>;

/**
 * Is this session waiting on **the person** (D-93's `waitsForYou`)? An
 * approval, a question asked of the person, the round budget, a compaction
 * decision, the spend cap — and a stalled write, which nothing but a person
 * can clear. A question a sub-agent put to its **parent** is the parent's to
 * answer, so it does not count: that is the rule that keeps a parent-addressed
 * question from lighting the tree.
 */
export function waitsForYou(s: StatusSlice): boolean {
  if (s.persistenceFault || s.pendingApproval || s.pendingStall || s.pendingCompaction || s.capReached) return true;
  if (s.pendingAsk) return s.pendingAsk.to !== "parent";
  // A pause with no card yet (its event has not landed), or one this build has
  // never heard of (D-80) — still a pause. `awaiting-input` waits for the card,
  // which says who was asked.
  return isAwaiting(s.status) && s.status !== "awaiting-input" && s.status !== "awaiting-persistence";
}

/** The dot and its one-word label. `sub` is whether this is a sub-agent: only
 *  a sub-agent at rest after a finished turn reads "finished" — a root thread
 *  at rest is the person's turn, and stays "idle" as it always did. */
export function agentStatus(s: StatusSlice, sub: boolean): AgentStatus {
  if (s.persistenceFault) return { dot: "halt", label: "can’t save" }; // outranks everything (D-46)
  if (s.pendingApproval) return { dot: "attn", label: "needs approval" };
  if (s.pendingAsk) return s.pendingAsk.to === "parent" ? { dot: "asking", label: "asks parent" } : { dot: "attn", label: "needs answer" };
  // A paused turn must never read as a finished one (D-79).
  if (s.pendingStall) return { dot: "attn", label: "continue?" };
  if (s.pendingCompaction) return { dot: "attn", label: "compact?" };
  if (s.capReached) return { dot: "attn", label: "cap reached" };
  if (s.working || s.status === "running") return { dot: "busy", label: "working…" };
  if (s.status === "queued") return { dot: "queued", label: "queued" };
  if (s.tasks.length > 0) return { dot: "busy", label: "task running" };
  if (s.status === "halted") return { dot: "halt", label: "halted" };
  // A question whose card has not landed: say "waiting…" without claiming it
  // is yours (the card will say who was asked).
  if (s.status === "awaiting-input") return { dot: "asking", label: "waiting…" };
  // A pause this build has no card for (D-80) — never `idle`.
  if (isAwaiting(s.status)) return { dot: "attn", label: "waiting…" };
  // At rest but cut off, as its log reads (P9f) — after a restart this is
  // the only thing that tells a stranded agent from a finished one (H-22k).
  if (s.rest === "interrupted") return { dot: "wake", label: "interrupted" };
  if (s.rest === "owes-reply") return { dot: "wake", label: "owes a reply" };
  // A sub-agent loaded at rest on its own reply (after a restart, a reopen)
  // has no `settled` to go by, but its log says it finished just the same.
  if (sub && (s.restedAs === "finished" || (s.restedAs === null && s.rest === "quiescent"))) {
    return { dot: "done", label: "finished" };
  }
  return { dot: "idle", label: "idle" };
}

/** How loudly a dot calls for attention — what a collapsed parent shows the
 *  loudest of (Q11). A person's decision first, then a broken write, then work
 *  in flight, then the quiet states. */
const URGENCY: Record<AgentDot, number> = { attn: 7, halt: 6, busy: 5, asking: 4, wake: 3, queued: 2, idle: 1, done: 0, closed: -1 };

export function urgency(dot: AgentDot): number {
  return URGENCY[dot];
}

// ---- The rail's tree. ----

/** The slice fields the tree is built from. */
export type TreeSlice = StatusSlice & Pick<SessionSlice, "id" | "agent">;

export interface RailNode<S extends TreeSlice = TreeSlice> {
  slice: S;
  /** Nesting in the rail — 0 for a top-level card. Not `agent.depth`: an
   *  orphan (its parent not live) is drawn at the top. */
  level: number;
  children: RailNode<S>[];
}

/**
 * Nest live sessions under their parents (Q11), keeping the order they arrived
 * in at every level. A sub-agent whose parent is not in the bag — not linked
 * yet, or closed out from under it — stays at the top rather than vanish.
 */
export function buildRailTree<S extends TreeSlice>(slices: readonly S[]): RailNode<S>[] {
  const byId = new Map(slices.map((s) => [s.id, s]));
  const kids = new Map<string, S[]>();
  const tops: S[] = [];
  for (const s of slices) {
    const parent = s.agent?.parentSessionId ?? null;
    if (parent !== null && parent !== s.id && byId.has(parent)) {
      const list = kids.get(parent) ?? [];
      list.push(s);
      kids.set(parent, list);
    } else tops.push(s);
  }
  const seen = new Set<string>();
  const node = (s: S, level: number): RailNode<S> => {
    seen.add(s.id);
    return { slice: s, level, children: (kids.get(s.id) ?? []).filter((c) => !seen.has(c.id)).map((c) => node(c, level + 1)) };
  };
  const out = tops.map((s) => node(s, 0));
  // A parent link that loops (never written by the server, but a stale frame
  // must not make a card disappear): whatever no top reached goes on top.
  for (const s of slices) if (!seen.has(s.id)) out.push(node(s, 0));
  return out;
}

/** Every session below a node, depth-first. */
export function descendantsOf<S extends TreeSlice>(node: RailNode<S>): S[] {
  const out: S[] = [];
  const walk = (n: RailNode<S>) => {
    for (const c of n.children) {
      out.push(c.slice);
      walk(c);
    }
  };
  walk(node);
  return out;
}

export interface Rollup<S extends TreeSlice = TreeSlice> {
  /** Sessions below this one, at every level. */
  count: number;
  /** The loudest of them and its status — what a collapsed parent shows. The
   *  first in rail order wins a tie. Null when there are none. */
  top: { slice: S; status: AgentStatus } | null;
  /** Any of them waiting on the person (D-93's rule): what lights the parent. */
  waiting: boolean;
}

/** What a collapsed parent shows of its whole subtree (Q11): a grandchild on an
 *  approval lights the root as surely as a child does. */
export function rollup<S extends TreeSlice>(node: RailNode<S>): Rollup<S> {
  const below = descendantsOf(node);
  let top: Rollup<S>["top"] = null;
  for (const s of below) {
    const status = agentStatus(s, true);
    if (!top || urgency(status.dot) > urgency(top.status.dot)) top = { slice: s, status };
  }
  return { count: below.length, top, waiting: below.some(waitsForYou) };
}

// ---- Lifecycle (P9f). ----

/** Wake would do something with this session: at rest and cut off. */
export function isWakeable(s: Pick<SessionSlice, "rest">): boolean {
  return s.rest === "interrupted" || s.rest === "owes-reply";
}

/** How many sessions a Wake on this rail entry would resume — itself and its
 *  open subtree (closed agents are not loaded, so never counted, Q20). */
export function wakeCount<S extends TreeSlice>(node: RailNode<S>): number {
  return [node.slice, ...descendantsOf(node)].filter(isWakeable).length;
}

/** Is anything below `id` at work — what keeps a tree-wide Stop on offer from
 *  a root that has itself gone idle after spawning (H-22a, D-34)? */
export function subtreeWorking(slices: readonly (StatusSlice & Pick<SessionSlice, "id" | "agent">)[], id: string): boolean {
  const seen = new Set<string>([id]);
  const queue = [id];
  while (queue.length > 0) {
    const at = queue.shift()!;
    for (const s of slices) {
      if (s.agent?.parentSessionId !== at || seen.has(s.id)) continue;
      if (s.working || s.status === "running" || s.status === "queued" || s.tasks.length > 0) return true;
      seen.add(s.id);
      queue.push(s.id);
    }
  }
  return false;
}

/** More closed siblings than this fold into one "N closed" row (Q18). */
export const CLOSED_FOLD_AT = 5;

/**
 * A parent's closed sub-agents as its rail draws them (Q18): below the open
 * ones, each its own grey row — unless there are more than
 * {@link CLOSED_FOLD_AT}, when they fold into one "N closed" row the person
 * can open in place. `fold` is that row (null when there is none); `rows` are
 * the closed agents drawn one by one.
 */
export function closedLayout(
  closed: readonly ClosedAgent[],
  expanded: boolean,
): { fold: { count: number; open: boolean } | null; rows: ClosedAgent[] } {
  if (closed.length <= CLOSED_FOLD_AT) return { fold: null, rows: [...closed] };
  return { fold: { count: closed.length, open: expanded }, rows: expanded ? [...closed] : [] };
}

// ---- Links between agents. ----

/** The slice fields a link is resolved from. */
export type LinkSlice = Pick<SessionSlice, "id" | "agent">;

/**
 * The live session `name` means, as seen from `from` (D-88: an agent talks to
 * its parent and its direct children only). `parent`, or the parent's own name,
 * is the parent; anything else is one of `from`'s children by name. Undefined
 * when that agent is not live (closed, or not loaded since a restart).
 */
export function resolveAgent(slices: readonly LinkSlice[], from: LinkSlice, name: string): string | undefined {
  const wanted = name.trim();
  const parentId = from.agent?.parentSessionId ?? null;
  if (parentId !== null) {
    const parent = slices.find((s) => s.id === parentId);
    if (wanted.toLowerCase() === "parent" || (parent?.agent && parent.agent.name === wanted)) return parent?.id;
  }
  return slices.find((s) => s.agent?.parentSessionId === from.id && s.agent.name === wanted)?.id;
}

/** "agent-2 → agent-5": where a sub-agent sits, for the pane's breadcrumb. */
export function lineage<S extends LinkSlice>(slices: readonly S[], s: LinkSlice): S[] {
  const chain: S[] = [];
  const seen = new Set<string>([s.id]);
  for (let id = s.agent?.parentSessionId ?? null; id !== null; ) {
    const p = slices.find((x) => x.id === id);
    if (!p || seen.has(p.id)) break;
    seen.add(p.id);
    chain.unshift(p);
    id = p.agent?.parentSessionId ?? null;
  }
  return chain;
}

// ---- Transcript cards. ----

/**
 * A transcript entry drawn as agent traffic (Q11): **spawned** (a
 * `spawn_agent` result), **→ sent** (a `send_message` result), **← received**
 * (a message, task or question from another agent) and **finished** (a
 * completion notice). `peer` is the other agent's name — what the card links
 * to — and `body` what was said, its attribution header removed.
 */
export interface AgentCard {
  kind: "spawned" | "sent" | "received" | "finished" | "refused";
  peer: string | null;
  /** The card's head, without the peer: "spawned", "→", "task from" … */
  head: string;
  body: string;
  /** A model or a mode worth naming beside the peer (spawned only). */
  detail?: string;
  /** The notice said it stopped on an error or was stopped, not finished. */
  tone?: "warn";
}

/** The attribution line the server writes above an agent's message (D-88). */
const HEADER = /^\[(?:Task|Message|Question) from [\s\S]*?\]\n\n/;

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);

/**
 * How an entry renders when it is agent traffic, or null for an ordinary one.
 * `args` is the calling assistant entry's arguments for a tool result (the
 * transcript already joins them by `toolCallId`, X-11).
 */
export function agentCard(entry: EntryView, args?: string): AgentCard | null {
  if (entry.type === "user" && entry.inbound) return inboundCard(entry.inbound, entry.text ?? "");
  if (entry.type !== "tool") return null;
  const a = parseArgs(args);
  const result = entry.content ?? "";
  if (entry.name === "spawn_agent") {
    const task = str(a.task) ?? "";
    if (entry.isError) return { kind: "refused", peer: null, head: "spawn refused", body: result };
    const name = /Started sub-agent "([^"]+)"/.exec(result)?.[1] ?? null;
    const on = /\bon (.+?) \(([^)]+)\)/.exec(result);
    const mode = /\bin (ask|plan|code) mode\b/.exec(result)?.[1];
    const detail = [on ? on[1] : str(a.model), mode ? `${mode} mode` : undefined].filter(Boolean).join(" · ");
    return { kind: "spawned", peer: name, head: "spawned", body: task, ...(detail ? { detail } : {}) };
  }
  if (entry.name === "send_message") {
    const to = str(a.to) ?? null;
    const text = str(a.text) ?? "";
    if (entry.isError) return { kind: "refused", peer: to, head: "→ not sent to", body: `${text}\n\n${result}`.trim() };
    // A reply to a child's question is its answer (P9d) — the result says so.
    const answer = /as the answer to its question/.test(result);
    return { kind: "sent", peer: to, head: answer ? "→ answered" : "→", body: text };
  }
  return null;
}

function inboundCard(meta: InboundMeta, text: string): AgentCard {
  const body = text.replace(HEADER, "");
  switch (meta.kind) {
    case "task":
      return { kind: "received", peer: meta.from, head: "← task from", body };
    case "question":
      return { kind: "received", peer: meta.from, head: "← question from", body };
    case "finished": {
      // The notice names who, never what (Q6); its wording says how it ended.
      const failed = /stopped on an error/.test(text);
      const stopped = /was stopped by the user/.test(text);
      const still = /\((\d+) of its own sub-agents? (?:is|are) still working\)/.exec(text)?.[1];
      const head = failed ? "failed" : stopped ? "stopped" : "finished";
      return {
        kind: "finished",
        peer: meta.from,
        head,
        body: still ? `its own sub-agents still working: ${still}` : "",
        ...(failed || stopped ? { tone: "warn" as const } : {}),
      };
    }
    default:
      return { kind: "received", peer: meta.from, head: "←", body };
  }
}
