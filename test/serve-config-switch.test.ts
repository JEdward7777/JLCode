/**
 * D-82a — the switch reaches open threads, and **the server is the one that
 * notices**.
 *
 * This was Joshua's own correction, and it deleted a whole design: the first
 * sketch had `config model` discover a running server through a pidfile so it
 * could warn about a `--config` pin and name the threads about to change. His
 * question — *"wouldn't it be the server's job to notice the config switched?"*
 * — is right, and inverting it removed the state file, the liveness check and
 * the CLI's knowledge of the server entirely. Nothing in this file imports
 * anything from the CLI side except the command itself, which is the point.
 *
 * The seam is **the top of a user turn**, and the second test is the reason for
 * that qualifier. "Any time the system has paused" read literally would include
 * an `ask_user` or an approval — but those pause *mid-cycle*, with an assistant
 * message above them carrying signed reasoning from the outgoing model. Adopting
 * a new model there hands model B model A's signed thinking, which is exactly
 * what D-28/D-38 forbid. A user turn is a clean boundary with no half-finished
 * cycle below it, and it is seconds away.
 *
 * Tier 0: the fake driver records the model each request names, so "the thread
 * is now running on Sonnet" is asserted on the wire rather than on a label.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createServer } from "../src/server/server";
import { createSessionFactory, createSessionRetarget } from "../src/server/session-factory";
import { ConversationStore } from "../src/persist/conversation-store";
import { ModelCatalog } from "../src/llm/models";
import { runConfigModel } from "../src/config/model-command";
import { loadConfig, saveConfig, defaultConfig } from "../src/config/store";
import { addModelConfig, resolveForCwd, setBinding } from "../src/config/operations";
import { resolvePaths, type JlcodePaths } from "../src/paths";
import type { LlmDriver, StreamEvent } from "../src/llm/types";
import type { ModelConfig } from "../src/config/types";

const CATALOG = {
  fetchedAt: "2099-01-01T00:00:00.000Z",
  windows: { "anthropic/claude-opus-5": 1_000_000, "anthropic/claude-sonnet-5": 200_000 },
  modalities: {
    "anthropic/claude-opus-5": ["text", "image"],
    "anthropic/claude-sonnet-5": ["text", "image"],
  },
  prices: {
    "anthropic/claude-opus-5": { promptPerMTok: 5, completionPerMTok: 25 },
    "anthropic/claude-sonnet-5": { promptPerMTok: 3, completionPerMTok: 15 },
  },
  limits: {},
};

let dir: string;
let paths: JlcodePaths;
let workspace: string;
let store: ConversationStore;
let catalog: ModelCatalog;
/** Every model id that reached the driver, in order — the ground truth. */
let called: string[];
const saved = { config: process.env.JLCODE_CONFIG_DIR, data: process.env.JLCODE_DATA_DIR };

/** Is this the ephemeral auto-title ask (X-09/D-81) rather than a turn of the
 *  conversation? It rides the same prefix through the same driver, so a test
 *  counting turns has to tell them apart — and it answers with a name, since a
 *  turn that never resolves would hang the settle. */
function isTitleAsk(req: { messages: Array<{ role: string; content: unknown }> }): boolean {
  const last = req.messages[req.messages.length - 1];
  return typeof last?.content === "string" && last.content.includes("Name this conversation");
}

const TITLE: StreamEvent[] = [
  { type: "text", delta: "A thread" },
  { type: "finish", reason: "stop" },
];

/** A driver that answers in one turn and records what model it was asked as. */
function plainDriver(model: string): LlmDriver {
  return {
    async *streamChat(req): AsyncGenerator<StreamEvent> {
      expect(req.model).toBe(model); // the driver is built per config; they must agree
      if (isTitleAsk(req)) {
        yield* TITLE;
        return;
      }
      called.push(req.model);
      yield { type: "text", delta: "ok" };
      yield { type: "finish", reason: "stop" };
    },
  };
}

/** A driver whose first turn calls `ask_user` — the mid-cycle pause. */
function askDriver(model: string): LlmDriver {
  let n = 0;
  return {
    async *streamChat(req): AsyncGenerator<StreamEvent> {
      if (isTitleAsk(req)) {
        yield* TITLE;
        return;
      }
      called.push(req.model);
      n++;
      if (n === 1) {
        yield {
          type: "tool_call",
          index: 0,
          id: "c1",
          name: "ask_user",
          argsDelta: JSON.stringify({ questions: [{ header: "Env", question: "Which env?" }] }),
        };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text", delta: "done" };
        yield { type: "finish", reason: "stop" };
      }
    },
  };
}

function seedOpus(): ModelConfig {
  const { config: next, added } = addModelConfig(defaultConfig(), {
    name: "JLCode — opus",
    model: "anthropic/claude-opus-5",
    openRouterKey: "sk-client-a",
    defaultMode: "code",
    defaultApproval: "manual",
    compaction: { auto: true },
  });
  saveConfig(setBinding(next, workspace, added.id), paths);
  return added;
}

/** The server as `serve` wires it: a config re-read per call, the real session
 *  factory, and the retarget built from the same deps (X-40, D-82a). */
function makeApp(makeDriver: (config: ModelConfig) => LlmDriver) {
  const deps = { paths, cwd: workspace, makeDriver, mcpTools: () => [], catalog };
  return createServer({
    resolveConfig: () => resolveForCwd(loadConfig(paths), workspace),
    newSession: createSessionFactory(deps),
    retargetSession: createSessionRetarget(deps),
    store,
    workingDir: workspace,
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
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

/** What `jlcode config model <slug>` does, from another terminal. */
const switchTo = (slug: string): Promise<number> =>
  runConfigModel([slug, "--offline"], { paths, cwd: workspace });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-x40srv-"));
  process.env.JLCODE_CONFIG_DIR = path.join(dir, "config");
  process.env.JLCODE_DATA_DIR = path.join(dir, "data");
  paths = resolvePaths();
  fs.mkdirSync(path.dirname(paths.modelsCacheFile), { recursive: true });
  fs.writeFileSync(paths.modelsCacheFile, JSON.stringify(CATALOG), "utf8");
  workspace = path.join(dir, "work");
  fs.mkdirSync(workspace, { recursive: true });
  store = new ConversationStore(path.join(dir, "conversations"));
  catalog = new ModelCatalog({ file: paths.modelsCacheFile });
  called = [];
  seedOpus();
});

afterEach(async () => {
  await store.close();
  process.env.JLCODE_CONFIG_DIR = saved.config;
  process.env.JLCODE_DATA_DIR = saved.data;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("an open thread picks the switch up at its next message", () => {
  it("runs the next user turn on the new model, with the new window", async () => {
    const app = makeApp((c) => plainDriver(c.model));
    const first = await post(app, "/chat", { text: "one" });
    expect(first.status).toBe(200);
    const sessionId = first.json.sessionId as string;
    expect(first.json.contextWindow).toBe(1_000_000);

    // …meanwhile, in another terminal:
    const quiet = silence();
    try {
      expect(await switchTo("anthropic/claude-sonnet-5")).toBe(0);
    } finally {
      quiet();
    }

    // The *same* thread, same session id, next message.
    const second = await post(app, "/chat", { text: "two", sessionId });
    expect(second.status).toBe(200);
    expect(second.json.sessionId).toBe(sessionId);
    expect(called).toEqual(["anthropic/claude-opus-5", "anthropic/claude-sonnet-5"]);
    // The window came with it — a switch that moved the model and not the budget
    // would be H-06 wearing the new feature's clothes.
    expect(second.json.contextWindow).toBe(200_000);
    expect(second.json.contextThreshold).toBe(180_000);
  });

  it("announces the switch on the session's event stream, saying what it was", async () => {
    const app = makeApp((c) => plainDriver(c.model));
    const first = await post(app, "/chat", { text: "one" });
    const sessionId = first.json.sessionId as string;

    const quiet = silence();
    try {
      await switchTo("anthropic/claude-sonnet-5");
    } finally {
      quiet();
    }

    const seen: Record<string, any>[] = [];
    const state = await app.request(`/session/${sessionId}/events`);
    const reader = state.body!.getReader();
    const stop = post(app, "/chat", { text: "two", sessionId });
    // Read until the config frame arrives (the `ready` frame comes first).
    const decoder = new TextDecoder();
    let buffered = "";
    for (let i = 0; i < 40; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      for (const line of buffered.split("\n")) {
        if (line.startsWith("data: ")) {
          try {
            seen.push(JSON.parse(line.slice(6)));
          } catch {
            /* partial frame — it will arrive whole on a later read */
          }
        }
      }
      buffered = "";
      if (seen.some((e) => e.type === "config")) break;
    }
    await reader.cancel();
    await stop;

    const frame = seen.find((e) => e.type === "config");
    expect(frame).toBeDefined();
    expect(frame!.model).toBe("anthropic/claude-sonnet-5");
    // "You are on Sonnet now" is only half the sentence when it was unexpected.
    expect(frame!.from.model).toBe("anthropic/claude-opus-5");
  });

  it("does not switch mid-cycle, where the message above carries signed reasoning", async () => {
    const app = makeApp((c) => askDriver(c.model));
    const first = await post(app, "/chat", { text: "one" });
    expect(first.json.status).toBe("awaiting-input");
    const sessionId = first.json.sessionId as string;

    const quiet = silence();
    try {
      await switchTo("anthropic/claude-sonnet-5");
    } finally {
      quiet();
    }

    // Answering resumes the *same cycle*: still Opus, because the assistant
    // message above the pause is Opus's, signatures and all (D-28/D-38).
    const answered = await post(app, `/session/${sessionId}/answer`, { text: "dev" });
    expect(answered.json.status).toBe("idle");
    expect(called).toEqual(["anthropic/claude-opus-5", "anthropic/claude-opus-5"]);

    // The next *user turn* is the boundary, and it takes the switch.
    await post(app, "/chat", { text: "two", sessionId });
    expect(called[2]).toBe("anthropic/claude-sonnet-5");
  });

  it("leaves a live mode/approval choice alone — a switch is not a reason to overrule it", async () => {
    const app = makeApp((c) => plainDriver(c.model));
    const first = await post(app, "/chat", { text: "one" });
    const sessionId = first.json.sessionId as string;
    const switched = await post(app, `/session/${sessionId}/mode`, { mode: "ask", approval: "read-only" });
    expect(switched.json.mode).toBe("ask");

    const quiet = silence();
    try {
      await switchTo("anthropic/claude-sonnet-5");
    } finally {
      quiet();
    }

    const second = await post(app, "/chat", { text: "two", sessionId });
    expect(second.json.mode).toBe("ask");
    expect(second.json.approval).toBe("read-only");
  });

  it("keeps running under what it has when the folder's binding goes away", async () => {
    const app = makeApp((c) => plainDriver(c.model));
    const first = await post(app, "/chat", { text: "one" });
    const sessionId = first.json.sessionId as string;

    // Unbind the folder entirely — `resolveConfig` now answers nothing.
    const current = loadConfig(paths);
    saveConfig({ ...current, folderBindings: {} }, paths);

    const second = await post(app, "/chat", { text: "two", sessionId });
    expect(second.status).toBe(200);
    expect(called).toEqual(["anthropic/claude-opus-5", "anthropic/claude-opus-5"]);
  });
});

/** Swallow the command's own console output; these tests are about the server. */
function silence(): () => void {
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  return () => {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  };
}
