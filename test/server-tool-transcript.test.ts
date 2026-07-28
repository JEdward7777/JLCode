/**
 * What the browser needs to render tool output in the transcript (X-11). The
 * data was always persisted; it just never reached the page in a usable shape.
 * Two guarantees here: the tool entry carries its `toolCallId` and the calling
 * assistant entry carries the matching call `id` (that pair is how the block
 * shows *which* command produced the output), and a **live** `entry` event is
 * projected through the same `entryView` as a loaded tree — so a result looks
 * the same whether you watched it arrive or reloaded the page. The projection
 * also keeps the opaque signed reasoning blobs (D-14) off the wire.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createServer } from "../src/server/server";
import { ConversationStore } from "../src/persist/conversation-store";
import { Session } from "../src/session/session";
import { Sandbox } from "../src/tools/sandbox";
import { ToolRegistry } from "../src/tools/registry";
import { fileTools } from "../src/tools/file-tools";
import { ModeApprovalGate } from "../src/tools/mode-gate";
import type { LlmDriver, StreamEvent } from "../src/llm/types";
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
let root: string;
let store: ConversationStore;
beforeEach(() => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-toolview-store-"));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-toolview-root-"));
  store = new ConversationStore(storeDir);
});
afterEach(async () => {
  await store.close();
  fs.rmSync(storeDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

/** Reads a file, then talks about it — the shape X-11 exists for. */
function readingDriver(): LlmDriver {
  let n = 0;
  return {
    async *streamChat(): AsyncGenerator<StreamEvent> {
      n++;
      if (n === 1) {
        yield { type: "reasoning", delta: "I should look at the file." };
        yield { type: "reasoning_details", value: [{ type: "reasoning.text", text: "secret", signature: "sig" }] };
        yield { type: "tool_call", index: 0, id: "call_7", name: "read_file", argsDelta: JSON.stringify({ path: "notes.txt" }) };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text", delta: "It says hello." };
        yield { type: "finish", reason: "stop" };
      }
    },
  };
}

function makeApp() {
  return createServer({
    resolveConfig: () => config,
    store,
    workingDir: root,
    newSession: (c, conversation) =>
      new Session({
        config: c,
        driver: readingDriver(),
        tools: new ToolRegistry(fileTools()),
        sandbox: new Sandbox([root]),
        gate: new ModeApprovalGate("code", "full-auto"), // no pause: we want the result
        conversation,
      }),
    version: "0.0.0",
  }).app;
}

/** Read SSE `data:` frames until `done(events)`, with a frame budget. */
async function readEventsUntil(reader: ReadableStreamDefaultReader<Uint8Array>, done: (events: any[]) => boolean): Promise<any[]> {
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

describe("tool results on the wire (X-11)", () => {
  it("ships the tool entry with its full content and the call id that pairs it with its arguments", async () => {
    fs.writeFileSync(path.join(root, "notes.txt"), "hello from disk\nsecond line\n");
    const app = makeApp();
    const chat = await app.request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "what's in notes.txt?" }),
    });
    const { sessionId } = (await chat.json()) as { sessionId: string };

    const tree = (await (await app.request(`/session/${sessionId}`)).json()) as { entries: any[] };
    const tool = tree.entries.find((e) => e.type === "tool");
    const caller = tree.entries.find((e) => e.type === "assistant" && e.toolCalls?.length);

    expect(tool.name).toBe("read_file");
    expect(tool.toolCallId).toBe("call_7");
    expect(tool.isError).toBe(false);
    // The *whole* output, not the journal's 200-char preview.
    expect(tool.content).toContain("hello from disk");
    expect(tool.content).toContain("second line");
    // The join: the args the transcript shows next to the result live here.
    expect(caller.toolCalls[0].id).toBe("call_7");
    expect(JSON.parse(caller.toolCalls[0].arguments).path).toBe("notes.txt");
  });

  it("marks a failed call so the block can read as an error", async () => {
    const app = makeApp(); // no notes.txt on disk this time
    const chat = await app.request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "what's in notes.txt?" }),
    });
    const { sessionId } = (await chat.json()) as { sessionId: string };
    const tree = (await (await app.request(`/session/${sessionId}`)).json()) as { entries: any[] };
    const tool = tree.entries.find((e) => e.type === "tool");
    expect(tool.isError).toBe(true);
    expect(tool.content.length).toBeGreaterThan(0);
  });

  it("projects live `entry` events through entryView — same shape as a loaded tree, no signed reasoning", async () => {
    fs.writeFileSync(path.join(root, "notes.txt"), "hello from disk\n");
    const app = makeApp();
    const created = (await (await app.request("/session", { method: "POST" })).json()) as { sessionId: string };
    const id = created.sessionId;

    const sse = await app.request(`/session/${id}/events`);
    const reader = sse.body!.getReader();
    await readEventsUntil(reader, (evts) => evts.some((e) => e.type === "ready"));

    await app.request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id, text: "read it" }),
    });
    const events = await readEventsUntil(reader, (evts) => evts.filter((e) => e.type === "entry").length >= 4);
    await reader.cancel();

    const entries = events.filter((e) => e.type === "entry").map((e) => e.entry);
    const tool = entries.find((e: any) => e.type === "tool");
    const caller = entries.find((e: any) => e.type === "assistant" && e.toolCalls?.length);

    expect(tool.toolCallId).toBe("call_7");
    expect(tool.content).toContain("hello from disk");
    expect(caller.toolCalls[0]).toEqual({ id: "call_7", name: "read_file", arguments: JSON.stringify({ path: "notes.txt" }) });
    // Readable reasoning is for the UI; the opaque signed blob never leaves the server.
    expect(caller.reasoningText).toContain("look at the file");
    expect(caller.reasoning).toBeUndefined();
  });
});
