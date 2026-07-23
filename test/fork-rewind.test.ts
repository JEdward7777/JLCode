import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Session } from "../src/session/session";
import { childrenOf, pathToLeaf, leafOf } from "../src/conversation/tree";
import { ConversationStore } from "../src/persist/conversation-store";
import { scriptedDriver } from "../src/session/fake";
import type { ModelConfig } from "../src/config/types";
import type { StreamEvent } from "../src/llm/types";

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
});
