/**
 * X-12b — the two writes a *past* thread accepts, plus the stub that shouldn't
 * have been there.
 *
 * X-12a shipped the read half (peek an old conversation from the rail) and cut
 * both write affordances. This covers what the design note settled: delete is a
 * **reversible masking flag** in the index and never an unlink, rename is
 * addressed by conversation and must not leave a live session's title stale, and
 * a session nobody typed into never becomes a history row at all.
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
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-histw-"));
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

async function history(app: App): Promise<Array<{ id: string; title?: string }>> {
  const res = await app.request("/conversations");
  return ((await res.json()) as any).conversations;
}

describe("X-12b — deleting a thread masks it, never unlinks it", () => {
  it("drops the row from history while leaving the log readable on disk", async () => {
    const app = makeApp();
    const { json } = await post(app, "/chat", { text: "hello" });
    const convId = json.conversationId as string;
    expect(await history(app)).toHaveLength(1);

    const res = await app.request(`/conversation/${convId}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    expect(await history(app)).toHaveLength(0);
    // The whole point of masking: the thread is still there to recover by id.
    expect((await app.request(`/conversation/${convId}`)).status).toBe(200);
    expect(fs.existsSync(path.join(storeDir, `${convId}.jsonl`))).toBe(true);
  });

  it("is a flag, so flipping it back by hand restores the row", async () => {
    // Joshua's stated recovery path is editing `index.jsonl`, so the flag has to
    // be a value that can be flipped — not a line whose presence is the delete.
    const app = makeApp();
    const { json } = await post(app, "/chat", { text: "hello" });
    const convId = json.conversationId as string;
    await app.request(`/conversation/${convId}`, { method: "DELETE" });
    expect(await history(app)).toHaveLength(0);

    await store.setDeleted(convId, false);
    await store.flush();
    expect(await history(app)).toHaveLength(1);
  });

  it("writes the flag to the index only, so there is one file to hand-edit", async () => {
    const app = makeApp();
    const { json } = await post(app, "/chat", { text: "hello" });
    const convId = json.conversationId as string;
    await app.request(`/conversation/${convId}`, { method: "DELETE" });

    const log = fs.readFileSync(path.join(storeDir, `${convId}.jsonl`), "utf8");
    expect(log).not.toMatch(/"deleted"/);
    expect(fs.readFileSync(path.join(storeDir, "index.jsonl"), "utf8")).toMatch(/"deleted":true/);
  });

  it("404s an unknown conversation rather than masking a row that never existed", async () => {
    expect((await makeApp().request("/conversation/cv_nope", { method: "DELETE" })).status).toBe(404);
  });

  it("keeps the other threads listed", async () => {
    const app = makeApp();
    const a = (await post(app, "/chat", { text: "one" })).json.conversationId as string;
    const b = (await post(app, "/chat", { text: "two" })).json.conversationId as string;
    await app.request(`/conversation/${a}`, { method: "DELETE" });
    expect((await history(app)).map((r) => r.id)).toEqual([b]);
  });
});

describe("X-12b — renaming from a history row", () => {
  it("names a thread that has no session behind it", async () => {
    const first = await post(makeApp(), "/chat", { text: "hello" });
    const convId = first.json.conversationId as string;

    const app2 = makeApp(); // fresh process: nothing live on this conversation
    const res = await post(app2, `/conversation/${convId}/title`, { title: "Reading the notes file" });
    expect(res.status).toBe(200);

    expect((await history(app2))[0]!.title).toBe("Reading the notes file");
    expect(store.load(convId)!.title).toBe("Reading the notes file");
  });

  it("routes through the live session, so its rail card can't go stale", async () => {
    // Writing straight to the store would leave the session's in-memory title
    // behind and the card showing the old name until a reload.
    const app = makeApp();
    const { json } = await post(app, "/chat", { text: "hello" });
    const [sessionId, convId] = [json.sessionId as string, json.conversationId as string];

    await post(app, `/conversation/${convId}/title`, { title: "Named from the row" });

    const live = (await (await app.request(`/session/${sessionId}`)).json()) as { title: string | null };
    expect(live.title).toBe("Named from the row");
  });

  it("rejects an empty title instead of clearing the name", async () => {
    const app = makeApp();
    const convId = (await post(app, "/chat", { text: "hello" })).json.conversationId as string;
    expect((await post(app, `/conversation/${convId}/title`, { title: "   " })).status).toBe(400);
  });

  it("404s a conversation that does not exist", async () => {
    expect((await post(makeApp(), "/conversation/cv_nope/title", { title: "x" })).status).toBe(404);
  });
});

describe("X-12b — an empty session never becomes a history stub", () => {
  it("writes no index row for a session nobody typed into", async () => {
    const app = makeApp();
    const { json } = await post(app, "/session", {});
    await app.request(`/session/${json.sessionId}/close`, { method: "POST" });

    expect(await history(app)).toHaveLength(0);
    // Nothing on disk either — an abandoned thread leaves no trace, rather than
    // a row we then have to hide.
    expect(fs.existsSync(path.join(storeDir, `${json.conversationId}.jsonl`))).toBe(false);
  });

  it("creates the log the moment there is something in it", async () => {
    const app = makeApp();
    const { json } = await post(app, "/session", {});
    expect(await history(app)).toHaveLength(0);

    await post(app, "/chat", { sessionId: json.sessionId, text: "now there's content" });

    const rows = await history(app);
    expect(rows.map((r) => r.id)).toEqual([json.conversationId]);
    // The header still leads the log, so `load()` can fold it back into a tree.
    const lines = fs
      .readFileSync(path.join(storeDir, `${json.conversationId}.jsonl`), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]!.kind).toBe("header");
    expect(store.load(json.conversationId)).toBeTruthy();
  });

  it("still records a thread named before its first message", async () => {
    // A hand-rename can land before any entry; the row has to exist for it.
    const app = makeApp();
    const { json } = await post(app, "/session", {});
    await post(app, `/session/${json.sessionId}/title`, { title: "Named early" });

    expect((await history(app))[0]).toMatchObject({ id: json.conversationId, title: "Named early" });
  });

  it("does not re-create the log for a resumed conversation", async () => {
    const first = await post(makeApp(), "/chat", { text: "hello" });
    const convId = first.json.conversationId as string;

    const app2 = makeApp();
    await post(app2, "/chat", { text: "again", conversationId: convId });

    const headers = fs
      .readFileSync(path.join(storeDir, `${convId}.jsonl`), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r.kind === "header");
    expect(headers).toHaveLength(1);
    expect(await history(app2)).toHaveLength(1); // and one row, not two
  });
});
