/**
 * X-12 — loading old conversations from the browser.
 *
 * The endpoints the history list reads (`GET /conversations`, `GET
 * /conversation/:id`) have existed since Phase 4 and are covered in
 * `server.test.ts`. What is new here is the **revival** path: `/chat` falling
 * back to a conversation when the session id misses, attaching to a live
 * session rather than duplicating it, and continuing from a chosen branch.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createServer } from "../src/server/server";
import { ConversationStore } from "../src/persist/conversation-store";
import { echoDriver } from "../src/session/fake";
import { Session } from "../src/session/session";
import type { ModelConfig } from "../src/config/types";

const config: ModelConfig = {
  id: "cfg_x",
  name: "Test",
  openRouterKey: "sk",
  model: "m",
  defaultMode: "code",
  defaultApproval: "manual",
  createdAt: "",
  updatedAt: "",
};

let storeDir: string;
let store: ConversationStore;
let workDir: string;

beforeEach(() => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-hist-"));
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-work-"));
  store = new ConversationStore(storeDir);
});
afterEach(async () => {
  await store.close();
  fs.rmSync(storeDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

function makeApp(dir = workDir) {
  return createServer({
    resolveConfig: () => config,
    newSession: (c, conversation) => new Session({ config: c, driver: echoDriver(), conversation }),
    store,
    workingDir: dir,
    version: "0.0.0",
  }).app;
}

type App = ReturnType<typeof makeApp>;

async function post(app: App, url: string, body: unknown) {
  const res = await app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

async function entriesOf(app: App, convId: string) {
  const res = await app.request(`/conversation/${convId}`);
  return (await res.json()) as { activeLeaf: string | null; entries: Array<{ id: string; type: string; parent: string | null; text?: string }> };
}

describe("X-12 — history revival", () => {
  it("materializes a session from a conversation when the session id misses", async () => {
    // A tab whose session died with a previous process: it still knows the
    // conversation, so the message must land instead of 404ing.
    const first = await post(makeApp(), "/chat", { text: "hello" });
    const convId = first.json.conversationId as string;

    const app2 = makeApp(); // a fresh process — nothing live in the bag
    const revived = await post(app2, "/chat", { text: "still there?", sessionId: "sess_gone", conversationId: convId });

    expect(revived.status).toBe(200);
    expect(revived.json.conversationId).toBe(convId);
    expect(revived.json.sessionId).not.toBe("sess_gone");
    const { entries } = await entriesOf(app2, convId);
    expect(entries.filter((e) => e.type === "user").map((e) => e.text)).toEqual(["hello", "still there?"]);
  });

  it("still 404s a missing session when no conversation is offered", async () => {
    // The fallback must not turn a plain typo into a silently-new conversation.
    expect((await post(makeApp(), "/chat", { text: "hi", sessionId: "nope" })).status).toBe(404);
  });

  it("attaches to a live session instead of duplicating it (the X-14 hazard)", async () => {
    // Two stale tabs on one thread must converge on one Session: two objects
    // over independent copies of one tree, both appending to one log, is the
    // hazard this fallback would otherwise create.
    const app = makeApp();
    const first = await post(app, "/chat", { text: "one" });
    const convId = first.json.conversationId as string;
    const liveId = first.json.sessionId as string;

    const a = await post(app, "/chat", { text: "two", sessionId: "stale-a", conversationId: convId });
    const b = await post(app, "/chat", { text: "three", sessionId: "stale-b", conversationId: convId });

    expect(a.json.sessionId).toBe(liveId);
    expect(b.json.sessionId).toBe(liveId);
    const roster = (await (await app.request("/sessions")).json()) as { sessions: unknown[] };
    expect(roster.sessions.length).toBe(1);
    const { entries } = await entriesOf(app, convId);
    expect(entries.filter((e) => e.type === "user").map((e) => e.text)).toEqual(["one", "two", "three"]);
  });

  it("continues from the branch the peek was looking at, not the persisted leaf", async () => {
    const app = makeApp();
    const first = await post(app, "/chat", { text: "root" });
    const convId = first.json.conversationId as string;
    await post(app, "/chat", { text: "down the first path", sessionId: first.json.sessionId });

    // Pick an earlier entry — the branch point a peek's arrows would land on.
    const before = await entriesOf(app, convId);
    const rootUser = before.entries.find((e) => e.type === "user")!;
    expect(before.activeLeaf).not.toBe(rootUser.id);

    const app2 = makeApp(); // revive fresh so nothing is live on the tree
    const forked = await post(app2, "/chat", { text: "a different path", conversationId: convId, leaf: rootUser.id });
    expect(forked.status).toBe(200);

    const after = await entriesOf(app2, convId);
    const branched = after.entries.find((e) => e.text === "a different path")!;
    expect(branched.parent).toBe(rootUser.id); // a sibling branch, not a continuation
  });

  it("rejects an unknown leaf rather than silently continuing elsewhere", async () => {
    const app = makeApp();
    const first = await post(app, "/chat", { text: "root" });
    const bad = await post(app, "/chat", {
      text: "where does this go?",
      conversationId: first.json.conversationId,
      leaf: "entry_does_not_exist",
    });
    expect(bad.status).toBe(400);
  });

  it("a peek reads a conversation without creating a session", async () => {
    const first = await post(makeApp(), "/chat", { text: "hello" });
    const app2 = makeApp();
    const peeked = await app2.request(`/conversation/${first.json.conversationId}`);
    expect(peeked.status).toBe(200);
    const roster = (await (await app2.request("/sessions")).json()) as { sessions: unknown[] };
    expect(roster.sessions.length).toBe(0); // reading history starts nothing
  });
});

describe("X-12 — the history filter's working directory", () => {
  it("files a thread under one canonical directory however the server was launched", async () => {
    // Launch once with a trailing slash and once by the plain path: the same
    // project, and one list — not two invisible buckets.
    await post(makeApp(workDir + path.sep), "/chat", { text: "hi" });
    await post(makeApp(workDir), "/chat", { text: "hi again" });

    const rows = (await (await makeApp(workDir).request("/conversations")).json()) as { conversations: unknown[] };
    expect(rows.conversations.length).toBe(2);
  });

  it("matches a directory reached through a symlink", async () => {
    // The papercut in the wild: `list()` compared raw strings, so launching via
    // a symlinked path hid every conversation recorded through the real one.
    const link = path.join(os.tmpdir(), `jlcode-link-${Date.now()}`);
    fs.symlinkSync(workDir, link, "dir");
    try {
      await post(makeApp(workDir), "/chat", { text: "recorded through the real path" });
      const viaLink = (await (await makeApp(link).request("/conversations")).json()) as { conversations: unknown[] };
      expect(viaLink.conversations.length).toBe(1);
    } finally {
      fs.unlinkSync(link);
    }
  });

  it("keeps a different project out of the default list, and shows it under all", async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-other-"));
    try {
      await post(makeApp(workDir), "/chat", { text: "here" });
      await post(makeApp(other), "/chat", { text: "elsewhere" });

      const here = (await (await makeApp(workDir).request("/conversations")).json()) as { conversations: unknown[] };
      expect(here.conversations.length).toBe(1);
      const all = (await (await makeApp(workDir).request("/conversations?dir=all")).json()) as { conversations: unknown[] };
      expect(all.conversations.length).toBe(2);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
