import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { ConversationStore } from "../src/persist/conversation-store";
import { Session } from "../src/session/session";
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

const reply = (text: string): StreamEvent[] => [
  { type: "text", delta: text },
  { type: "finish", reason: "stop" },
];

let dir: string;
let store: ConversationStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-cvstore-"));
  store = new ConversationStore(dir);
});
afterEach(async () => {
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Wire a session's entry events into the store. */
function persist(session: Session): void {
  session.onEvent((e) => {
    if (e.type === "entry") void store.entry(session.conversation.id, e.entry);
  });
}

describe("ConversationStore — persist, load, resume", () => {
  it("persists entries and folds them back into the same tree", async () => {
    const session = new Session({ config, driver: scriptedDriver(reply("Hi there")) });
    const convId = session.conversation.id;
    await store.create({ id: convId, workingDir: "/work/clientA", configName: config.name });
    persist(session);

    await session.send("hello");
    await store.flush();

    const loaded = store.load(convId);
    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe(convId);
    expect(loaded!.entries.map((e) => e.type)).toEqual(["user", "assistant"]);
    expect(loaded!.activeLeaf).toBe(session.conversation.activeLeaf);
    // Same ids and shape as the live tree.
    expect(loaded!.entries.map((e) => e.id)).toEqual(session.conversation.entries.map((e) => e.id));
  });

  it("resumes a loaded conversation and continues appending", async () => {
    const s1 = new Session({ config, driver: scriptedDriver(reply("first")) });
    const convId = s1.conversation.id;
    await store.create({ id: convId, workingDir: "/work/clientA" });
    persist(s1);
    await s1.send("one");
    await store.flush();

    // Resume from disk in a fresh session, then continue.
    const loaded = store.load(convId)!;
    const s2 = new Session({ config, driver: scriptedDriver(reply("second")), conversation: loaded });
    persist(s2);
    await s2.send("two");
    await store.flush();

    // The resumed session built on the prior history.
    const finalTypes = s2.conversation.entries.map((e) => e.type);
    expect(finalTypes).toEqual(["user", "assistant", "user", "assistant"]);
    // And the reload sees all four entries.
    expect(store.load(convId)!.entries).toHaveLength(4);
  });

  it("lists conversations by working directory (D-09)", async () => {
    await store.create({ id: "cv_a", workingDir: "/work/A" });
    await store.create({ id: "cv_b", workingDir: "/work/B" });
    await store.create({ id: "cv_a2", workingDir: "/work/A" });
    await store.flush();
    expect(store.list("/work/A").map((r) => r.id).sort()).toEqual(["cv_a", "cv_a2"]);
    expect(store.list().length).toBe(3); // all, newest first
    expect(store.list("/work/A")[0]!.id).toBe("cv_a2"); // newest first
  });

  it("tolerates a torn last line on load", async () => {
    const session = new Session({ config, driver: scriptedDriver(reply("ok")) });
    const convId = session.conversation.id;
    await store.create({ id: convId, workingDir: "/w" });
    persist(session);
    await session.send("hi");
    await store.flush();
    fs.appendFileSync(path.join(dir, `${convId}.jsonl`), '{"type":"user","tex'); // torn write
    const loaded = store.load(convId);
    expect(loaded).toBeDefined();
    expect(loaded!.entries.map((e) => e.type)).toEqual(["user", "assistant"]); // torn line dropped
  });
});
