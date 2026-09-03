/**
 * P8e (D-78, D-78j) — the other two inputs.
 *
 * Two halves, and both are about something that was already arriving and being
 * thrown away:
 *
 *   - **The MCP bridge.** `renderMcpContent` wrote `[image image/png, ~N bytes —
 *     not inlined]` over a picture a server had gone to the trouble of encoding.
 *     It now becomes an attachment on the path P8b built — and where it cannot
 *     (a text-only model, an oversized blob, bytes that are not the format the
 *     server claimed), it is dropped **with the reason said out loud**, never
 *     silently, which is the whole bet of the phase.
 *   - **The browser DTO.** `entryView` dropped attachments so no tab would get a
 *     blob it could not render. It now ships **metadata and a URL** — never the
 *     bytes (D-78j) — because an entry frame goes to every open tab over the
 *     multiplexed bus (D-43) and a data URI would ride it every time.
 *
 * The MCP half runs against a **real stdio child** (`fixtures/mcp-test-server.mjs`),
 * not a mock: the bytes make a round trip through JSON-RPC, so a base64 the
 * transport mangles fails here rather than in production.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../src/server/server";
import { ConversationStore } from "../src/persist/conversation-store";
import { Session } from "../src/session/session";
import { Sandbox } from "../src/tools/sandbox";
import { ToolRegistry, defaultTools } from "../src/tools/registry";
import { ModeApprovalGate } from "../src/tools/mode-gate";
import { McpManager } from "../src/mcp/client";
import { renderMcpContent } from "../src/mcp/bridge";
import { buildWireMessages } from "../src/conversation/wire";
import { MAX_IMAGE_BYTES } from "../src/tools/media";
import type { LoadedSettings } from "../src/mcp/config";
import type { LlmDriver, StreamEvent } from "../src/llm/types";
import type { ModelConfig } from "../src/config/types";
import type { ToolEntry } from "../src/conversation/types";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-test-server.mjs");

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

/** Call one tool, then wrap up — the fake model of every MCP session test. */
function callThenAnswer(name: string, args: unknown): LlmDriver {
  let n = 0;
  return {
    async *streamChat(): AsyncGenerator<StreamEvent> {
      n++;
      if (n === 1) {
        yield { type: "tool_call", index: 0, id: "c1", name, argsDelta: JSON.stringify(args) };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text", delta: "All set." };
        yield { type: "finish", reason: "stop" };
      }
    },
  };
}

let root: string;
let configDir: string;
let mcp: McpManager;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-p8e-"));
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-p8ecfg-"));
  const settings: LoadedSettings = {
    servers: [
      {
        name: "shots",
        scope: "global",
        config: { command: process.execPath, args: [SERVER], alwaysAllow: ["screenshot"] },
      },
    ],
    problems: [],
    files: { global: path.join(configDir, "mcp_settings.json"), workspace: path.join(root, ".jlcode", "mcp_settings.json") },
  };
  mcp = await McpManager.start({ workspace: root, settings });
});

afterEach(async () => {
  await mcp.close();
  for (const dir of [root, configDir]) fs.rmSync(dir, { recursive: true, force: true });
});

function session(driver: LlmDriver, acceptsImages: boolean) {
  return new Session({
    config,
    driver,
    tools: new ToolRegistry([...defaultTools({ acceptsImages }), ...mcp.tools()]),
    sandbox: new Sandbox([root]),
    gate: new ModeApprovalGate("code", "full-auto"),
    acceptsImages,
  });
}

/** Drive one `shots__screenshot` call to completion and hand back the entry. */
async function shoot(kind: string, acceptsImages = true): Promise<ToolEntry & { session: Session }> {
  const s = session(callThenAnswer("shots__screenshot", { kind }), acceptsImages);
  await s.send("take a shot");
  expect(s.status).toBe("idle");
  const entry = s.conversation.entries.find((e) => e.type === "tool");
  expect(entry?.type).toBe("tool");
  return Object.assign(entry as ToolEntry, { session: s });
}

describe("the MCP bridge stops dropping images (P8e)", () => {
  it("turns a server's image block into an attachment the wire carries", async () => {
    const entry = await shoot("png");
    // The text half still answers the tool_call_id, and the sibling text block
    // in the same result is untouched.
    expect(entry.content).toContain("here is a png shot");
    expect(entry.content).toContain("attached to the message after this result");
    expect(entry.content).toContain('"shots/screenshot image 1"');
    expect(entry.attachments).toHaveLength(1);
    expect(entry.attachments![0]!.mime).toBe("image/png");
    // A round trip through JSON-RPC and back: still a real PNG signature.
    expect(Buffer.from(entry.attachments![0]!.data, "base64").subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );

    // …and it lands where the wire needs it: text-only `tool` message, bytes in
    // the `user` message that follows (D-78a).
    const wire = buildWireMessages(entry.session.conversation);
    const toolMsg = wire.find((m) => m.role === "tool")!;
    expect(typeof toolMsg.content).toBe("string");
    const parts = wire.find((m) => m.role === "user" && Array.isArray(m.content))!.content as {
      type: string;
      text?: string;
      image_url?: { url: string };
    }[];
    expect(parts.filter((p) => p.type === "image_url")).toHaveLength(1);
    expect(parts.find((p) => p.type === "image_url")!.image_url!.url).toMatch(/^data:image\/png;base64,/);
    // The label the tool result promised is the label the model actually sees.
    expect(parts.some((p) => p.text === "[1] shots/screenshot image 1 (image/png)")).toBe(true);
  });

  it("drops it — loudly — when the conversation's model cannot see", async () => {
    const entry = await shoot("png", false);
    expect(entry.attachments).toBeUndefined();
    expect(entry.content).toContain("does not accept images");
    expect(entry.content).toContain("here is a png shot"); // the text half survives
    // Nothing to flush: the wire is exactly the text-only conversation it was.
    expect(buildWireMessages(entry.session.conversation).some((m) => Array.isArray(m.content))).toBe(false);
  });

  it("believes the bytes, not the server's mimeType (D-78b)", async () => {
    const entry = await shoot("lying"); // a text body labelled image/png
    expect(entry.attachments).toBeUndefined();
    expect(entry.content).toContain("claimed as image/png");
    expect(entry.content).toContain("the bytes are text");
  });

  it("refuses an image over the cap rather than sending it", async () => {
    const entry = await shoot("big"); // 6 MB
    expect(entry.attachments).toBeUndefined();
    expect(entry.content).toMatch(/over the 5\.0 MB/);
    expect(MAX_IMAGE_BYTES).toBe(5 * 1024 * 1024);
  });

  it("still renders text, structured content and audio the way it always did", async () => {
    // The regression guard for the branches P8e did *not* change.
    expect((await renderMcpContent({ content: [{ type: "text", text: "a" }] })).content).toBe("a");
    expect((await renderMcpContent({ content: [{ type: "text", text: "a" }] })).attachments).toEqual([]);
    const audio = await renderMcpContent({ content: [{ type: "audio", data: "AAAA", mimeType: "audio/wav" }] });
    expect(audio.content).toContain("not inlined");
    expect(audio.attachments).toEqual([]);
  });
});

/** An entry out of either bus frame shape: `/session/:id/events` emits the
 *  session event directly, `/events` wraps it as `{type:"session-event", event}`. */
function tolerantEntry(frame: any): any {
  if (frame?.type === "entry") return frame.entry;
  if (frame?.type === "session-event" && frame.event?.type === "entry") return frame.event.entry;
  return undefined;
}

/** Read SSE `data:` frames until `done(events)`, with a frame budget. */
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

describe("what the browser is handed (D-78j)", () => {
  let storeDir: string;
  let store: ConversationStore;

  beforeEach(() => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-p8e-store-"));
    store = new ConversationStore(storeDir);
  });
  afterEach(async () => {
    await store.close();
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  function makeApp() {
    return createServer({
      resolveConfig: () => config,
      store,
      workingDir: root,
      newSession: (c, conversation) =>
        new Session({
          config: c,
          driver: callThenAnswer("shots__screenshot", { kind: "png" }),
          tools: new ToolRegistry([...defaultTools({ acceptsImages: true }), ...mcp.tools()]),
          sandbox: new Sandbox([root]),
          gate: new ModeApprovalGate("code", "full-auto"),
          acceptsImages: true,
          conversation,
        }),
      version: "0.0.0",
    }).app;
  }

  /** Run one turn and return the app plus the ids it produced. */
  async function turn() {
    const app = makeApp();
    const chat = await app.request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "take a shot" }),
    });
    const { sessionId } = (await chat.json()) as { sessionId: string };
    const body = await (await app.request(`/session/${sessionId}`)).text();
    const tree = JSON.parse(body) as { conversationId: string; entries: any[] };
    return { app, sessionId, body, tree, tool: tree.entries.find((e) => e.type === "tool") };
  }

  it("names the image and links to it — and ships no bytes at all", async () => {
    const { body, tool, tree } = await turn();
    expect(tool.attachments).toHaveLength(1);
    expect(tool.attachments[0].mime).toBe("image/png");
    expect(tool.attachments[0].name).toBe("shots/screenshot image 1");
    expect(tool.attachments[0].bytes).toBeGreaterThan(0);
    expect(tool.attachments[0].url).toBe(`/conversation/${tree.conversationId}/attachment/${tool.id}/0`);
    // The point of the whole shape: the transcript JSON carries no base64 blob.
    // A PNG's signature survives base64 as `iVBORw0KGgo`, so that is the string
    // that must not be in there.
    expect(body).not.toContain("iVBORw0KGgo");
    // …and it is small. A data URI would have made this ~200x bigger.
    expect(body.length).toBeLessThan(4000);
  });

  it("serves the exact bytes, immutably, from the live session", async () => {
    const { app, tool } = await turn();
    const res = await app.request(tool.attachments[0].url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.byteLength).toBe(tool.attachments[0].bytes);
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("serves them from disk too, for a thread nobody has open (X-11 parity)", async () => {
    const { app, tool, tree } = await turn();
    await app.request("/shutdown", { method: "POST" }); // flushes the store
    // A second server over the same store: no live session holds this thread.
    const cold = createServer({
      resolveConfig: () => config,
      store,
      workingDir: root,
      newSession: () => {
        throw new Error("should not start a session");
      },
      version: "0.0.0",
    }).app;
    const loaded = (await (await cold.request(`/conversation/${tree.conversationId}`)).json()) as { entries: any[] };
    const coldTool = loaded.entries.find((e) => e.type === "tool");
    // The same URL a live entry advertised — the browser cannot tell the two apart.
    expect(coldTool.attachments[0].url).toBe(tool.attachments[0].url);
    const res = await cold.request(coldTool.attachments[0].url);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("the live SSE entry carries the same link as the loaded tree (X-11)", async () => {
    // Both buses project through `entryView`, and both had to be handed a
    // conversation id to do it — the multiplexed one looks its session up. A
    // frame that lost the id would silently ship an image-less tool entry, so
    // the picture would appear only after a reload.
    for (const url of ["/session/SID/events", "/events"]) {
      const app = makeApp();
      const created = (await (await app.request("/session", { method: "POST" })).json()) as { sessionId: string };
      const sessionId = created.sessionId;
      // Subscribe *before* sending: `/chat` awaits the whole turn, so a listener
      // attached afterwards has already missed every entry frame.
      const res = await app.request(url.replace("SID", sessionId));
      const reader = res.body!.getReader();
      await readEventsUntil(reader, (evs) => evs.some((e) => e.type === "ready" || e.type === "roster"));
      await app.request("/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, text: "take a shot" }),
      });
      const frames = await readEventsUntil(reader, (evs) => evs.some((e) => tolerantEntry(e)?.type === "tool"));
      await reader.cancel();
      const tool = frames.map(tolerantEntry).find((e) => e?.type === "tool");
      expect(tool, `no tool entry frame on ${url}`).toBeTruthy();
      expect(tool.attachments).toHaveLength(1);
      expect(tool.attachments[0].url).toMatch(/^\/conversation\/[^/]+\/attachment\/[^/]+\/0$/);
      // …and still no bytes on the bus.
      expect(JSON.stringify(tool)).not.toContain("iVBORw0KGgo");
    }
  });

  it("404s a conversation, entry or index that isn't there", async () => {
    const { app, tool, tree } = await turn();
    const cid = tree.conversationId;
    expect((await app.request(`/conversation/nope/attachment/${tool.id}/0`)).status).toBe(404);
    expect((await app.request(`/conversation/${cid}/attachment/nope/0`)).status).toBe(404);
    expect((await app.request(`/conversation/${cid}/attachment/${tool.id}/1`)).status).toBe(404);
    // A user entry has no attachments and never will — same answer, no throw.
    const user = tree.entries.find((e: any) => e.type === "user");
    expect((await app.request(`/conversation/${cid}/attachment/${user.id}/0`)).status).toBe(404);
  });

  it("a text-only tool entry ships exactly the shape it always did", async () => {
    // Additive, or the browser's existing rendering is a regression: no
    // `attachments` key at all on an entry that has none.
    const app = createServer({
      resolveConfig: () => config,
      store,
      workingDir: root,
      newSession: (c, conversation) =>
        new Session({
          config: c,
          driver: callThenAnswer("shots__echo", { text: "hi" }),
          tools: new ToolRegistry([...defaultTools(), ...mcp.tools()]),
          sandbox: new Sandbox([root]),
          gate: new ModeApprovalGate("code", "full-auto"),
          conversation,
        }),
      version: "0.0.0",
    }).app;
    const chat = await app.request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "say hi" }),
    });
    const { sessionId } = (await chat.json()) as { sessionId: string };
    const tree = (await (await app.request(`/session/${sessionId}`)).json()) as { entries: any[] };
    const tool = tree.entries.find((e) => e.type === "tool");
    expect(tool.content).toContain("echo: hi");
    expect("attachments" in tool).toBe(false);
  });
});
