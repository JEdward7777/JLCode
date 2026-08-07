import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Session } from "../src/session/session";
import { childrenOf, pathToLeaf, leafOf } from "../src/conversation/tree";
import { stripEnvironmentDetails } from "../src/conversation/wire";
import { ConversationStore } from "../src/persist/conversation-store";
import { Sandbox } from "../src/tools/sandbox";
import { ToolRegistry } from "../src/tools/registry";
import { askUserTool } from "../src/tools/ask-user";
import { scriptedDriver } from "../src/session/fake";
import type { ModelConfig } from "../src/config/types";
import type { ChatMessage, LlmDriver, StreamEvent } from "../src/llm/types";

const config: ModelConfig = {
  id: "cfg",
  name: "T",
  openRouterKey: "sk",
  model: "m",
  defaultMode: "code",
  defaultApproval: "manual",
  createdAt: "",
  updatedAt: "",
};
const reply = (t: string): StreamEvent[] => [{ type: "text", delta: t }, { type: "finish", reason: "stop" }];

/**
 * A driver that plays one scripted turn per call and can **park** the next one
 * mid-stream — the shape the H-05 repro needs, so a test can act on the session
 * while a turn is genuinely in flight rather than only between turns. `arm()`
 * resolves once the parked stream is open; `release()` lets it finish. Every
 * request is recorded so a test can assert which branch the wire was built from.
 */
function parkableDriver(script: StreamEvent[][]) {
  const requests: ChatMessage[][] = [];
  let call = 0;
  let armed = false;
  let open: (() => void) | undefined;
  let release: (() => void) | undefined;
  const driver: LlmDriver = {
    async *streamChat(req) {
      requests.push(req.messages);
      const events = script[Math.min(call++, script.length - 1)]!;
      if (armed) {
        armed = false;
        const parked = new Promise<void>((r) => (release = r));
        open?.();
        await parked;
      }
      for (const ev of events) yield ev;
    },
  };
  return {
    driver,
    requests,
    arm(): Promise<void> {
      armed = true;
      return new Promise<void>((r) => (open = r));
    },
    release(): void {
      release?.();
    },
  };
}

/** The text of the user messages in a recorded request (which branch it replayed),
 *  with X-25's per-turn `<environment_details>` framing taken back off — what is
 *  being asserted here is *which turns* were replayed, not how they are stamped. */
const userTexts = (messages: ChatMessage[]): string[] =>
  messages
    .filter((m) => m.role === "user" && typeof m.content === "string")
    .map((m) => stripEnvironmentDetails(m.content as string));

describe("fork / rewind (D-10, D-17)", () => {
  it("edit-and-fork creates a sibling branch; rewind switches between them", async () => {
    const s = new Session({ config, driver: scriptedDriver(reply("answer")) });
    await s.send("first question"); // user1, assistant1
    const user1 = s.conversation.entries[0]!;
    const assistant1 = s.conversation.entries[1]!;

    await s.editFork(user1.id, "different question"); // user2 (sibling of user1), assistant2
    expect(s.conversation.entries).toHaveLength(4);

    // The root now has two children — two branches.
    expect(childrenOf(s.conversation, null)).toHaveLength(2);

    // We're on branch B (the fork).
    const bPath = pathToLeaf(s.conversation);
    expect(bPath.map((e) => e.type)).toEqual(["user", "assistant"]);
    expect((bPath[0] as { text: string }).text).toBe("different question");

    // Rewind to branch A and confirm we see the original.
    s.setActiveLeaf(assistant1.id);
    expect(pathToLeaf(s.conversation).map((e) => e.id)).toEqual([user1.id, assistant1.id]);

    // leafOf descends a branch to its tip.
    expect(leafOf(s.conversation, user1.id)).toBe(assistant1.id);
  });

  it("rejects rewinding to a non-existent entry", () => {
    const s = new Session({ config, driver: scriptedDriver(reply("x")) });
    expect(() => s.setActiveLeaf("e_nope")).toThrow(/No such entry/);
  });
});

/**
 * H-05: a turn's entries belong to the branch that turn started on. Before the
 * fix, moving the leaf mid-turn (arrows, or a *rejected* pencil edit) re-parented
 * the in-flight reply — the transcript looked like it had lost the answer.
 * These drive the paths mid-turn; `fork-rewind` above only covers an idle session.
 */
describe("H-05 — a turn is pinned to the branch it started on", () => {
  /** Two branches off one opening question, then a third turn parked mid-stream
   *  on branch B. Returns the landmarks a test needs to assert against. */
  async function twoBranchesWithParkedTurn() {
    const d = parkableDriver([reply("A"), reply("B"), reply("C")]);
    const s = new Session({ config, driver: d.driver });
    await s.send("q1"); // branch A: user1, assistant1
    const [user1, assistant1] = s.conversation.entries as [{ id: string }, { id: string }];
    await s.editFork(user1.id, "q2"); // branch B: user2, assistant2
    const assistant2 = s.conversation.entries[3]!;
    expect(s.conversation.activeLeaf).toBe(assistant2.id);

    const open = d.arm();
    const turn = s.send("q3"); // opens on B, then parks inside the stream
    await open;
    expect(s.status).toBe("running");
    const user3 = s.conversation.entries[4]!;
    expect(user3.parent).toBe(assistant2.id);
    return { s, d, turn, user1, assistant1, assistant2, user3 };
  }

  it("a branch switch mid-turn is passive: the reply still lands on the turn's branch", async () => {
    const { s, d, turn, assistant1, user3 } = await twoBranchesWithParkedTurn();

    // The arrow case — the likelier way to trip this, because it *feels* passive.
    s.setActiveLeaf(assistant1.id);
    expect(s.conversation.activeLeaf).toBe(assistant1.id);

    d.release();
    await turn;

    const assistant3 = s.conversation.entries[5]!;
    expect(assistant3.parent).toBe(user3.id); // chained onto B, where the turn began
    expect(childrenOf(s.conversation, assistant1.id)).toHaveLength(0); // A gained nothing
    // The reader stayed where they navigated; the path they see is intact.
    expect(s.conversation.activeLeaf).toBe(assistant1.id);
    expect(pathToLeaf(s.conversation).map((e) => e.id)).toEqual([
      s.conversation.entries[0]!.id,
      assistant1.id,
    ]);
    // …and branch B reads as one coherent thread, not two assistants back to back.
    expect(pathToLeaf(s.conversation, assistant3.id).map((e) => e.type)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("a rejected mid-turn edit leaves the active leaf where it was", async () => {
    const { s, d, turn, user1, user3 } = await twoBranchesWithParkedTurn();

    // The pencil case: send() refuses while busy — and must refuse *before* the
    // pointer moves, which is the half that made the reply look lost.
    await expect(s.editFork(user1.id, "edited")).rejects.toThrow(/busy/);
    expect(s.conversation.activeLeaf).toBe(user3.id); // still the branch in view
    expect(childrenOf(s.conversation, null)).toHaveLength(2); // no third branch was started

    d.release();
    await turn;
    expect(s.status).toBe("idle");
  });

  it("keeps the pin across a pause: the resumed turn replays and extends its own branch", async () => {
    const ask: StreamEvent[] = [
      { type: "tool_call", index: 0, id: "c1", name: "ask_user", argsDelta: JSON.stringify({ question: "which?" }) },
      { type: "finish", reason: "tool_calls" },
    ];
    const d = parkableDriver([reply("A"), reply("B"), ask, reply("C")]);
    const s = new Session({
      config,
      driver: d.driver,
      tools: new ToolRegistry([askUserTool()]),
      sandbox: new Sandbox([process.cwd()]),
    });
    await s.send("q1"); // branch A
    const [user1, assistant1] = s.conversation.entries as [{ id: string }, { id: string }];
    await s.editFork(user1.id, "q2"); // branch B
    await s.send("q3"); // on B; pauses on the question
    expect(s.status).toBe("awaiting-input");

    // Wander to branch A while the turn is held, then answer.
    s.setActiveLeaf(assistant1.id);
    await s.answer("this one");

    // The resumed call replayed branch B — not the branch the reader moved to.
    const resumed = userTexts(d.requests[d.requests.length - 1]!);
    expect(resumed).toContain("q2");
    expect(resumed).toContain("q3");
    expect(resumed).not.toContain("q1");
    // And its entries extended B, leaving the reader on A.
    expect(s.conversation.activeLeaf).toBe(assistant1.id);
    const last = s.conversation.entries[s.conversation.entries.length - 1]!;
    expect(pathToLeaf(s.conversation, last.id).map((e) => e.type)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
  });
});

describe("fork / rewind persistence", () => {
  let dir: string;
  let store: ConversationStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-fork-"));
    store = new ConversationStore(dir);
  });
  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("persists the active leaf so resume restores the viewed branch", async () => {
    const s = new Session({ config, driver: scriptedDriver(reply("a")) });
    const convId = s.conversation.id;
    await store.create({ id: convId, workingDir: "/w" });
    s.onEvent((e) => {
      if (e.type === "entry") void store.entry(convId, e.entry);
      else if (e.type === "active-leaf") void store.activeLeaf(convId, e.leaf);
    });

    await s.send("q1"); // user1, assistant1
    const assistant1 = s.conversation.entries[1]!;
    await s.editFork(s.conversation.entries[0]!.id, "q2"); // branch B, active now on B
    s.setActiveLeaf(assistant1.id); // rewind the viewed branch back to A
    await store.flush();

    const loaded = store.load(convId)!;
    expect(loaded.entries).toHaveLength(4); // both branches persisted
    expect(loaded.activeLeaf).toBe(assistant1.id); // the rewind (branch A) was restored
  });

  it("restores the branch the reader navigated to, not the one the turn built (H-05)", async () => {
    const d = parkableDriver([reply("A"), reply("B"), reply("C")]);
    const s = new Session({ config, driver: d.driver });
    const convId = s.conversation.id;
    await store.create({ id: convId, workingDir: "/w" });
    s.onEvent((e) => {
      if (e.type === "entry") void store.entry(convId, e.entry);
      else if (e.type === "active-leaf") void store.activeLeaf(convId, e.leaf);
    });

    await s.send("q1"); // branch A
    const [user1, assistant1] = s.conversation.entries as [{ id: string }, { id: string }];
    await s.editFork(user1.id, "q2"); // branch B

    const open = d.arm();
    const turn = s.send("q3"); // on B, parked mid-stream
    await open;
    s.setActiveLeaf(assistant1.id); // read A while B is still being written
    d.release();
    await turn;
    await store.flush();

    const loaded = store.load(convId)!;
    expect(loaded.activeLeaf).toBe(assistant1.id); // the replay agrees with live state
    // The turn's entries are on B with intact parents — nothing orphaned onto A.
    expect(loaded.entries).toHaveLength(6);
    expect(pathToLeaf(loaded, loaded.entries[5]!.id).map((e) => e.type)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });
});
