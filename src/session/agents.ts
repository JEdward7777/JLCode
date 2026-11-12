/**
 * The agent coordinator (X-56, D-88/D-89): the one object that sees a whole
 * tree of sessions — a human-started root and the sub-agents it, and they,
 * spawned — and the one place every tree-wide rule is enforced.
 *
 * A sub-agent is an ordinary Session (D-35/D-36): its own loop, its own log,
 * its own place in the bag. What this adds is only what no single session can
 * know:
 *
 *   - **links** — parent and children, so spend rolls up (D-33), Stop/Close
 *     reach the subtree (D-34) and the parent learns when a child goes idle;
 *   - **names** — `agent-N`, unique per tree and stable across restarts (read
 *     back from the tree's file), which is what agents address each other by;
 *   - **the brakes** (D-89) — depth (`agentDepth`) refuses a spawn too far below
 *     the root; width (`agentConcurrency`) never refuses anything, it makes an
 *     agent-started turn wait `queued` and starts it FIFO when a slot frees.
 *     Both read from the **root's** config, live, so a child on a laxer config
 *     cannot loosen its tree;
 *   - **delivery** — a message is recorded on the receiver (`Session.receive`)
 *     synchronously, inside the sender's tool call, so it is on disk before the
 *     sender's turn moves on; the receiver's turn is opened afterwards, off the
 *     sender's call stack (`later`).
 *
 * Nothing here talks to the model, and nothing here touches disk directly: the
 * server hands in how to start a session and how to read a tree's records.
 */
import { newId } from "../util/id.js";
import { newConversation } from "../conversation/tree.js";
import { computeCost } from "./spend.js";
import { agentConcurrencyLimit, agentDepthLimit, toolRoundsOff } from "../config/operations.js";
import { MODES, type Mode, type ModelConfig } from "../config/types.js";
import type { Conversation } from "../conversation/types.js";
import { agentConversationId, type AgentRecord } from "../persist/conversation-store.js";
import type { AgentHost, Session, WakeOutcome } from "./session.js";
import type { AskUserRequest, ClosedAgent, InboundMessage, QueuedMessage, SessionEvent, SubtreeSummary } from "./types.js";

/** The root thread's name, as its sub-agents see it. */
export const ROOT_AGENT_NAME = "root";

export interface AgentCoordinatorDeps {
  /** Every model config in the live store — what `model` is validated against. */
  listConfigs(): ModelConfig[];
  /** Build a session for an agent, wire its persistence and put it in the bag.
   *  `record` is present for a new spawn (write it to the tree's file first) and
   *  absent for a revival, whose record is already there. */
  startAgent(opts: { config: ModelConfig; conversation: Conversation; rootId: string; record?: AgentRecord }): Session;
  /** The agents a tree's file records, in spawn order (names, revival). */
  agentRecords(rootId: string): AgentRecord[];
  /** An agent's conversation from disk, for a revival. */
  loadConversation(convId: string): Conversation | undefined;
  /** Record a sub-agent closed or reopened in its tree's file (P9f). */
  setClosed?(rootId: string, agentId: string, closed: boolean): void;
  /** Record the mode a parent set on a sub-agent in its tree's file (P9f2). */
  setMode?(rootId: string, agentId: string, mode: Mode): void;
  /** Does the tree's file still have writes queued? A read now would miss them. */
  writesPending?(convId: string): boolean;
  /** Sessions a close took out of the tree — the caller drops them from the
   *  bag (P9f: an agent closing its child has no route to do it for it). */
  onUnloaded?(sessions: Session[]): void;
  /** Something went wrong starting a turn off the caller's stack. */
  onError?(err: unknown): void;
}

interface Member {
  session: Session;
  /** `null` for the root thread. */
  agentId: string | null;
  name: string;
  depth: number;
  parent: Member | undefined;
  children: Set<Member>;
  tree: Tree;
  unsub: () => void;
}

interface Tree {
  root: Member;
  /** Agent-started turns waiting for a slot under the width cap, FIFO (D-89). */
  waiting: Session[];
  /** The next `agent-N`; read from the tree's file the first time it is needed,
   *  so a resumed tree never re-issues a name. */
  nextIndex: number | undefined;
  /** Every agent the tree records, closed flags folded (P9f). Read from the
   *  file once, then kept here: the coordinator makes every change to it, and
   *  a re-read could miss an append still in the file's queue. */
  records: AgentRecord[] | undefined;
  /** Spend of recorded agents that are **not loaded** — closed, or folded
   *  under a closed one — by agent id (D-33). Set from the session's own
   *  figure when it unloads; folded from its log, as a loaded session folds its
   *  own, for one that was never loaded in this process. The cap is the
   *  tree's, and closing an agent must not hand its spend back (H-18a). */
  offline: Map<string, number>;
}

/** What a Wake did across a subtree (P9f), by agent name. */
export interface WakeReport {
  woken: string[];
  queued: string[];
  /** Quiescent — at rest on its own reply, nothing owed. */
  asleep: string[];
  /** Not at rest: working, or waiting on someone. */
  busy: string[];
  /** Held by something a person clears — the spend cap, the breaker, a
   *  missing model, a Stop in flight. */
  blocked: string[];
  /** Closed below the woken entry: skipped, with everything under them (Q20). */
  closed: string[];
}

/** Statuses a person has to act on — an approval, a question, the round
 *  budget, a compaction decision. What lights a parent (X-56 Q10/Q11). A
 *  question addressed to the parent agent (P9d) is the parent's to answer, so
 *  it does not count — see {@link waitsForYou}. */
const WAITING_FOR_YOU = new Set(["awaiting-approval", "awaiting-input", "awaiting-continue", "awaiting-compaction"]);

const waitsForYou = (s: Session): boolean => WAITING_FOR_YOU.has(s.status) && !(s.status === "awaiting-input" && s.asksParent);

/** How strict a mode is: a lower rank may do less (ask < plan < code). */
const modeRank = (m: Mode): number => MODES.indexOf(m);
/** The stricter of two modes (X-56 Q10: the parent's mode is a ceiling). */
const stricter = (a: Mode, b: Mode): Mode => (modeRank(a) <= modeRank(b) ? a : b);

/** What a mode lets an agent do, in the words its mode note uses (P9f2). */
const MODE_MEANS: Record<Mode, string> = {
  ask: "read-only: you may read and search, but not write files or run commands",
  plan: "you may write markdown files and run git add/commit/status/diff/log, and nothing else",
  code: "you may edit files and run commands",
};

/** A conversation with its pending inbox set to the agent messages still
 *  queued — what a reload of the file would fold (D-88). */
function withInbox(conversation: Conversation, queue: readonly QueuedMessage[]): Conversation {
  const inbox = queue.flatMap((m) => (m.inbound ? [{ ...m.inbound, text: m.text }] : []));
  const { inbox: _stale, ...rest } = conversation;
  return inbox.length > 0 ? { ...rest, inbox } : rest;
}

/** How a live sub-agent stands, in the words `list_agents` gives its parent. */
function describeStatus(s: Session): string {
  switch (s.status) {
    case "running":
      return "working";
    case "queued":
      return "queued (waiting for a slot under the tree's concurrency cap)";
    case "halted":
      return "halted on repeated errors";
    case "awaiting-input":
      return s.asksParent ? "waiting on your answer to its question" : "waiting on the user's answer";
    case "idle": {
      if (s.capReached) return "paused at the spend cap";
      const rest = s.restState;
      if (rest === "interrupted") return "interrupted mid-turn (the root's wake_agents resumes it)";
      if (rest === "owes-reply") return "has a message it has not answered yet";
      return s.restedAs === "finished" ? "finished its turn, idle" : "idle";
    }
    default:
      return "waiting for the user";
  }
}

export class AgentCoordinator implements AgentHost {
  private readonly members = new Map<string, Member>();
  private readonly inflight = new Set<Promise<void>>();
  /** Parents whose subtree changed since the last `subtree` announcement. */
  private readonly dirty = new Set<Member>();
  private flushScheduled = false;
  /** Sessions a close unloaded whose file was still being written, by
   *  conversation id: a reopen before those writes land reads the session's
   *  own copy, not a file that is behind it (P9f). Pruned once written. */
  private readonly unloadedRecently = new Map<string, Session>();

  constructor(private readonly deps: AgentCoordinatorDeps) {}

  // ---- Membership.

  /** Make a session the root of its own tree — every thread the human starts. */
  adoptRoot(session: Session): void {
    if (this.members.has(session.id)) return;
    const tree = { waiting: [], nextIndex: undefined, records: undefined, offline: new Map() } as unknown as Tree;
    const root = this.attach(session, { agentId: null, name: ROOT_AGENT_NAME, depth: 0 }, undefined, tree);
    tree.root = root;
  }

  private attach(
    session: Session,
    who: { agentId: string | null; name: string; depth: number },
    parent: Member | undefined,
    tree: Tree,
  ): Member {
    const member: Member = { session, ...who, parent, children: new Set(), tree, unsub: () => {} };
    this.members.set(session.id, member);
    // Loaded again: its spend is the session's own from here.
    if (who.agentId !== null) tree.offline.delete(who.agentId);
    parent?.children.add(member);
    session.setAgentHost(this, {
      name: who.name,
      depth: who.depth,
      parentSessionId: parent?.session.id ?? null,
      rootSessionId: tree.root?.session.id ?? session.id,
    });
    member.unsub = session.onEvent((e) => this.onEvent(member, e));
    // A parent's closed list and counts move when a child joins (P9f).
    for (let a = parent; a; a = a.parent) this.dirty.add(a);
    if (parent) this.scheduleFlush();
    return member;
  }

  /** The tree's agent records, read from its file the first time (P9f). */
  private records(tree: Tree): AgentRecord[] {
    if (!tree.records) tree.records = this.deps.agentRecords(tree.root.session.conversation.id).map((r) => ({ ...r }));
    return tree.records;
  }

  private rootId(tree: Tree): string {
    return tree.root.session.conversation.id;
  }

  /** Records of `m`'s own children, spawn order. */
  private childRecords(m: Member): AgentRecord[] {
    return this.records(m.tree).filter((r) => r.parentAgentId === m.agentId);
  }

  /** How many agents the tree records below `agentId`. */
  private recordedBelow(tree: Tree, agentId: string): number {
    const all = this.records(tree);
    let n = 0;
    const walk = (id: string) => {
      for (const r of all) if (r.parentAgentId === id) (n++, walk(r.agentId));
    };
    walk(agentId);
    return n;
  }

  private markClosed(tree: Tree, record: AgentRecord, closed: boolean): void {
    if ((record.closed === true) === closed) return;
    if (closed) record.closed = true;
    else delete record.closed;
    this.deps.setClosed?.(this.rootId(tree), record.agentId, closed);
  }

  private member(session: Session): Member {
    const m = this.members.get(session.id);
    if (!m) throw new Error("This session is not part of an agent tree.");
    return m;
  }

  private descendants(m: Member): Member[] {
    const out: Member[] = [];
    const walk = (x: Member) => {
      for (const c of x.children) {
        out.push(c);
        walk(c);
      }
    };
    walk(m);
    return out;
  }

  private treeMembers(tree: Tree): Member[] {
    return [tree.root, ...this.descendants(tree.root)];
  }

  /** The config governing a tree's limits: the root's, read live (D-89). */
  private rootConfig(tree: Tree): ModelConfig {
    const held = tree.root.session.config;
    return this.deps.listConfigs().find((c) => c.id === held.id) ?? held;
  }

  // ---- The tools (AgentHost).

  async spawn(session: Session, task: string, model?: string, mode?: Mode): Promise<string> {
    const parent = this.member(session);
    // A Stop reaches the subtree (D-34): the rest of a stopped batch still runs,
    // but it must not grow the tree.
    if (session.stopping) throw new Error("spawn_agent refused: the user stopped this turn. Nothing was started.");
    const tree = parent.tree;
    const maxDepth = agentDepthLimit(this.rootConfig(tree));
    if (parent.depth + 1 > maxDepth) {
      throw new Error(
        maxDepth === 0
          ? "spawn_agent refused: sub-agents are switched off for this thread (agent depth 0). Do the work yourself."
          : `spawn_agent refused: you are ${parent.depth} level${parent.depth === 1 ? "" : "s"} below the root and ` +
              `this tree allows sub-agents ${maxDepth} level${maxDepth === 1 ? "" : "s"} deep. Do the work yourself.`,
      );
    }
    // The parent's mode is a ceiling (X-56 Q10): `mode` may only tighten it.
    // The mode it is headed for, if its own parent's change is held (P9f2).
    const own = session.modeAhead;
    if (mode !== undefined && modeRank(mode) > modeRank(own)) {
      throw new Error(
        `spawn_agent refused: you are in ${own} mode, and a sub-agent may only be as strict or stricter ` +
          `(${MODES.slice(0, modeRank(own) + 1).join(", ")}). Nothing was started.`,
      );
    }
    const config = this.pickConfig(session, model);
    const rootId = tree.root.session.conversation.id;
    const tighter = mode !== undefined && mode !== own;
    const record: AgentRecord = {
      agentId: newId("ag"),
      parentAgentId: parent.agentId,
      name: this.nextName(tree),
      depth: parent.depth + 1,
      // Any mode passed is recorded — an equal one too: it names a fixed mode,
      // and a revival must not read "the parent's mode" off a parent that has
      // since been loosened. `stricter()` at revival still caps it.
      ...(mode !== undefined ? { mode } : {}),
      createdAt: new Date().toISOString(),
    };
    const conversation = newConversation(agentConversationId(rootId, record.agentId));
    // Named at birth, and pinned: the name is what agents address it by, so an
    // auto-title (a billed call) would only rename it to something nobody uses.
    conversation.title = record.name;
    conversation.titleSource = "manual";
    this.records(tree).push({ ...record });
    const child = this.attach(this.deps.startAgent({ config, conversation, rootId, record }), record, parent, tree);
    await this.inherit(child, record.mode);
    // The child's model is an entry in its own log (D-87), never the folder
    // binding — or the next re-bind would move a sub-agent the parent placed.
    await child.session.switchModel(config.id);
    this.deliver(child, parent, "task", task);
    return (
      `Started sub-agent "${record.name}" on ${config.name} (${config.model})${tighter ? ` in ${mode} mode` : ""}. ` +
      `It is working in the background, ` +
      `and your turn ends here. You will get a notice each time it finishes a turn; ask it with send_message ` +
      `(to: "${record.name}") for anything it has not sent you.`
    );
  }

  send(session: Session, to: string, text: string): string {
    const sender = this.member(session);
    const target = this.resolve(sender, to);
    // A child paused on a question it asked this sender (P9d, X-56 Q16): the
    // reply is its answer. Anyone else's message — and this sender's, once the
    // person has answered first — queues as usual.
    if (target.parent === sender && target.session.answerFromParent(sender.name, text)) {
      this.later(() => target.session.resumeAnswered());
      return `Sent to "${target.name}" as the answer to its question; it carries on from there.`;
    }
    this.deliver(target, sender, "message", text);
    return `Sent to "${target.name}".`;
  }

  /** A child asked its parent (P9d, X-56 Q16): the question reaches the parent
   *  as a message from the child, which starts its turn like any message. The
   *  parent answers by replying (`send`, above); if it cannot, its own `ask`
   *  climbs to its questioner — a turn an agent opened defaults to the parent. */
  askParent(session: Session, request: AskUserRequest): void {
    const child = this.member(session);
    if (!child.parent) return;
    const lines = request.questions.map((q, i) => {
      const head = request.questions.length > 1 ? `${i + 1}. ` : "";
      const label = q.header ? `${q.header} — ` : "";
      const options = q.options && q.options.length > 0 ? ` (suggested: ${q.options.join(" / ")})` : "";
      return `${head}${label}${q.question}${options}`;
    });
    this.deliver(child.parent, child, "question", lines.join("\n"));
  }

  /** The tool-round pause is off for this session (P9d, D-89): the root's
   *  config says so, read live, or "don't ask again" was chosen on it or on an
   *  agent above it — a thread's choice covers its whole subtree. */
  roundsOff(session: Session): boolean {
    const m = this.members.get(session.id);
    if (!m) return session.conversation.roundsOff === true;
    if (toolRoundsOff(this.rootConfig(m.tree))) return true;
    for (let x: Member | undefined = m; x; x = x.parent) if (x.session.conversation.roundsOff) return true;
    return false;
  }

  /** The caller's key as the live store has it now — a rotation reaches the
   *  same-key check at once (X-56 Q9) — else the held one, when its config is
   *  gone. Compared server-side only; no key byte ever reaches a tool result. */
  private liveKey(session: Session, all: ModelConfig[]): string {
    return all.find((c) => c.id === session.config.id)?.openRouterKey ?? session.config.openRouterKey;
  }

  listModels(session: Session): string {
    const own = session.config;
    const all = this.deps.listConfigs();
    const key = this.liveKey(session, all);
    const same = all.filter((c) => c.openRouterKey === key);
    if (same.length === 0) return "No model configs share your OpenRouter key.";
    const rows = same.map((c) => `- ${c.name} — ${c.model}${c.id === own.id ? " (your own)" : ""}`);
    return [
      "Models a sub-agent may run on (the configs that share your OpenRouter key). Pass a name as spawn_agent's `model`:",
      ...rows,
    ].join("\n");
  }

  /** A model by name, from the configs that share the caller's key — checked
   *  against the live store every time (X-56 Q9), and refused with the names
   *  that would have worked. */
  private pickConfig(session: Session, model: string | undefined): ModelConfig {
    const own = session.config;
    const all = this.deps.listConfigs();
    const key = this.liveKey(session, all);
    const same = all.filter((c) => c.openRouterKey === key);
    const allowed = same.map((c) => `"${c.name}"`).join(", ") || "(none)";
    if (model === undefined) {
      const live = same.find((c) => c.id === own.id);
      if (live) return live;
      throw new Error(`Your own model config "${own.name}" no longer exists. Pass \`model\` — one of: ${allowed}.`);
    }
    const lower = model.toLowerCase();
    const byName = (list: ModelConfig[]) =>
      list.find((c) => c.name === model) ?? list.find((c) => c.name.toLowerCase() === lower) ?? list.find((c) => c.id === model);
    const hit = byName(same);
    if (hit) return hit;
    const elsewhere = byName(all);
    throw new Error(
      elsewhere
        ? `Model config "${elsewhere.name}" uses a different OpenRouter key, and a sub-agent may only use your own key. Allowed: ${allowed}.`
        : `No model config named "${model}". Allowed (call list_models for their models): ${allowed}.`,
    );
  }

  private nextName(tree: Tree): string {
    if (tree.nextIndex === undefined) {
      const used = this.records(tree)
        .map((r) => /^agent-(\d+)$/.exec(r.name)?.[1])
        .filter((n): n is string => n !== undefined)
        .map(Number);
      tree.nextIndex = used.length > 0 ? Math.max(...used) + 1 : 1;
    }
    return `agent-${tree.nextIndex++}`;
  }

  /** A sub-agent starts at its parent's mode and approval policy (Q10) — or
   *  the stricter `mode` it was spawned with (P9d) — and under its tree's
   *  spend cap, measured against the whole tree (D-33). */
  private async inherit(child: Member, mode?: Mode): Promise<void> {
    const parent = child.parent!.session;
    // `modeAhead`: a tightening held for the parent's batch is already its
    // ceiling (P9f2) — a child spawned in that batch must not outlive it.
    child.session.setModeApproval(mode ? stricter(mode, parent.modeAhead) : parent.modeAhead, parent.approval);
    await child.session.setSpendCap(child.tree.root.session.spendCapUsd ?? null);
  }

  /** `to` from `sender`'s point of view: "parent", or one of its own children by
   *  name. A child that is not live (a restart, a close) is revived from the
   *  tree's file — the message is what wakes it. */
  private resolve(sender: Member, to: string): Member {
    const wanted = to.trim();
    if (wanted.toLowerCase() === "parent") {
      if (sender.parent) return sender.parent;
      throw new Error("You have no parent agent: the user started you. Answer the user in your reply instead.");
    }
    if (sender.parent && wanted === sender.parent.name) return sender.parent;
    if (wanted === sender.name) throw new Error(`"${wanted}" is you — send_message goes to another agent.`);
    const live = [...sender.children].find((c) => c.name === wanted);
    if (live) return live;
    const records = this.childRecords(sender);
    const record = records.find((r) => r.name === wanted);
    // A closed child still takes messages: delivery reopens it (Q20).
    if (record) return this.revive(sender, record);
    const reachable = [
      ...(sender.parent ? ['"parent"'] : []),
      ...new Set([...[...sender.children].map((c) => c.name), ...records.map((r) => r.name)]),
    ].map((n) => (n.startsWith('"') ? n : `"${n}"`));
    throw new Error(
      `No agent "${wanted}" you can message. ` +
        (reachable.length > 0 ? `You can reach: ${reachable.join(", ")}.` : "You have no parent and no sub-agents."),
    );
  }

  /** Bring a recorded sub-agent back from its tree's file (it was closed, or the
   *  server restarted). Its own switch entry decides its model. */
  private revive(parent: Member, record: AgentRecord): Member {
    const child = this.load(parent, record);
    this.markClosed(parent.tree, record, false);
    this.loadOpenBelow(child);
    return child;
  }

  /** Load the open agents below `m` that are not loaded yet, all the way down,
   *  stopping at closed ones — a closed agent's subtree folds with it (Q18).
   *  Loading is not starting: nothing here opens a turn (X-56 Q15). */
  private loadOpenBelow(m: Member): void {
    for (const r of this.childRecords(m)) {
      if (r.closed || [...m.children].some((c) => c.agentId === r.agentId)) continue;
      try {
        this.loadOpenBelow(this.load(m, r));
      } catch (err) {
        this.deps.onError?.(err);
      }
    }
  }

  /** A root came back from history (P9f): bring its open tree into the bag
   *  with it, at rest. What each agent was doing is read from its log
   *  (`Session.restState`); Wake is what resumes them. */
  loadTree(root: Session): void {
    const m = this.members.get(root.id);
    if (m && !m.parent) this.loadOpenBelow(m);
  }

  private load(parent: Member, record: AgentRecord): Member {
    const rootId = parent.tree.root.session.conversation.id;
    const convId = agentConversationId(rootId, record.agentId);
    const recent = this.unloadedRecently.get(convId);
    this.unloadedRecently.delete(convId);
    this.pruneUnloaded();
    // The session's own copy is ahead of the file — but its `inbox` is the one
    // it was loaded with, long since delivered or dropped. What is still owed is
    // what its queue held when it was unloaded, exactly as the file will say
    // once its writes land (a hard Stop's drops included).
    const conversation = recent ? withInbox(recent.conversation, recent.queuedMessages) : this.deps.loadConversation(convId);
    if (!conversation) throw new Error(`Sub-agent "${record.name}" could not be loaded from disk.`);
    const session = this.deps.startAgent({ config: parent.session.config, conversation, rootId });
    const child = this.attach(session, record, parent, parent.tree);
    // A child spawned stricter stays stricter (P9d); the parent's mode, as it
    // stands now, is still the ceiling.
    const ceiling = parent.session.modeAhead;
    const mode = record.mode ? stricter(record.mode, ceiling) : ceiling;
    child.session.setModeApproval(mode, parent.session.approval);
    this.track(child.session.setSpendCap(parent.tree.root.session.spendCapUsd ?? null));
    return child;
  }

  // ---- Delivery.

  /**
   * Record `body` on `to` now, and open its turn once the caller's stack has
   * unwound. The text it reads names the sender and, for a task, what it is —
   * rendered here, once, so the transcript replays it byte-identically.
   */
  private deliver(
    to: Member,
    from: Member,
    kind: InboundMessage["kind"],
    body: string,
    opts: { openTurn?: boolean } = {},
  ): void {
    to.session.receive({ id: newId("msg"), from: from.name, kind, text: this.render(to, from, kind, body) });
    // Sent from a turn a person stopped — the rest of a soft-stopped batch, or a
    // spawn that finished after the Stop landed — it is delivered but parked:
    // nothing in a stopped subtree starts a turn after the Stop (D-34).
    if (opts.openTurn !== false && !from.session.stopping) this.later(() => to.session.startNext());
  }

  private render(to: Member, from: Member, kind: InboundMessage["kind"], body: string): string {
    if (kind === "task") {
      return (
        `[Task from your parent agent "${from.name}". You are sub-agent "${to.name}". Your replies are not passed ` +
        `on by themselves — when you have results, send them with send_message(to: "parent").]\n\n${body}`
      );
    }
    if (kind === "finished") return body;
    if (kind === "question") {
      return (
        `[Question from your sub-agent "${from.name}" — it is paused until it gets an answer. Reply with ` +
        `send_message(to: "${from.name}"): your message is its answer. If you cannot answer, ask your own ` +
        `questioner with ask.]\n\n${body}`
      );
    }
    const who =
      from === to.parent ? `your parent agent "${from.name}"` : from.parent === to ? `your sub-agent "${from.name}"` : `agent "${from.name}"`;
    return `[Message from ${who}]\n\n${body}`;
  }

  /** A sub-agent came to rest: tell its parent who, never what (Q6). A child a
   *  person stopped is reported too, but parked: a Stop must not start a turn. */
  private notifyParent(child: Member, outcome: "finished" | "failed" | "stopped"): void {
    const parent = child.parent;
    if (!parent) return;
    const busy = this.descendants(child).filter((d) => d.session.status === "running" || d.session.status === "queued").length;
    const what =
      outcome === "finished"
        ? "has finished its turn and is idle"
        : outcome === "failed"
          ? "stopped on an error and is idle"
          : "was stopped by the user";
    const still = busy > 0 ? ` (${busy} of its own sub-agent${busy === 1 ? " is" : "s are"} still working)` : "";
    const text =
      `[Sub-agent "${child.name}" ${what}${still}. It does not send its results on its own — ` +
      `ask it with send_message if you need them.]`;
    this.deliver(parent, child, "finished", text, { openTurn: outcome !== "stopped" });
  }

  // ---- The width brake (D-89).

  admit(session: Session): boolean {
    const tree = this.member(session).tree;
    const cap = agentConcurrencyLimit(this.rootConfig(tree));
    if (cap === 0) return true;
    this.prune(tree);
    if (tree.waiting.length === 0 && this.running(tree) < cap) return true;
    if (!tree.waiting.includes(session)) tree.waiting.push(session);
    return false;
  }

  private running(tree: Tree): number {
    return this.treeMembers(tree).filter((m) => m.session.status === "running").length;
  }

  /** Forget waiters that stopped waiting — a person typed to one (human turns
   *  never queue), a Stop, a close. */
  private prune(tree: Tree): void {
    tree.waiting = tree.waiting.filter((s) => s.status === "queued" && this.members.get(s.id)?.tree === tree);
  }

  /** Start waiting turns while there is room. Each start is synchronous up to
   *  the session's first await, so it is `running` before the next count. */
  private pump(tree: Tree): void {
    this.prune(tree);
    const cap = agentConcurrencyLimit(this.rootConfig(tree));
    while (tree.waiting.length > 0 && (cap === 0 || this.running(tree) < cap)) {
      this.track(tree.waiting.shift()!.startQueued());
    }
  }

  // ---- Roll-ups (D-33, Q10).

  treeSpendUsd(session: Session): number {
    const m = this.members.get(session.id);
    if (!m) return session.spendUsd;
    const loaded = this.treeMembers(m.tree);
    return loaded.reduce((sum, x) => sum + x.session.spendUsd, 0) + this.offlineSpend(m.tree, loaded);
  }

  /** What the tree's unloaded agents spent (H-18a): every recorded agent not
   *  in memory, closed or under a closed one. One never loaded in this process
   *  — closed before a restart — is folded from its log once, the way a session
   *  folds its own on load (D-33): the provider's cost per call where it was
   *  reported, else token counts at the root's pricing. */
  private offlineSpend(tree: Tree, loaded: Member[]): number {
    const live = new Set(loaded.map((x) => x.agentId));
    let sum = 0;
    for (const r of this.records(tree)) {
      if (live.has(r.agentId)) continue;
      let spent = tree.offline.get(r.agentId);
      if (spent === undefined) {
        const conv = this.deps.loadConversation(agentConversationId(this.rootId(tree), r.agentId));
        const pricing = this.rootConfig(tree).pricing;
        spent = (conv?.entries ?? []).reduce((acc, e) => (e.type === "assistant" ? acc + computeCost(e.usage, pricing) : acc), 0);
        tree.offline.set(r.agentId, spent);
      }
      sum += spent;
    }
    return sum;
  }

  subtree(session: Session): SubtreeSummary {
    const m = this.members.get(session.id);
    const below = m ? this.descendants(m) : [];
    const count = (pred: (s: Session) => boolean) => below.filter((d) => pred(d.session)).length;
    return {
      agents: below.length,
      running: count((s) => s.status === "running"),
      queued: count((s) => s.status === "queued"),
      waiting: count(waitsForYou),
      spendUsd: below.reduce((sum, d) => sum + d.session.spendUsd, 0),
      closed: m ? this.closedChildren(m) : [],
    };
  }

  /** `m`'s own closed children, for its rail list (P9f). */
  private closedChildren(m: Member): ClosedAgent[] {
    const rootId = this.rootId(m.tree);
    return this.childRecords(m)
      .filter((r) => r.closed && ![...m.children].some((c) => c.agentId === r.agentId))
      .map((r) => ({
        agentId: r.agentId,
        name: r.name,
        conversationId: agentConversationId(rootId, r.agentId),
        below: this.recordedBelow(m.tree, r.agentId),
      }));
  }

  private onEvent(member: Member, e: SessionEvent): void {
    if (e.type === "status") {
      if (member.tree.waiting.length > 0) this.later(() => this.pump(member.tree));
      for (let a = member.parent; a; a = a.parent) this.dirty.add(a);
      this.scheduleFlush();
    } else if (e.type === "settled") {
      this.notifyParent(member, e.outcome);
    }
  }

  /** Announce changed subtrees once per tick, however many statuses moved. */
  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.later(() => {
      this.flushScheduled = false;
      const parents = [...this.dirty];
      this.dirty.clear();
      for (const p of parents) if (this.members.get(p.session.id) === p) p.session.reportSubtree(this.subtree(p.session));
    });
  }

  // ---- Stop, close, cap — the tree-wide controls (D-33, D-34).

  /** Stop a session and everything below it, top-down: a parent stopped first
   *  parks its children's "was stopped" notices instead of acting on them. */
  stop(session: Session, scope: "hard" | "soft"): void {
    const m = this.members.get(session.id);
    for (const x of m ? [m, ...this.descendants(m)] : []) x.session.stop(scope);
    if (!m) session.stop(scope);
  }

  /**
   * Close a session (P9f, X-56 Q18–Q20): hard-stop it and everything below it
   * and take them out of the tree — **unloaded**. A sub-agent is also marked
   * closed in its tree's file, so it stays grey in its parent's rail list and
   * out of `list_agents` and Wake until a click or a message reopens it; its
   * descendants keep their own flags and fold away with it. A root closes into
   * history, as before: its tree comes back with it.
   *
   * Returns every session unloaded; they are also handed to `onUnloaded`.
   */
  close(session: Session): Session[] {
    const m = this.members.get(session.id);
    if (!m) {
      session.stop("hard");
      this.deps.onUnloaded?.([session]);
      return [session];
    }
    if (m.agentId !== null) {
      const record = this.records(m.tree).find((r) => r.agentId === m.agentId);
      if (record) this.markClosed(m.tree, record, true);
    }
    return this.unload(m);
  }

  private unload(m: Member): Session[] {
    const all = [m, ...this.descendants(m)];
    // Leave the tree **before** the Stop: a closed agent is not a stopped one,
    // and its parent must not be told it was stopped by the user (H-17f).
    for (const x of all) x.unsub();
    for (const x of all) x.session.stop("hard");
    for (const x of all.reverse()) {
      if (x.agentId !== null) m.tree.offline.set(x.agentId, x.session.spendUsd);
      x.session.clearAgentHost();
      x.parent?.children.delete(x);
      this.members.delete(x.session.id);
    }
    for (let a = m.parent; a; a = a.parent) this.dirty.add(a);
    this.scheduleFlush();
    if (m.tree.waiting.length > 0) this.later(() => this.pump(m.tree));
    const sessions = all.map((x) => x.session);
    this.pruneUnloaded();
    for (const s of sessions) {
      if (s.agentInfo?.parentSessionId && this.deps.writesPending?.(s.conversation.id)) this.unloadedRecently.set(s.conversation.id, s);
    }
    this.deps.onUnloaded?.(sessions);
    return sessions;
  }

  /** Forget unloaded sessions whose writes have landed: the file is whole again. */
  private pruneUnloaded(): void {
    for (const id of this.unloadedRecently.keys()) if (!this.deps.writesPending?.(id)) this.unloadedRecently.delete(id);
  }

  /** A person clicked a closed sub-agent (Q18): load it — and its own open
   *  subtree — at rest, and clear its flag. `parent` is the live session it
   *  hangs under. Returns the reopened session. */
  reopen(parent: Session, agentId: string): Session {
    const p = this.member(parent);
    const live = [...p.children].find((c) => c.agentId === agentId);
    if (live) return live.session;
    const record = this.childRecords(p).find((r) => r.agentId === agentId);
    if (!record) throw new Error(`No sub-agent ${agentId} under this session.`);
    return this.revive(p, record).session;
  }

  /** `close_agent` (P9f, Q20): an agent closes one of its own children. */
  closeChild(session: Session, name: string): string {
    const m = this.member(session);
    const wanted = name.trim();
    const record = this.childRecords(m).find((r) => r.name === wanted);
    if (!record) {
      const names = this.childRecords(m).map((r) => `"${r.name}"`);
      throw new Error(
        `No sub-agent "${wanted}" of yours to close. ` +
          (names.length > 0 ? `Your sub-agents: ${names.join(", ")}.` : "You have no sub-agents."),
      );
    }
    const live = [...m.children].find((c) => c.agentId === record.agentId);
    if (!live && record.closed) return `"${record.name}" is already closed.`;
    const below = this.recordedBelow(m.tree, record.agentId);
    if (live) this.close(live.session);
    else this.markClosed(m.tree, record, true);
    return (
      `Closed "${record.name}"${below > 0 ? ` and folded the ${below} sub-agent${below === 1 ? "" : "s"} under it` : ""}. ` +
      `Its log is kept; a send_message to it reopens it.`
    );
  }

  /**
   * `set_agent_mode` (P9f2, X-58): an agent changes one of its own children's
   * mode — any mode up to its own, with no card (Joshua's ruling: it grants
   * nothing the caller could not spawn). Recorded on the child's `AgentRecord`,
   * so a revival keeps it (still capped at the parent's mode then). It lands
   * between the child's batches and the child is told by a note before its
   * next model call; it starts no turn. A closed child is refused — a message
   * reopens it, and then it can be told. Tightening caps the child's live
   * descendants now (never loosens them); their own records are untouched, and
   * a revival caps them against their parent's mode as always.
   */
  setAgentMode(session: Session, name: string, mode: Mode): string {
    const m = this.member(session);
    const wanted = name.trim();
    const records = this.childRecords(m);
    const record = records.find((r) => r.name === wanted);
    if (!record) {
      const names = records.map((r) => `"${r.name}"`);
      throw new Error(
        `set_agent_mode refused: no sub-agent "${wanted}" of yours — it acts on your own sub-agents only. ` +
          (names.length > 0 ? `Yours: ${names.join(", ")}.` : "You have no sub-agents."),
      );
    }
    // Against the mode the caller is headed for: a tightening of its own held
    // for its batch is already its ceiling (P9f2, round 1).
    const own = session.modeAhead;
    if (modeRank(mode) > modeRank(own)) {
      throw new Error(
        `set_agent_mode refused: you are in ${own} mode, and a sub-agent may be at most as loose as you ` +
          `(${MODES.slice(0, modeRank(own) + 1).join(", ")}). "${record.name}" is unchanged.`,
      );
    }
    const live = [...m.children].find((c) => c.agentId === record.agentId);
    if (!live) {
      throw new Error(
        `set_agent_mode refused: "${record.name}" is closed. A send_message to it reopens it; set its mode after that.`,
      );
    }
    const was = live.session.modeAhead;
    // Recorded even when unchanged, as spawn does: it names a fixed mode from
    // here on, so a revival does not read it off a parent loosened since.
    record.mode = mode;
    this.deps.setMode?.(this.rootId(m.tree), record.agentId, mode);
    const also = (capped: string[]) => (capped.length > 0 ? ` Also capped (below it): ${capped.map((n) => `"${n}"`).join(", ")}.` : "");
    // Unchanged, but a person may have tightened it by hand without passing that
    // on: what is below it is still held to it.
    if (was === mode) return `"${record.name}" is already in ${mode} mode.${also(this.capBelow(live))}`;
    this.tellMode(live, mode, `[Your parent agent "${m.name}" set your mode to ${mode} — ${MODE_MEANS[mode]}.]`);
    const capped = modeRank(mode) < modeRank(was) ? this.capBelow(live) : [];
    return (
      `Set "${record.name}" to ${mode} mode (was ${was}). It applies from its next step — a call already under way ` +
      `finishes as it began — and it is told so. This starts no work: if it is idle, send_message it to carry on.` +
      also(capped)
    );
  }

  /** A parent's change held for a batch just landed on `session` (P9f2): hold
   *  everything below it to it. The invariant: a live sub-agent is never looser
   *  than its parent's current or pending mode. */
  modeLanded(session: Session): void {
    const m = this.members.get(session.id);
    if (m) this.capBelow(m);
  }

  private tellMode(m: Member, mode: Mode, text: string): void {
    m.session.setModeFromParent(mode, { id: newId("msg"), from: m.parent!.name, kind: "mode", text });
  }

  /** A child was tightened (P9f2): any live agent below it now looser than its
   *  own parent is capped there, top-down, and told. Never loosened. */
  private capBelow(m: Member): string[] {
    const capped: string[] = [];
    const ceiling = m.session.modeAhead;
    for (const c of m.children) {
      if (modeRank(c.session.modeAhead) > modeRank(ceiling)) {
        this.tellMode(
          c,
          ceiling,
          `[Your mode was capped at ${ceiling} — ${MODE_MEANS[ceiling]}. Your parent agent "${m.name}" was set to ` +
            `${ceiling} mode, and a sub-agent is never looser than its parent.]`,
        );
        capped.push(c.name);
      }
      capped.push(...this.capBelow(c));
    }
    return capped;
  }

  /** `list_agents` (P9f, Q20): the caller's own sub-agents, how each stands,
   *  closed ones only when asked. */
  listAgents(session: Session, showClosed: boolean): string {
    const m = this.member(session);
    const records = this.childRecords(m);
    if (records.length === 0) return "You have no sub-agents.";
    const rows: string[] = [];
    let hidden = 0;
    for (const r of records) {
      const live = [...m.children].find((c) => c.agentId === r.agentId);
      if (!live && r.closed) {
        if (!showClosed) {
          hidden++;
          continue;
        }
        rows.push(`- ${r.name} — closed`);
        continue;
      }
      const s = live?.session;
      rows.push(s ? `- ${r.name} — ${s.config.name} (${s.config.model}) — ${describeStatus(s)}` : `- ${r.name} — not loaded`);
    }
    const head = rows.length > 0 ? ["Your sub-agents:", ...rows] : ["You have no open sub-agents."];
    if (hidden > 0) head.push(`(${hidden} closed not shown — pass show_closed: true to list them.)`);
    return head.join("\n");
  }

  /**
   * Wake (P9f, X-56 Q14): resume what the log says was cut off in `session`'s
   * subtree — interrupted turns the way Retry resumes them, owed messages as
   * delivery opens them — and leave the rest asleep. Closed agents are not
   * loaded, so they and everything under them are skipped (Q20); they are
   * named in the report. Top-down, and each start goes through `admit`: a
   * Wake never takes the tree past its width cap (D-89), and it is never human
   * input, so no tool-round budget starts over.
   */
  wake(session: Session): WakeReport {
    const report: WakeReport = { woken: [], queued: [], asleep: [], busy: [], blocked: [], closed: [] };
    const m = this.members.get(session.id);
    const all = m ? [m, ...this.descendants(m)] : [];
    const bucket: Record<WakeOutcome, string[]> = {
      woken: report.woken,
      queued: report.queued,
      quiescent: report.asleep,
      busy: report.busy,
      blocked: report.blocked,
    };
    if (!m) {
      const { outcome, done } = session.wake();
      this.track(done);
      bucket[outcome].push(session.agentInfo?.name ?? ROOT_AGENT_NAME);
      return report;
    }
    for (const x of all) {
      const { outcome, done } = x.session.wake();
      this.track(done);
      bucket[outcome].push(x.name);
      for (const r of this.childRecords(x)) if (r.closed) report.closed.push(r.name);
    }
    return report;
  }

  /** `wake_agents` (P9f): the root wakes its own tree — itself excluded, as it
   *  is the one calling. Only the root may: a tree has one place to wake it from. */
  wakeAgents(session: Session): string {
    const m = this.member(session);
    if (m.parent) throw new Error("wake_agents is the root thread's: only the agent the user started may wake its tree.");
    const report = this.wake(session);
    const others = (names: string[]) => names.filter((n) => n !== m.name);
    const line = (label: string, names: string[]) => (names.length > 0 ? [`${label}: ${names.join(", ")}`] : []);
    const lines = [
      ...line("Woken", others(report.woken)),
      ...line("Waiting for a slot (the tree's concurrency cap), then woken", others(report.queued)),
      ...line("Left asleep (finished, nothing owed)", others(report.asleep)),
      ...line("Not at rest (working, or waiting on someone)", others(report.busy)),
      ...line("Held (spend cap, error limit, a missing model or a Stop) — the user must clear it", others(report.blocked)),
      ...line("Closed, not woken (a message reopens one)", report.closed),
    ];
    if (lines.length === 0) return "You have no sub-agents to wake.";
    return [...lines, "Woken agents send you a notice when they finish a turn, as before."].join("\n");
  }

  /** The spend cap is the tree's (D-33): set on any member, it applies to all,
   *  and raising it resumes every member parked on it. */
  async setCap(session: Session, capUsd: number | null): Promise<void> {
    const m = this.members.get(session.id);
    if (!m) return session.setSpendCap(capUsd);
    const others = this.treeMembers(m.tree).filter((x) => x !== m);
    for (const x of others) this.track(x.session.setSpendCap(capUsd));
    await session.setSpendCap(capUsd);
  }

  // ---- Background work.

  /** Run `fn` off the current call stack, tracked so `idle()` can wait for it. */
  private later(fn: () => Promise<void> | void): void {
    this.track(Promise.resolve().then(fn));
  }

  private track(p: Promise<void>): void {
    const tracked: Promise<void> = p
      .catch((err: unknown) => this.deps.onError?.(err))
      .finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);
  }

  /** Resolves once no background turn this coordinator started is still in
   *  flight — what tests (and a clean shutdown) wait on instead of sleeping. */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }
}
