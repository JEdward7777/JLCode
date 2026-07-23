import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Session } from "../src/session/session";
import { Sandbox } from "../src/tools/sandbox";
import { ToolRegistry } from "../src/tools/registry";
import { fileTools } from "../src/tools/file-tools";
import type { LlmDriver, StreamEvent } from "../src/llm/types";
import type { ModelConfig } from "../src/config/types";
import type { SessionEvent } from "../src/session/types";

const config: ModelConfig = {
  id: "cfg_x",
  name: "T",
  openRouterKey: "sk",
  model: "m",
  defaultMode: "code",
  defaultApproval: "manual",
  createdAt: "",
  updatedAt: "",
};

/** First model turn emits a tool call; subsequent turns give a final answer. */
function toolThenAnswer(name: string, args: unknown, answer = "Done."): LlmDriver {
  let calls = 0;
  return {
    async *streamChat(): AsyncGenerator<StreamEvent> {
      calls++;
      if (calls === 1) {
        yield { type: "tool_call", index: 0, id: "call_1", name, argsDelta: JSON.stringify(args) };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text", delta: answer };
        yield { type: "finish", reason: "stop" };
      }
    },
  };
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-st-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function makeSession(driver: LlmDriver): { session: Session; events: SessionEvent[] } {
  const session = new Session({
    config,
    driver,
    tools: new ToolRegistry(fileTools()),
    sandbox: new Sandbox([root]),
  });
  const events: SessionEvent[] = [];
  session.onEvent((e) => events.push(e));
  return { session, events };
}

describe("Session tool loop", () => {
  it("executes a tool call, feeds the result back, and finishes", async () => {
    const { session, events } = makeSession(
      toolThenAnswer("write_file", { path: "hello.txt", content: "hi from the agent" }),
    );
    await session.send("create hello.txt");

    // The tool actually ran against the sandbox.
    expect(fs.readFileSync(path.join(root, "hello.txt"), "utf8")).toBe("hi from the agent");

    // Conversation: user, assistant(tool_call), tool(result), assistant(final).
    expect(session.conversation.entries.map((e) => e.type)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(events.some((e) => e.type === "tool-start" && e.name === "write_file")).toBe(true);
    expect(events.some((e) => e.type === "tool-end" && e.name === "write_file" && !e.isError)).toBe(true);
    expect(session.status).toBe("idle");
  });

  it("does not execute a tool with truncated/invalid JSON arguments (D-30)", async () => {
    const driver: LlmDriver = {
      async *streamChat(): AsyncGenerator<StreamEvent> {
        yield { type: "tool_call", index: 0, id: "c", name: "write_file", argsDelta: '{"path":"x.txt","content":"par' };
        yield { type: "finish", reason: "tool_calls" };
      },
    };
    const { session } = makeSession(driver);
    await session.send("write a big file");
    // No file created; the tool result is an error, not an applied partial write.
    expect(fs.existsSync(path.join(root, "x.txt"))).toBe(false);
    const toolEntry = session.conversation.entries.find((e) => e.type === "tool");
    expect(toolEntry && toolEntry.type === "tool" && toolEntry.isError).toBe(true);
  });

  it("reports an unknown tool without crashing", async () => {
    const { session } = makeSession(toolThenAnswer("no_such_tool", {}));
    await session.send("do something");
    const toolEntry = session.conversation.entries.find((e) => e.type === "tool");
    expect(toolEntry && toolEntry.type === "tool" && toolEntry.content).toContain("unknown tool");
  });
});
