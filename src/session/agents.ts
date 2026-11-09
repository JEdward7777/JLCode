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
import { agentConcurrencyLimit, agentDepthLimit, toolRoundsOff } from "../config/operations.js";
import { MODES, type Mode, type ModelConfig } from "../config/types.js";
import type { Conversation } from "../conversation/types.js";
import { agentConversationId, type AgentRecord } from "../persist/conversation-store.js";
import type { AgentHost, Session } from "./session.js";
import type { AskUserRequest, InboundMessage, SessionEvent, SubtreeSummary } from "./types.js";

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

export class AgentCoordinator implements AgentHost {
  private readonly members = new Map<string, Member>();
  private readonly inflight = new Set<Promise<void>>();
  /** Parents whose subtree changed since the last `subtree` announcement. */
  private readonly dirty = new Set<Member>();
  private flushScheduled = false;

  constructor(private readonly deps: AgentCoordinatorDeps) {}

  // ---- Membership.

  /** Make a session the root of its own tree — every thread the human starts. */
  adoptRoot(session: Session): void {
    if (this.members.has(session.id)) return;
    const tree = { waiting: [], nextIndex: undefined } as unknown as Tree;
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
    parent?.children.add(member);
    session.setAgentHost(this, {
      name: who.name,
      depth: who.depth,
      parentSessionId: parent?.session.id ?? null,
      rootSessionId: tree.root?.session.id ?? session.id,
    });
    member.unsub = session.onEvent((e) => this.onEvent(member, e));
    return member;
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
    if (mode !== undefined && modeRank(mode) > modeRank(session.mode)) {
      throw new Error(
        `spawn_agent refused: you are in ${session.mode} mode, and a sub-agent may only be as strict or stricter ` +
          `(${MODES.slice(0, modeRank(session.mode) + 1).join(", ")}). Nothing was started.`,
      );
    }
    const config = this.pickConfig(session, model);
    const rootId = tree.root.session.conversation.id;
    const tighter = mode !== undefined && mode !== session.mode;
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
      const used = this.deps
        .agentRecords(tree.root.session.conversation.id)
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
    child.session.setModeApproval(mode ? stricter(mode, parent.mode) : parent.mode, parent.approval);
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
    const rootId = sender.tree.root.session.conversation.id;
    const records = this.deps.agentRecords(rootId).filter((r) => r.parentAgentId === sender.agentId);
    const record = records.find((r) => r.name === wanted);
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
    const rootId = parent.tree.root.session.conversation.id;
    const conversation = this.deps.loadConversation(agentConversationId(rootId, record.agentId));
    if (!conversation) throw new Error(`Sub-agent "${record.name}" could not be loaded from disk.`);
    const session = this.deps.startAgent({ config: parent.session.config, conversation, rootId });
    const child = this.attach(session, record, parent, parent.tree);
    // A child spawned stricter stays stricter (P9d); the parent's mode, as it
    // stands now, is still the ceiling.
    const mode = record.mode ? stricter(record.mode, parent.session.mode) : parent.session.mode;
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
    return this.treeMembers(m.tree).reduce((sum, x) => sum + x.session.spendUsd, 0);
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
    };
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

  /** Hard-stop a session and its subtree and take them out of the tree.
   *  Returns every session closed, for the caller to drop from the bag. A
   *  closed child can still be messaged — that revives it from disk. */
  close(session: Session): Session[] {
    const m = this.members.get(session.id);
    if (!m) {
      session.stop("hard");
      return [session];
    }
    const all = [m, ...this.descendants(m)];
    for (const x of all) x.session.stop("hard");
    for (const x of all.reverse()) {
      x.unsub();
      x.session.clearAgentHost();
      x.parent?.children.delete(x);
      this.members.delete(x.session.id);
    }
    return all.map((x) => x.session);
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
