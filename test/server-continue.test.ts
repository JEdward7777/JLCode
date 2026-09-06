/**
 * The Continue endpoint (D-79) — the HTTP half of the tool-round budget pause.
 * Tier-0: an offline driver that never stops calling tools reaches the pause,
 * and `POST /session/:id/continue` resumes the same turn on a doubled budget.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createServer } from "../src/server/server";
import { ConversationStore } from "../src/persist/conversation-store";
import { Session } from "../src/session/session";
import { ToolRegistry } from "../src/tools/registry";
import { fileTools } from "../src/tools/file-tools";
import { Sandbox } from "../src/tools/sandbox";
import type { ModelConfig } from "../src/config/types";
import type { LlmDriver, StreamEvent } from "../src/llm/types";

const config: ModelConfig = {
  id: "cfg_x",
  name: "Test",
  openRouterKey: "sk",
  model: "m",
  defaultMode: "code",
  defaultApproval: "full-auto",
  createdAt: "",
  updatedAt: "",
};

/** Calls a tool for `rounds` turns, then answers. */
function toolLoopDriver(rounds: number): LlmDriver {
  let calls = 0;
  return {
    async *streamChat(): AsyncGenerator<StreamEvent> {
      calls++;
      if (calls <= rounds) {
        yield {
          type: "tool_call",
          index: 0,
          id: `call_${calls}`,
          name: "read_file",
          argsDelta: JSON.stringify({ path: "a.txt" }),
        };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text", delta: "Done." };
        yield { type: "finish", reason: "stop" };
      }
    },
  };
}

let storeDir: string;
let workDir: string;
let store: ConversationStore;
beforeEach(() => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-cont-"));
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-cont-work-"));
  fs.writeFileSync(path.join(workDir, "a.txt"), "content");
  store = new ConversationStore(storeDir);
});
afterEach(async () => {
  await store.close();
  fs.rmSync(storeDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

function makeApp(rounds: number, budget: number) {
  return createServer({
    resolveConfig: () => config,
    newSession: (c, conversation) =>
      new Session({
        config: c,
        driver: toolLoopDriver(rounds),
        conversation,
        maxToolIterations: budget,
        tools: new ToolRegistry(fileTools()),
        sandbox: new Sandbox([workDir]),
      }),
    store,
    workingDir: workDir,
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

describe("Continue endpoint (D-79)", () => {
  it("reports the pause in the settled state, with the budget it would raise to", async () => {
    const app = makeApp(99, 3);
    const id = (await post(app, "/session", {})).json.sessionId as string;
    const state = await post(app, "/chat", { sessionId: id, text: "go" });

    expect(state.json.status).toBe("awaiting-continue");
    expect(state.json.stallRequest).toMatchObject({ rounds: 3, budget: 3, nextBudget: 6 });
  });

  it("resumes the held turn on a doubled budget", async () => {
    const app = makeApp(5, 3); // 5 tool rounds then an answer
    const id = (await post(app, "/session", {})).json.sessionId as string;
    await post(app, "/chat", { sessionId: id, text: "go" });

    const resumed = await post(app, `/session/${id}/continue`, {});

    expect(resumed.status).toBe(200);
    expect(resumed.json.status).toBe("idle");
    expect(resumed.json.reply).toBe("Done.");
  });

  it("refuses to continue a session that is not paused", async () => {
    const app = makeApp(0, 3);
    const id = (await post(app, "/session", {})).json.sessionId as string;
    await post(app, "/chat", { sessionId: id, text: "go" });

    const res = await post(app, `/session/${id}/continue`, {});
    expect(res.status).toBe(409);
  });

  it("404s an unknown session", async () => {
    const app = makeApp(0, 3);
    const res = await post(app, "/session/sess_nope/continue", {});
    expect(res.status).toBe(404);
  });
});
