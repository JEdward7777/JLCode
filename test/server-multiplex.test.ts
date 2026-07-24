import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createServer } from "../src/server/server";
import { ConversationStore } from "../src/persist/conversation-store";
import { echoDriver } from "../src/session/fake";
import { Session } from "../src/session/session";
import { SessionManager } from "../src/session/manager";
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
beforeEach(() => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-mux-"));
  store = new ConversationStore(storeDir);
});
afterEach(async () => {
  await store.close();
  fs.rmSync(storeDir, { recursive: true, force: true });
});

function makeServer() {
  return createServer({
    resolveConfig: () => config,
    newSession: (c, conversation) => new Session({ config: c, driver: echoDriver(), conversation }),
    store,
    workingDir: "/work/test",
    version: "0.0.0",
  });
}

async function readEventsUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  done: (events: any[]) => boolean,
): Promise<any[]> {
  const dec = new TextDecoder();
  let buf = "";
  const events: any[] = [];
  for (let i = 0; i < 500; i++) {
    if (done(events)) break;
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data:")) events.push(JSON.parse(line.slice(5).trim()));
      }
    }
  }
  return events;
}

describe("SessionManager as the instance fan-in bus (D-43)", () => {
  it("delivers added/removed lifecycle + tagged events to subscribers", () => {
    const mgr = new SessionManager();
    const frames: any[] = [];
    const unsub = mgr.subscribe((f) => frames.push(f));

    const s = new Session({ config, driver: echoDriver() });
    mgr.add(s);
    expect(frames.at(-1)).toMatchObject({ kind: "added" });
    expect(frames.at(-1).session.id).toBe(s.id);

    // A session event is forwarded tagged with the session id.
    s.setModeApproval("ask", undefined);
    const evt = frames.find((f) => f.kind === "event");
    expect(evt.sessionId).toBe(s.id);
    expect(evt.event).toMatchObject({ type: "mode", mode: "ask" });

    mgr.remove(s.id);
    expect(frames.at(-1)).toMatchObject({ kind: "removed", sessionId: s.id });

    // After removal the fan-in is detached — no further events leak through.
    const before = frames.length;
    s.setModeApproval("code", undefined);
    expect(frames.length).toBe(before);
    unsub();
  });

  it("add() is idempotent and only announces once", () => {
    const mgr = new SessionManager();
    const frames: any[] = [];
    mgr.subscribe((f) => frames.push(f));
    const s = new Session({ config, driver: echoDriver() });
    mgr.add(s);
    mgr.add(s);
    expect(frames.filter((f) => f.kind === "added").length).toBe(1);
    expect(mgr.size).toBe(1);
  });
});

describe("multiplexed /events endpoint (D-43)", () => {
  it("opens with a roster of all live sessions, then fans in their events", async () => {
    const { app } = makeServer();
    // Two live sessions before we subscribe → both appear in the roster.
    const a = (await (await app.request("/session", { method: "POST" })).json()) as { sessionId: string };
    const b = (await (await app.request("/session", { method: "POST" })).json()) as { sessionId: string };

    const sse = await app.request("/events");
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    const reader = sse.body!.getReader();

    const roster = (await readEventsUntil(reader, (e) => e.some((x) => x.type === "roster")))[0];
    expect(roster.type).toBe("roster");
    const ids = roster.sessions.map((s: any) => s.id).sort();
    expect(ids).toEqual([a.sessionId, b.sessionId].sort());
    expect(roster.sessions[0].state).toBeTruthy(); // settled state rides along

    // A message to session A streams back tagged with sessionId === A.
    await app.request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: a.sessionId, text: "hi" }),
    });
    const events = await readEventsUntil(
      reader,
      (e) => e.some((x) => x.type === "session-event" && x.event.type === "assistant-end"),
    );
    await reader.cancel();

    const tagged = events.filter((e) => e.type === "session-event");
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged.every((e) => e.sessionId === a.sessionId)).toBe(true);
    const text = tagged
      .filter((e) => e.event.type === "text")
      .map((e) => e.event.delta)
      .join("");
    expect(text).toBe("You said: hi");
  });

  it("emits session-added when a session is created after subscribing", async () => {
    const { app } = makeServer();
    const sse = await app.request("/events");
    const reader = sse.body!.getReader();
    await readEventsUntil(reader, (e) => e.some((x) => x.type === "roster"));

    const created = (await (await app.request("/session", { method: "POST" })).json()) as { sessionId: string };
    const events = await readEventsUntil(reader, (e) => e.some((x) => x.type === "session-added"));
    await reader.cancel();

    const added = events.find((e) => e.type === "session-added");
    expect(added.session.id).toBe(created.sessionId);
  });
});

describe("closing a session (D-43)", () => {
  it("drops it from the bag and announces session-removed", async () => {
    const { app } = makeServer();
    const sse = await app.request("/events");
    const reader = sse.body!.getReader();
    await readEventsUntil(reader, (e) => e.some((x) => x.type === "roster"));

    const created = (await (await app.request("/session", { method: "POST" })).json()) as { sessionId: string };
    await readEventsUntil(reader, (e) => e.some((x) => x.type === "session-added"));

    const closed = await app.request(`/session/${created.sessionId}/close`, { method: "POST" });
    expect(closed.status).toBe(200);
    expect((await closed.json()).closed).toBe(true);

    const events = await readEventsUntil(reader, (e) => e.some((x) => x.type === "session-removed"));
    await reader.cancel();
    expect(events.find((e) => e.type === "session-removed").sessionId).toBe(created.sessionId);

    // It no longer appears in the session list, and further actions 404.
    const list = (await (await app.request("/sessions")).json()) as { sessions: any[] };
    expect(list.sessions.find((s) => s.id === created.sessionId)).toBeUndefined();
    const gone = await app.request(`/session/${created.sessionId}`);
    expect(gone.status).toBe(404);
  });

  it("404s closing an unknown session", async () => {
    const { app } = makeServer();
    const res = await app.request("/session/nope/close", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
