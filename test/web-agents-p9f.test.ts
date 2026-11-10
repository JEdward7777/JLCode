/**
 * P9f — the lifecycle in the browser (X-56 Q14, Q18): the dot a cut-off agent
 * wears, what a Wake on a rail entry would reach, how closed siblings sink and
 * fold, the tree-wide Stop an idle root keeps (H-22a), and the reducer folds
 * that carry `rest` and the closed list.
 */
import { describe, it, expect } from "vitest";
import { agentStatus, buildRailTree, closedLayout, CLOSED_FOLD_AT, rollup, subtreeWorking, wakeCount } from "../web/src/agents";
import { applyState, newSlice, reduceEvent, type SessionSlice } from "../web/src/session-state";
import type { AgentInfo, ClosedAgent } from "../web/src/api";

const info = (name: string, depth: number, parent: string | null): AgentInfo => ({
  name,
  depth,
  parentSessionId: parent,
  rootSessionId: "r",
});
const slice = (id: string, agent: AgentInfo | null, patch: Partial<SessionSlice> = {}): SessionSlice => ({ ...newSlice(id), agent, ...patch });
const closed = (n: number): ClosedAgent[] =>
  Array.from({ length: n }, (_, i) => ({ agentId: `c${i}`, name: `agent-${i + 10}`, conversationId: `r~c${i}`, below: 0 }));

describe("the cut-off dot (Q14, H-22k)", () => {
  it("reads interrupted / owes a reply at rest, never plain idle or finished", () => {
    expect(agentStatus(slice("a", null, { rest: "interrupted", restedAs: "stopped" }), true)).toEqual({ dot: "wake", label: "interrupted" });
    expect(agentStatus(slice("a", null, { rest: "owes-reply" }), true)).toEqual({ dot: "wake", label: "owes a reply" });
    expect(agentStatus(slice("a", null, { rest: "quiescent", restedAs: "finished" }), true).label).toBe("finished");
    expect(agentStatus(slice("a", null, { rest: "interrupted" }), false).label).toBe("interrupted"); // a root too
    // Loaded at rest on its own reply (a restart, a reopen): finished, by its log.
    expect(agentStatus(slice("a", null, { rest: "quiescent", restedAs: null }), true).label).toBe("finished");
    expect(agentStatus(slice("a", null, { rest: "quiescent", restedAs: null }), false).label).toBe("idle");
  });

  it("ranks between a question to the parent and a queued turn when a folded parent rolls up", () => {
    const [root] = buildRailTree([
      slice("r", info("root", 0, null)),
      slice("a", info("agent-1", 1, "r"), { status: "queued" }),
      slice("b", info("agent-2", 1, "r"), { rest: "interrupted" }),
    ]);
    expect(rollup(root!).top?.slice.id).toBe("b");
  });
});

describe("Wake's reach from a rail entry", () => {
  const tree = () =>
    buildRailTree([
      slice("r", info("root", 0, null), { rest: "quiescent" }),
      slice("a1", info("agent-1", 1, "r"), { rest: "interrupted" }),
      slice("a2", info("agent-2", 1, "r"), { rest: "quiescent" }),
      slice("a3", info("agent-3", 2, "a2"), { rest: "owes-reply" }),
    ])[0]!;

  it("counts itself and its open subtree, skipping the quiescent", () => {
    const root = tree();
    expect(wakeCount(root)).toBe(2);
    expect(wakeCount(root.children[1]!)).toBe(1); // agent-2's own subtree only
    expect(wakeCount(root.children[1]!.children[0]!)).toBe(1);
  });
});

describe("closed siblings (Q18)", () => {
  it("draws up to five one by one, and folds more into one row that opens in place", () => {
    expect(closedLayout(closed(CLOSED_FOLD_AT), false)).toEqual({ fold: null, rows: closed(CLOSED_FOLD_AT) });
    const six = closed(CLOSED_FOLD_AT + 1);
    expect(closedLayout(six, false)).toEqual({ fold: { count: 6, open: false }, rows: [] });
    expect(closedLayout(six, true)).toEqual({ fold: { count: 6, open: true }, rows: six });
  });

  it("the closed list folds from a state frame and from `subtree` events", () => {
    let s = applyState(newSlice("r"), { subtree: { agents: 0, running: 0, queued: 0, waiting: 0, spendUsd: 0, closed: closed(2) } });
    expect(s.closedAgents.map((c) => c.name)).toEqual(["agent-10", "agent-11"]);
    s = reduceEvent(s, { type: "subtree", summary: { agents: 0, running: 0, queued: 0, waiting: 0, spendUsd: 0, closed: [] } });
    expect(s.closedAgents).toEqual([]);
  });

  it("`rest` folds from state and events", () => {
    let s = applyState(newSlice("a"), { rest: "interrupted" });
    expect(s.rest).toBe("interrupted");
    s = reduceEvent(s, { type: "rest", rest: null });
    expect(s.rest).toBeNull();
  });
});

describe("the tree-wide Stop from an idle root (H-22a)", () => {
  it("stays on while anything below works, at any depth", () => {
    const slices = [
      slice("r", info("root", 0, null)),
      slice("a1", info("agent-1", 1, "r")),
      slice("a3", info("agent-3", 2, "a1"), { status: "running", working: true }),
    ];
    expect(subtreeWorking(slices, "r")).toBe(true);
    expect(subtreeWorking(slices, "a3")).toBe(false);
    expect(subtreeWorking([slices[0]!, slices[1]!], "r")).toBe(false);
    expect(subtreeWorking([slices[0]!, slice("q", info("agent-2", 1, "r"), { status: "queued" })], "r")).toBe(true);
  });
});
