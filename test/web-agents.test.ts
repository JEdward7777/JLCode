/**
 * P9e — sub-agents in the browser (X-56 Q11, D-88): `web/src/agents.ts` and the
 * reducer folds behind it.
 *
 * Tier-0 throughout: the tree the rail nests, the dot each agent wears, what a
 * folded parent shows of its subtree (D-93's `waitsForYou` — a question put to
 * the parent agent never lights it), how an agent card's link resolves, and
 * which transcript entries become cards.
 */
import { describe, it, expect } from "vitest";
import { agentCard, agentStatus, buildRailTree, lineage, resolveAgent, rollup, waitsForYou } from "../web/src/agents";
import { attentionOf } from "../web/src/attention";
import { applyDescriptor, applyState, newSlice, reduceEvent, sliceFromDescriptor, type SessionSlice } from "../web/src/session-state";
import type { AgentInfo, EntryView } from "../web/src/api";

const info = (name: string, depth: number, parent: string | null, root = "r"): AgentInfo => ({
  name,
  depth,
  parentSessionId: parent,
  rootSessionId: root,
});

function slice(id: string, agent: AgentInfo | null, patch: Partial<SessionSlice> = {}): SessionSlice {
  return { ...newSlice(id), agent, ...patch };
}

const approval = { id: "a1", tool: "write_file", args: {}, kind: "write" } as unknown as SessionSlice["pendingApproval"];
const askUser = { id: "q1", questions: [{ question: "which?" }] } as SessionSlice["pendingAsk"];
const askParent = { ...askUser!, to: "parent" as const };

/** root → a1 → a3, root → a2. */
function threeLevels(patch: Record<string, Partial<SessionSlice>> = {}): SessionSlice[] {
  return [
    slice("r", info("root", 0, null), patch.r),
    slice("a1", info("agent-1", 1, "r"), patch.a1),
    slice("a2", info("agent-2", 1, "r"), patch.a2),
    slice("a3", info("agent-3", 2, "a1"), patch.a3),
  ];
}

describe("the rail's tree (Q11)", () => {
  it("nests sub-agents under their parents, in arrival order, at every level", () => {
    const tree = buildRailTree(threeLevels());
    expect(tree.map((n) => n.slice.id)).toEqual(["r"]);
    expect(tree[0]!.children.map((n) => n.slice.id)).toEqual(["a1", "a2"]);
    expect(tree[0]!.children[0]!.children.map((n) => [n.slice.id, n.level])).toEqual([["a3", 2]]);
  });

  it("keeps several trees apart, and an unlinked or orphaned agent on top rather than lost", () => {
    const slices = [
      slice("r", info("root", 0, null)),
      slice("x", null), // a pre-P9c thread, or a child whose `agent` event has not landed
      slice("o", info("agent-9", 1, "gone")), // its parent was closed
      slice("a1", info("agent-1", 1, "r")),
    ];
    const tree = buildRailTree(slices);
    expect(tree.map((n) => n.slice.id)).toEqual(["r", "x", "o"]);
    expect(tree[0]!.children.map((n) => n.slice.id)).toEqual(["a1"]);
  });

  it("never drops a card over a parent link that loops", () => {
    const tree = buildRailTree([slice("p", info("agent-1", 1, "q")), slice("q", info("agent-2", 1, "p"))]);
    const ids = new Set<string>();
    const walk = (ns: typeof tree) => ns.forEach((n) => (ids.add(n.slice.id), walk(n.children)));
    walk(tree);
    expect([...ids].sort()).toEqual(["p", "q"]);
  });
});

describe("the status dot", () => {
  it("names running, queued, idle, finished and waiting-for-you", () => {
    expect(agentStatus(slice("a", null, { status: "running", working: true }), true)).toEqual({ dot: "busy", label: "working…" });
    expect(agentStatus(slice("a", null, { status: "queued" }), true)).toEqual({ dot: "queued", label: "queued" });
    expect(agentStatus(slice("a", null), true)).toEqual({ dot: "idle", label: "idle" });
    expect(agentStatus(slice("a", null, { restedAs: "finished" }), true)).toEqual({ dot: "done", label: "finished" });
    expect(agentStatus(slice("a", null, { pendingApproval: approval, status: "awaiting-approval" }), true).dot).toBe("attn");
    expect(agentStatus(slice("a", null, { pendingAsk: askUser, status: "awaiting-input" }), true).dot).toBe("attn");
  });

  it("only a sub-agent reads finished — a root at rest is still idle, the person's turn", () => {
    expect(agentStatus(slice("r", null, { restedAs: "finished" }), false).label).toBe("idle");
  });

  it("a stopped or failed turn is idle, not finished", () => {
    expect(agentStatus(slice("a", null, { restedAs: "stopped" }), true).dot).toBe("idle");
    expect(agentStatus(slice("a", null, { restedAs: "failed" }), true).dot).toBe("idle");
  });

  it("a question to the parent agent is a ring, not a call on you (P9d)", () => {
    const s = slice("a", null, { pendingAsk: askParent, status: "awaiting-input" });
    expect(agentStatus(s, true)).toEqual({ dot: "asking", label: "asks parent" });
    expect(waitsForYou(s)).toBe(false);
  });

  it("an awaiting-input status whose card has not landed claims no addressee", () => {
    const s = slice("a", null, { status: "awaiting-input" });
    expect(agentStatus(s, true).label).toBe("waiting…");
    expect(waitsForYou(s)).toBe(false);
  });

  it("a pause this build never heard of still waits for you (D-80)", () => {
    const s = slice("a", null, { status: "awaiting-something-new" });
    expect(agentStatus(s, true).dot).toBe("attn");
    expect(waitsForYou(s)).toBe(true);
  });
});

describe("a folded parent shows its most urgent descendant (Q11)", () => {
  it("a grandchild on an approval lights the root", () => {
    const slices = threeLevels({
      a1: { restedAs: "finished" },
      a2: { status: "running", working: true },
      a3: { pendingApproval: approval, status: "awaiting-approval" },
    });
    const r = rollup(buildRailTree(slices)[0]!);
    expect(r.count).toBe(3);
    expect(r.waiting).toBe(true);
    expect(r.top?.slice.id).toBe("a3");
    expect(r.top?.status.label).toBe("needs approval");
  });

  it("a parent-addressed question does not light it, though it still shows", () => {
    const slices = threeLevels({ a1: { restedAs: "finished" }, a2: { restedAs: "finished" }, a3: { pendingAsk: askParent, status: "awaiting-input" } });
    const r = rollup(buildRailTree(slices)[0]!);
    expect(r.waiting).toBe(false);
    expect(r.top?.status.dot).toBe("asking");
  });

  it("work in flight outranks a queue, which outranks rest; ties go to rail order", () => {
    const q = rollup(buildRailTree(threeLevels({ a1: { status: "queued" }, a2: { status: "running" } }))[0]!);
    expect(q.top?.slice.id).toBe("a2");
    const tie = rollup(buildRailTree(threeLevels({ a1: { restedAs: "finished" }, a2: { restedAs: "finished" }, a3: { restedAs: "finished" } }))[0]!);
    expect(tie.top?.slice.id).toBe("a1");
    expect(tie.waiting).toBe(false);
  });

  it("a leaf has nothing to roll up", () => {
    const r = rollup(buildRailTree([slice("r", info("root", 0, null))])[0]!);
    expect(r).toEqual({ count: 0, top: null, waiting: false });
  });
});

describe("links between agents", () => {
  const slices = threeLevels();
  const [r, a1, , a3] = slices as [SessionSlice, SessionSlice, SessionSlice, SessionSlice];

  it("resolves a child by name, and the parent by name or as `parent`", () => {
    expect(resolveAgent(slices, r, "agent-1")).toBe("a1");
    expect(resolveAgent(slices, a1, "agent-3")).toBe("a3");
    expect(resolveAgent(slices, a3, "agent-1")).toBe("a1");
    expect(resolveAgent(slices, a1, "parent")).toBe("r");
    expect(resolveAgent(slices, a1, "root")).toBe("r");
  });

  it("reaches no further than D-88 lets an agent talk, and nothing that is not live", () => {
    expect(resolveAgent(slices, r, "agent-3")).toBeUndefined(); // a grandchild
    expect(resolveAgent(slices, a1, "agent-2")).toBeUndefined(); // a sibling
    expect(resolveAgent(slices, r, "agent-7")).toBeUndefined(); // closed
    expect(resolveAgent(slices, r, "parent")).toBeUndefined(); // a root has none
  });

  it("names a sub-agent's ancestors, root first", () => {
    expect(lineage(slices, a3).map((s) => s.id)).toEqual(["r", "a1"]);
    expect(lineage(slices, r)).toEqual([]);
  });
});

describe("transcript cards (Q11)", () => {
  const user = (text: string, inbound?: EntryView["inbound"]): EntryView => ({ id: "u", parent: null, type: "user", text, ...(inbound ? { inbound } : {}) });
  const tool = (name: string, content: string, isError = false): EntryView => ({ id: "t", parent: null, type: "tool", name, content, isError });

  it("the person's own message is not a card", () => {
    expect(agentCard(user("hello"))).toBeNull();
    expect(agentCard(tool("read_file", "x"))).toBeNull();
  });

  it("a spawn is `spawned`, naming the agent, its model and the task", () => {
    const card = agentCard(
      tool("spawn_agent", 'Started sub-agent "agent-2" on sonnet (anthropic/claude-sonnet-5) in ask mode. It is working in the background…'),
      JSON.stringify({ task: "read the notes", model: "sonnet", mode: "ask" }),
    );
    expect(card).toEqual({ kind: "spawned", peer: "agent-2", head: "spawned", body: "read the notes", detail: "sonnet · ask mode" });
  });

  it("a refused spawn links nowhere", () => {
    const card = agentCard(tool("spawn_agent", "spawn_agent refused: too deep", true), JSON.stringify({ task: "x" }));
    expect(card).toMatchObject({ kind: "refused", peer: null });
  });

  it("send_message is → sent, and an answer to a child's question says so", () => {
    expect(agentCard(tool("send_message", 'Sent to "agent-1".'), JSON.stringify({ to: "agent-1", text: "carry on" }))).toEqual({
      kind: "sent",
      peer: "agent-1",
      head: "→",
      body: "carry on",
    });
    const answer = agentCard(
      tool("send_message", 'Sent to "agent-1" as the answer to its question; it carries on from there.'),
      JSON.stringify({ to: "agent-1", text: "notes.txt" }),
    );
    expect(answer?.head).toBe("→ answered");
  });

  it("inbound traffic is ← received, its attribution header stripped", () => {
    const msg = agentCard(user('[Message from your sub-agent "agent-1"]\n\nhello', { id: "m", from: "agent-1", kind: "message" }));
    expect(msg).toEqual({ kind: "received", peer: "agent-1", head: "←", body: "hello" });
    const task = agentCard(user('[Task from your parent agent "root". You are sub-agent "agent-1". …]\n\ndo it', { id: "m", from: "root", kind: "task" }));
    expect(task).toMatchObject({ head: "← task from", peer: "root", body: "do it" });
    const q = agentCard(user('[Question from your sub-agent "agent-1" — …]\n\nwhich?', { id: "m", from: "agent-1", kind: "question" }));
    expect(q).toMatchObject({ head: "← question from", body: "which?" });
  });

  it("a completion notice is `finished` — or says it failed or was stopped", () => {
    const n = (t: string) => agentCard(user(t, { id: "m", from: "agent-1", kind: "finished" }));
    expect(n('[Sub-agent "agent-1" has finished its turn and is idle. It does not send…]')).toEqual({
      kind: "finished",
      peer: "agent-1",
      head: "finished",
      body: "",
    });
    expect(n('[Sub-agent "agent-1" has finished its turn and is idle (2 of its own sub-agents are still working). …]')?.body).toBe(
      "its own sub-agents still working: 2",
    );
    expect(n('[Sub-agent "agent-1" stopped on an error and is idle. …]')).toMatchObject({ head: "failed", tone: "warn" });
    expect(n('[Sub-agent "agent-1" was stopped by the user. …]')).toMatchObject({ head: "stopped", tone: "warn" });
  });
});

describe("the reducer carries what the rail needs", () => {
  it("an `agent` event links a sub-agent whose added frame had no place yet", () => {
    const added = sliceFromDescriptor({ id: "a1", model: "m", agent: null, state: { status: "idle" } });
    expect(added.agent).toBeNull();
    const linked = reduceEvent(added, { type: "agent", info: info("agent-1", 1, "r") });
    expect(linked.agent).toEqual(info("agent-1", 1, "r"));
    // A later frame that still says null must not unlink it.
    expect(applyDescriptor(linked, { id: "a1", model: "m", agent: null, state: { agent: null } }).agent).toEqual(info("agent-1", 1, "r"));
  });

  it("every status move is folded, and a new turn is no longer at rest", () => {
    let s = applyState(newSlice("a"), { status: "idle", restedAs: "finished" });
    expect(s.restedAs).toBe("finished");
    s = reduceEvent(s, { type: "status", status: "queued" });
    expect(s).toMatchObject({ status: "queued", restedAs: null });
    s = reduceEvent(s, { type: "status", status: "running" });
    expect(s.status).toBe("running");
    s = reduceEvent(s, { type: "status", status: "idle" });
    s = reduceEvent(s, { type: "settled", outcome: "finished" });
    expect(s).toMatchObject({ status: "idle", restedAs: "finished" });
  });

  it("an approval answered elsewhere no longer leaves the rail saying waiting (H-16a)", () => {
    let s = applyState(newSlice("a"), { status: "awaiting-approval", approvalRequest: approval! });
    s = { ...s, pendingApproval: null }; // the card was resolved
    s = reduceEvent(s, { type: "status", status: "idle" });
    expect(agentStatus(s, false).label).toBe("idle");
  });
});

describe("attention honours the same rule (X-26)", () => {
  it("a sub-agent's question to its parent, or its coming to rest, does not call you", () => {
    const sub = info("agent-1", 1, "r");
    expect(attentionOf(slice("a", sub, { pendingAsk: askParent }))).toBeNull();
    expect(attentionOf(slice("a", sub))).toBeNull();
    expect(attentionOf(slice("a", sub, { pendingApproval: approval }))).toBe("approval");
    expect(attentionOf(slice("r", info("root", 0, null)))).toBe("idle");
  });
});

describe("a Stop fanned over a child's card retires the card (P9e R1)", () => {
  /** The bus sequence a Stop from an ancestor produces over a child on a card,
   *  as captured: no event of the card's own ends it. */
  const stopOverCard = (s: SessionSlice): SessionSlice =>
    [
      { type: "stopped", scope: "hard" },
      { type: "entry", entry: { id: "res", parent: null, type: "tool", name: "write_file", content: "stopped", isError: true } },
      { type: "tool-end", name: "write_file", isError: true },
      { type: "status", status: "idle" },
      { type: "settled", outcome: "stopped" },
    ].reduce((acc, e) => reduceEvent(acc, e), s);

  const onCard = (patch: Partial<SessionSlice>) => {
    const slices = threeLevels({ a1: { restedAs: "finished" }, a2: { restedAs: "finished" }, a3: patch });
    return { slices, a3: slices[3]! };
  };

  it("an approval card: the child, attention and the folded root all stand down", () => {
    const { slices, a3 } = onCard({ status: "awaiting-approval", pendingApproval: approval });
    expect(rollup(buildRailTree(slices)[0]!).waiting).toBe(true); // before: lit
    const stopped = stopOverCard(a3);
    expect(stopped.pendingApproval).toBeNull();
    expect(agentStatus(stopped, true).dot).not.toBe("attn");
    expect(attentionOf(stopped)).toBeNull();
    const after = slices.map((s) => (s.id === "a3" ? stopped : s));
    expect(rollup(buildRailTree(after)[0]!).waiting).toBe(false);
  });

  it("a stall card the same way", () => {
    const stall = { id: "st", rounds: 3, budget: 3, nextBudget: 6 } as unknown as SessionSlice["pendingStall"];
    const { slices, a3 } = onCard({ status: "awaiting-continue", pendingStall: stall });
    const stopped = stopOverCard(a3);
    expect(stopped.pendingStall).toBeNull();
    expect(agentStatus(stopped, true).dot).not.toBe("attn");
    expect(attentionOf(stopped)).toBeNull();
    expect(rollup(buildRailTree(slices.map((s) => (s.id === "a3" ? stopped : s)))[0]!).waiting).toBe(false);
  });

  it("every working or resting status retires all four cards; a persistence fault keeps them", () => {
    const compaction = { id: "c" } as unknown as SessionSlice["pendingCompaction"];
    const carded = slice("a", null, { pendingApproval: approval, pendingAsk: askUser, pendingStall: { id: "st" } as never, pendingCompaction: compaction });
    for (const status of ["running", "queued", "idle", "halted"]) {
      expect(reduceEvent(carded, { type: "status", status })).toMatchObject({
        pendingApproval: null,
        pendingAsk: null,
        pendingStall: null,
        pendingCompaction: null,
      });
    }
    const faulted = reduceEvent(carded, { type: "status", status: "awaiting-persistence" });
    expect(faulted.pendingApproval).toBe(approval);
    expect(faulted.pendingCompaction).toBe(compaction);
  });
});
