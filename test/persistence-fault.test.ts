/**
 * Persistence faults end-to-end (D-46, closes H-01). A conversation record that
 * cannot be written must **stop the session** and stay recoverable — never
 * disappear while the in-memory session carries on as though it persisted.
 *
 * The failure is injected for real (the conversation's log file is made read-only,
 * so `open(…, "a")` fails with EACCES) rather than by mocking fs, so these cover
 * the whole path: store fault → session pause → HTTP retry → the records land.
 *
 * NB: jam the **file**, not its directory. A read-only *directory* only blocks
 * *creating* entries, so appends to an already-created log still succeed — that
 * injection would depend on whether the header had been flushed yet. Found while
 * driving the real server for the VISUAL-LOG peek.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createServer } from "../src/server/server";
import { ConversationStore } from "../src/persist/conversation-store";
import { Session } from "../src/session/session";
import type { ModelConfig } from "../src/config/types";
import type { LlmDriver, StreamEvent } from "../src/llm/types";

const config: ModelConfig = {
  id: "cfg_p",
  name: "Test",
  openRouterKey: "sk",
  model: "m",
  defaultMode: "code",
  defaultApproval: "manual",
  createdAt: "",
  updatedAt: "",
};

const driver: LlmDriver = {
  // eslint-disable-next-line require-yield
  async *streamChat(): AsyncGenerator<StreamEvent> {
    yield { type: "text", delta: "hello" };
    yield { type: "finish", reason: "stop" };
    yield { type: "usage", usage: { promptTokens: 5, completionTokens: 5 } };
  },
};

// Root ignores the permission bits this injection relies on.
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
const describeFaults = asRoot ? describe.skip : describe;

let storeDir: string;
let store: ConversationStore;

beforeEach(() => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-pfault-"));
  store = new ConversationStore(storeDir);
});
afterEach(async () => {
  // Always restore write permission, or cleanup can't remove the tree.
  for (const f of fs.existsSync(storeDir) ? fs.readdirSync(storeDir) : []) {
    fs.chmodSync(path.join(storeDir, f), 0o600);
  }
  store.discardPending(); // drop anything still stalled so close() can finish
  await store.close();
  fs.rmSync(storeDir, { recursive: true, force: true });
});

function makeApp() {
  return createServer({
    resolveConfig: () => config,
    newSession: (c, conversation) => new Session({ config: c, driver, conversation }),
    store,
    workingDir: "/work/test",
    version: "0.0.0",
  }).app;
}

async function post(app: ReturnType<typeof makeApp>, url: string, body: unknown) {
  const res = await app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

/** Make one conversation's log unwritable (and back). Deterministic: it does not
 *  matter how much has already been written to it. */
const convFile = (conv: string) => path.join(storeDir, `${conv}.jsonl`);
async function jam(conv: string): Promise<void> {
  await store.flush(); // land whatever is already queued
  // A session that hasn't spoken yet has no log to chmod — the file is created
  // lazily on first content (X-12b). Make it exist so it can be made read-only;
  // appends open with "a", so an empty file changes nothing except that the
  // header write now fails alongside the entry, which is the fault under test.
  fs.closeSync(fs.openSync(convFile(conv), "a"));
  fs.chmodSync(convFile(conv), 0o400);
}
const unjam = (conv: string) => fs.chmodSync(convFile(conv), 0o600);

describeFaults("persistence faults (D-46)", () => {
  it("stops the session instead of proceeding with an unwritten record", async () => {
    const app = makeApp();
    const { json: created } = await post(app, "/session", {});
    const id = created.sessionId as string;
    const conv = created.conversationId as string;

    await jam(conv);
    const chat = await post(app, "/chat", { sessionId: id, text: "hi" });

    expect(chat.json.status).toBe("awaiting-persistence");
    expect(chat.json.persistenceFault).toBeTruthy();
    expect(chat.json.persistenceFault.message).toMatch(/EACCES|permission/i);
    expect(chat.json.persistenceFault.filePath).toBe(convFile(conv));
    unjam(conv);
  });

  it("refuses new work while stopped, then resumes after a successful retry", async () => {
    const app = makeApp();
    const { json: created } = await post(app, "/session", {});
    const id = created.sessionId as string;
    const conv = created.conversationId as string;

    await jam(conv);
    await post(app, "/chat", { sessionId: id, text: "hi" });

    // Sending again while stopped is rejected — the whole point of the pause.
    const blocked = await post(app, "/chat", { sessionId: id, text: "again" });
    expect(blocked.status).toBeGreaterThanOrEqual(400);

    // Retrying while still jammed fails and stays paused.
    const stillBad = await post(app, `/session/${id}/persistence`, {});
    expect(stillBad.json.recovered).toBe(false);
    expect(stillBad.json.status).toBe("awaiting-persistence");
    expect(stillBad.json.persistenceFault.retryFailed).toBe(true);

    // Fix the disk → retry lands → back to idle.
    unjam(conv);
    const ok = await post(app, `/session/${id}/persistence`, {});
    expect(ok.json.recovered).toBe(true);
    expect(ok.json.status).toBe("idle");
    expect(ok.json.persistenceFault).toBeUndefined();

    // And the records actually reached disk, in order, headed by the header.
    const lines = fs
      .readFileSync(path.join(storeDir, `${conv}.jsonl`), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]?.kind).toBe("header");
    expect(lines.some((r) => r.type === "user" && r.text === "hi")).toBe(true);

    // The conversation loads back as a coherent tree (no dangling parent).
    const loaded = store.load(conv);
    expect(loaded).toBeTruthy();
    const ids = new Set(loaded!.entries.map((e) => e.id));
    for (const e of loaded!.entries) {
      if (e.parent !== null) expect(ids.has(e.parent)).toBe(true);
    }
  });

  it("discarding is explicit, reports the loss, and unblocks the session", async () => {
    const app = makeApp();
    const { json: created } = await post(app, "/session", {});
    const id = created.sessionId as string;
    const conv = created.conversationId as string;

    await jam(conv);
    await post(app, "/chat", { sessionId: id, text: "hi" });
    const res = await post(app, `/session/${id}/persistence`, { discard: true });
    unjam(conv);

    expect(res.json.status).toBe("idle");
    expect(res.json.discarded).toBeGreaterThan(0);
    expect(res.json.persistenceFault).toBeUndefined();
  });

  it("rejects a recovery call when nothing is stalled", async () => {
    const app = makeApp();
    const { json: created } = await post(app, "/session", {});
    const res = await post(app, `/session/${created.sessionId}/persistence`, {});
    expect(res.status).toBe(409);
  });
});
