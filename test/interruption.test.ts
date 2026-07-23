import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Session } from "../src/session/session";
import { scriptedDriver } from "../src/session/fake";
import { ToolRegistry } from "../src/tools/registry";
import { runCommandTool } from "../src/tools/shell-tool";
import { Sandbox } from "../src/tools/sandbox";
import type { LlmDriver, StreamEvent } from "../src/llm/types";
import type { ModelConfig } from "../src/config/types";
import type { SessionEvent } from "../src/session/types";
import type { AssistantEntry, ToolEntry } from "../src/conversation/types";

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

const tick = () => new Promise((r) => setTimeout(r, 5));
const waitUntil = async (cond: () => boolean, ms = 4000) => {
  const start = Date.now();
  while (!cond() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error("waitUntil timed out");
};

function toolCallEvents(name: string, args: unknown): StreamEvent[] {
  return [
    { type: "tool_call", index: 0, id: `c_${Date.now()}`, name, argsDelta: JSON.stringify(args) },
    { type: "finish", reason: "tool_calls" },
  ];
}
function textEvents(text: string): StreamEvent[] {
  return [
    { type: "text", delta: text },
    { type: "finish", reason: "stop" },
  ];
}

function toolSession(driver: LlmDriver, watchdogMs?: number) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-intr-"));
  const session = new Session({
    config,
    driver,
    tools: new ToolRegistry([runCommandTool()]),
    sandbox: new Sandbox([tmp]),
    watchdogMs,
  });
  return { session, tmp };
}

describe("global stop (D-34)", () => {
  it("hard stop aborts the in-flight LLM request and discards the turn", async () => {
    // A driver that emits a little then hangs until the request is aborted.
    const driver: LlmDriver = {
      async *streamChat(_req, opts) {
        yield { type: "text", delta: "partial" };
        await new Promise<void>((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      },
    };
    const session = new Session({ config, driver });
    const events: SessionEvent[] = [];
    session.onEvent((e) => events.push(e));

    const p = session.send("go");
    await tick(); // let the stream start and hang
    session.stop("hard");
    await p;

    expect(session.status).toBe("idle");
    // The hung turn was discarded — no assistant entry committed.
    expect(session.conversation.entries.some((e) => e.type === "assistant")).toBe(false);
    expect(events.some((e) => e.type === "stopped" && e.scope === "hard")).toBe(true);
    // Not counted as a failure (circuit breaker untouched): still sendable.
    expect(session.status).not.toBe("halted");
  });

  it("hard stop clears a pending queue", async () => {
    const session = new Session({ config, driver: scriptedDriver(textEvents("hi")) });
    session.setQueue([{ text: "B" }, { text: "C" }]);
    expect(session.queuedMessages).toHaveLength(2);
    session.stop("hard");
    expect(session.queuedMessages).toHaveLength(0);
  });

  it("soft stop lets the running command finish but takes no further LLM turn", async () => {
    // turn 1 → a quick command; after its result the model would answer "done".
    const driver = scriptedDriver((req) => {
      const last = req.messages[req.messages.length - 1];
      if (last?.role === "tool") return textEvents("done");
      return toolCallEvents("run_command", { command: "echo hello" });
    });
    const { session } = toolSession(driver);
    let taskStarted = false;
    session.onEvent((e) => {
      if (e.type === "task-start") {
        taskStarted = true;
        session.stop("soft"); // stop while the command is running
      }
    });
    await session.send("go");

    expect(taskStarted).toBe(true);
    expect(session.status).toBe("idle");
    // The command's tool result is present (it finished)…
    const tools = session.conversation.entries.filter((e) => e.type === "tool") as ToolEntry[];
    expect(tools).toHaveLength(1);
    expect(tools[0]!.content).toContain("hello");
    // …but no second assistant turn ("done") was taken.
    const assistants = session.conversation.entries.filter((e) => e.type === "assistant") as AssistantEntry[];
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.text).toBe("");
  });
});

describe("background task kill (D-34)", () => {
  it("lists a running command and kills it on demand (whole process group)", async () => {
    const driver = scriptedDriver((req) => {
      const last = req.messages[req.messages.length - 1];
      if (last?.role === "tool") return textEvents("done");
      return toolCallEvents("run_command", { command: "sleep 30" });
    });
    const { session } = toolSession(driver);
    let taskId: string | null = null;
    session.onEvent((e) => {
      if (e.type === "task-start") taskId = e.task.id;
    });

    const p = session.send("go");
    await waitUntil(() => taskId !== null);
    expect(session.taskList).toHaveLength(1);
    expect(session.killTask(taskId!)).toBe(true);
    await p;

    const tools = session.conversation.entries.filter((e) => e.type === "tool") as ToolEntry[];
    expect(tools[0]!.content).toContain("killed by the user");
    expect(session.taskList).toHaveLength(0); // no longer running
    const assistants = session.conversation.entries.filter((e) => e.type === "assistant") as AssistantEntry[];
    expect(assistants[assistants.length - 1]!.text).toBe("done");
  });
});

describe("watchdog (D-34)", () => {
  it("asks the model out-of-band and kills on a yes — without touching the conversation", async () => {
    const decideRequests: number[] = [];
    const driver = scriptedDriver((req) => {
      const last = req.messages[req.messages.length - 1];
      const content = typeof last?.content === "string" ? last.content : "";
      if (content.includes("[watchdog]")) {
        decideRequests.push(req.messages.length);
        return toolCallEvents("decide_kill", { kill: true, reason: "running too long" });
      }
      if (last?.role === "tool") return textEvents("done");
      return toolCallEvents("run_command", { command: "sleep 30" });
    });
    const { session } = toolSession(driver, 20); // 20ms watchdog

    await session.send("go");

    expect(decideRequests.length).toBeGreaterThanOrEqual(1);
    const tools = session.conversation.entries.filter((e) => e.type === "tool") as ToolEntry[];
    expect(tools[0]!.content).toContain("watchdog");
    // The out-of-band Q&A never entered the conversation tree.
    const hasWatchdogEntry = session.conversation.entries.some(
      (e) => e.type === "user" && e.text.includes("[watchdog]"),
    );
    expect(hasWatchdogEntry).toBe(false);
    const assistants = session.conversation.entries.filter((e) => e.type === "assistant") as AssistantEntry[];
    expect(assistants[assistants.length - 1]!.text).toBe("done");
  });

  it("re-arms on a no and does not kill", async () => {
    let asks = 0;
    const driver = scriptedDriver((req) => {
      const last = req.messages[req.messages.length - 1];
      const content = typeof last?.content === "string" ? last.content : "";
      if (content.includes("[watchdog]")) {
        asks++;
        return toolCallEvents("decide_kill", { kill: false });
      }
      if (last?.role === "tool") return textEvents("done");
      return toolCallEvents("run_command", { command: "echo quick" });
    });
    const { session } = toolSession(driver, 20);
    // `echo quick` exits on its own; the watchdog should mostly find it gone.
    await session.send("go");
    const assistants = session.conversation.entries.filter((e) => e.type === "assistant") as AssistantEntry[];
    expect(assistants[assistants.length - 1]!.text).toBe("done");
    // No kill note in the tool result (it exited normally).
    const tools = session.conversation.entries.filter((e) => e.type === "tool") as ToolEntry[];
    expect(tools[0]!.content).not.toContain("watchdog");
  });
});

describe("queued message (D-34)", () => {
  it("applies queued messages FIFO at turn boundaries", async () => {
    const session = new Session({ config, driver: scriptedDriver(textEvents("ok")) });
    session.setQueue([{ text: "B" }, { text: "C" }]);
    await session.send("A"); // drains B then C at successive boundaries

    const users = session.conversation.entries.filter((e) => e.type === "user").map((e: any) => e.text);
    expect(users).toEqual(["A", "B", "C"]);
    expect(session.queuedMessages).toHaveLength(0);
  });

  it("enqueue while idle sends immediately", async () => {
    const session = new Session({ config, driver: scriptedDriver(textEvents("ok")) });
    await session.send("A");
    await session.enqueue("B");
    const users = session.conversation.entries.filter((e) => e.type === "user").map((e: any) => e.text);
    expect(users).toEqual(["A", "B"]);
  });
});
