/**
 * `file_url` (X-43, D-83) — the server half.
 *
 * The tool mints an address during execution; the route has to resolve that
 * address again later, in a session that may no longer exist, without ever
 * becoming a way to read a file the fence never authorized. The cases below are
 * the ones where the difference from the attachment route matters: this serves a
 * **live pointer**, so it must not be cached hard, must re-check the fence, and
 * must answer honestly when the file has moved, vanished, or changed type.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/server/server";
import { ConversationStore } from "../src/persist/conversation-store";
import { Session } from "../src/session/session";
import { Sandbox } from "../src/tools/sandbox";
import { ToolRegistry, defaultTools } from "../src/tools/registry";
import { ModeApprovalGate } from "../src/tools/mode-gate";
import type { LlmDriver, StreamEvent } from "../src/llm/types";
import type { ModelConfig } from "../src/config/types";

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
    "01f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);

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

/** Call `file_url` on `paths`, then answer — the fake model for this suite. */
function shareThenAnswer(paths: string[]): LlmDriver {
  let n = 0;
  return {
    async *streamChat(): AsyncGenerator<StreamEvent> {
      n++;
      if (n === 1) {
        yield { type: "tool_call", index: 0, id: "c1", name: "file_url", argsDelta: JSON.stringify({ paths }) };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text", delta: "Have a look." };
        yield { type: "finish", reason: "stop" };
      }
    },
  };
}

let root: string;
let storeDir: string;
let store: ConversationStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-fur-"));
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-fur-store-"));
  store = new ConversationStore(storeDir);
  fs.writeFileSync(path.join(root, "shot.png"), PNG);
  fs.writeFileSync(path.join(root, "notes.md"), "# report\n");
});
afterEach(async () => {
  await store.close();
  for (const dir of [root, storeDir]) fs.rmSync(dir, { recursive: true, force: true });
});

function makeApp(paths: string[]) {
  return createServer({
    resolveConfig: () => config,
    store,
    workingDir: root,
    newSession: (c, conversation) =>
      new Session({
        config: c,
        driver: shareThenAnswer(paths),
        tools: new ToolRegistry(defaultTools()),
        sandbox: new Sandbox([root]),
        gate: new ModeApprovalGate("code", "full-auto"),
        conversation,
      }),
    version: "0.0.0",
  }).app;
}

/** Drive one `file_url` turn; hand back the app and the URLs it minted. */
async function share(paths: string[]) {
  const app = makeApp(paths);
  const chat = await app.request("/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "show me" }),
  });
  const { sessionId } = (await chat.json()) as { sessionId: string };
  const body = await (await app.request(`/session/${sessionId}`)).text();
  const tree = JSON.parse(body) as { conversationId: string; entries: any[] };
  const tool = tree.entries.find((e) => e.type === "tool");
  const urls = [...String(tool.content).matchAll(/\/conversation\/\S+/g)].map((m) => m[0]);
  return { app, tree, tool, urls, body };
}

describe("file_url route", () => {
  it("serves the file the agent shared, sniffed and nosniffed", async () => {
    const { app, urls } = await share(["shot.png"]);
    expect(urls).toHaveLength(1);

    const res = await app.request(urls[0]!);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // A pointer, not a snapshot: the file can change under a URL that stays
    // valid, so this must never be `immutable` the way an attachment is.
    expect(res.headers.get("cache-control")).not.toContain("immutable");
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("indexes several files under one token", async () => {
    const { app, urls } = await share(["shot.png", "notes.md"]);
    expect(urls).toHaveLength(2);

    expect((await app.request(urls[0]!)).headers.get("content-type")).toBe("image/png");
    const md = await app.request(urls[1]!);
    expect(md.headers.get("content-type")).toBe("text/markdown");
    expect(await md.text()).toContain("# report");
  });

  it("ships no bytes in the transcript itself", async () => {
    const { body } = await share(["shot.png"]);
    // The whole difference from an attachment: the entry carries a path, not a
    // blob. A PNG survives base64 as `iVBORw0KGgo`.
    expect(body).not.toContain("iVBORw0KGgo");
  });

  it("404s once the file is gone, rather than serving something else", async () => {
    const { app, urls } = await share(["shot.png"]);
    expect((await app.request(urls[0]!)).status).toBe(200);

    fs.rmSync(path.join(root, "shot.png"));
    expect((await app.request(urls[0]!)).status).toBe(404);
  });

  it("re-classifies at fetch time, so a file that turns binary stops being served", async () => {
    const { app, urls } = await share(["notes.md"]);
    expect((await app.request(urls[0]!)).status).toBe(200);

    // Same path, PDF bytes now. The mime recorded at mint time must not be what
    // decides — the bytes on disk right now do (D-78b).
    fs.writeFileSync(path.join(root, "notes.md"), Buffer.from("255044462d312e340a25", "hex"));
    expect((await app.request(urls[0]!)).status).toBe(404);
  });

  it("404s an unknown token, index or conversation", async () => {
    const { app, urls, tree } = await share(["shot.png"]);
    const token = urls[0]!.split("/")[4];

    expect((await app.request(`/conversation/nope/file/${token}/0`)).status).toBe(404);
    expect((await app.request(`/conversation/${tree.conversationId}/file/fu_deadbeef/0`)).status).toBe(404);
    expect((await app.request(`/conversation/${tree.conversationId}/file/${token}/7`)).status).toBe(404);
  });

  it("serves a thread nobody has open, from disk (X-11 parity)", async () => {
    const { app, urls } = await share(["shot.png"]);
    await app.request("/shutdown", { method: "POST" }); // flushes the store

    const cold = createServer({
      resolveConfig: () => config,
      store,
      workingDir: root,
      newSession: () => {
        throw new Error("should not start a session");
      },
      version: "0.0.0",
    }).app;
    const res = await cold.request(urls[0]!);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("will not follow a symlink out of the fence it was minted under", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-fur-out-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "PASSWORD=hunter2");
    try {
      const { app, urls } = await share(["notes.md"]);
      expect((await app.request(urls[0]!)).status).toBe(200);

      // Swap the shared path for a symlink pointing outside. The URL is still
      // valid; the target is not, and the recorded fenceRoot is what says so.
      fs.rmSync(path.join(root, "notes.md"));
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "notes.md"));

      const res = await app.request(urls[0]!);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("hunter2");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
