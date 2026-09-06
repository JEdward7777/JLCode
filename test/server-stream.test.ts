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
beforeEach(() => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-stream-"));
  store = new ConversationStore(storeDir);
});
afterEach(async () => {
  await store.close();
  fs.rmSync(storeDir, { recursive: true, force: true });
});

function makeApp(staticDir?: string) {
  return createServer({
    resolveConfig: () => config,
    newSession: (c, conversation) => new Session({ config: c, driver: echoDriver(), conversation }),
    store,
    workingDir: "/work/test",
    version: "0.0.0",
    staticDir,
  }).app;
}

/** Read the SSE stream, parsing `data:` frames, until `done(events)` is true.
 *  Guards against a hang with a frame budget. */
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

describe("event bus (SSE down / POST up)", () => {
  it("POST /session creates a live session", async () => {
    const app = makeApp();
    const res = await app.request("/session", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId?: string };
    expect(typeof body.sessionId).toBe("string");
  });

  it("streams assistant text deltas over SSE while a turn runs", async () => {
    const app = makeApp();
    const created = (await (await app.request("/session", { method: "POST" })).json()) as { sessionId: string };
    const id = created.sessionId;

    const sse = await app.request(`/session/${id}/events`);
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    const reader = sse.body!.getReader();

    // Wait until the listener is attached (the `ready` frame) before sending.
    await readEventsUntil(reader, (evts) => evts.some((e) => e.type === "ready"));

    await app.request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id, text: "hello" }),
    });

    const events = await readEventsUntil(reader, (evts) => evts.some((e) => e.type === "assistant-end"));
    await reader.cancel();

    const streamed = events
      .filter((e) => e.type === "text")
      .map((e) => e.delta)
      .join("");
    expect(streamed).toBe("You said: hello");
    expect(events.some((e) => e.type === "assistant-start")).toBe(true);
    expect(events.some((e) => e.type === "reasoning")).toBe(true);
  });

  it("SSE 404s for an unknown session", async () => {
    const res = await makeApp().request("/session/nope/events");
    expect(res.status).toBe(404);
  });
});

describe("static client serving", () => {
  let webDir: string;
  beforeEach(() => {
    webDir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-web-"));
    fs.writeFileSync(path.join(webDir, "index.html"), "<!doctype html><title>JLCode</title>");
    fs.mkdirSync(path.join(webDir, "assets"));
    fs.writeFileSync(path.join(webDir, "assets", "app.js"), "console.log(1)");
  });
  afterEach(() => fs.rmSync(webDir, { recursive: true, force: true }));

  it("serves index.html at / and assets with the right type", async () => {
    const app = makeApp(webDir);
    const index = await app.request("/");
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("JLCode");
    const js = await app.request("/assets/app.js");
    expect(js.headers.get("content-type")).toContain("javascript");
  });

  it("falls back to index.html for client-side routes (SPA)", async () => {
    const res = await makeApp(webDir).request("/some/deep/link");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("JLCode");
  });

  it("does not serve files outside the static root (traversal → index)", async () => {
    const res = await makeApp(webDir).request("/../../etc/passwd");
    expect(await res.text()).toContain("JLCode");
  });

  // D-80: the pairing is the point. `index.html` names the current build's asset
  // hashes, so a cached copy pins a tab to a *previous* build — which is how a
  // session paused correctly on the server and rendered as `idle` in the browser.
  it("index.html must be revalidated; hashed assets may be cached forever", async () => {
    const app = makeApp(webDir);
    const index = await app.request("/");
    expect(index.headers.get("cache-control")).toBe("no-cache");
    const js = await app.request("/assets/app.js");
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("the SPA fallback is index.html, so it carries index.html's caching", async () => {
    // A deep link serves index.html's *bytes*; caching them under the deep
    // link's name would strand that route on an old build all the same.
    const res = await makeApp(webDir).request("/some/deep/link");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("API routes still win over the static catch-all", async () => {
    const res = await makeApp(webDir).request("/health");
    expect((await res.json()).ok).toBe(true);
  });
});
