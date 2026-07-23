import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Session } from "../src/session/session";
import { Sandbox } from "../src/tools/sandbox";
import { ToolRegistry } from "../src/tools/registry";
import { fileTools } from "../src/tools/file-tools";
import { askUserTool } from "../src/tools/ask-user";
import { ModeApprovalGate } from "../src/tools/mode-gate";
import type { LlmDriver, StreamEvent } from "../src/llm/types";
import type { ModelConfig } from "../src/config/types";

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

/** First turn emits one tool call; later turns give a final answer. */
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
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-appr-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function session(driver: LlmDriver) {
  return new Session({
    config,
    driver,
    tools: new ToolRegistry([...fileTools(), askUserTool()]),
    sandbox: new Sandbox([root]),
    gate: new ModeApprovalGate("code", "manual"),
  });
}

describe("approval flow (D-16)", () => {
  it("pauses for approval, then runs on approve", async () => {
    const s = session(callThenAnswer("write_file", { path: "a.txt", content: "approved" }));
    await s.send("write a.txt");
    expect(s.status).toBe("awaiting-approval");
    expect(s.awaitingApproval?.tool).toBe("write_file");
    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(false); // not yet

    await s.approve({ approve: true });
    expect(s.status).toBe("idle");
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("approved");
  });

  it("does not run on deny", async () => {
    const s = session(callThenAnswer("write_file", { path: "b.txt", content: "x" }));
    await s.send("write b.txt");
    await s.approve({ approve: false, reason: "no thanks" });
    expect(fs.existsSync(path.join(root, "b.txt"))).toBe(false);
    const toolEntry = s.conversation.entries.find((e) => e.type === "tool");
    expect(toolEntry && toolEntry.type === "tool" && toolEntry.content).toContain("denied by user");
  });

  it("runs edited arguments (edit-then-approve)", async () => {
    const s = session(callThenAnswer("write_file", { path: "c.txt", content: "original" }));
    await s.send("write c.txt");
    await s.approve({ approve: true, editedArgs: { path: "c.txt", content: "edited" } });
    expect(fs.readFileSync(path.join(root, "c.txt"), "utf8")).toBe("edited");
    const toolEntry = s.conversation.entries.find((e) => e.type === "tool");
    expect(toolEntry && toolEntry.type === "tool" && toolEntry.content).toContain("edited the arguments");
  });
});

describe("ask_user flow (D-18)", () => {
  it("pauses for input, then resumes with the answer", async () => {
    const s = session(callThenAnswer("ask_user", { question: "Which color?", options: ["red", "blue"] }));
    await s.send("pick a color");
    expect(s.status).toBe("awaiting-input");
    expect(s.awaitingInput?.question).toBe("Which color?");

    await s.answer("blue");
    expect(s.status).toBe("idle");
    const toolEntry = s.conversation.entries.find((e) => e.type === "tool");
    expect(toolEntry && toolEntry.type === "tool" && toolEntry.content).toBe("blue");
  });
});

describe("out-of-fence access — soft fence (D-19)", () => {
  let outside: string;
  beforeEach(() => {
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-outside-"));
  });
  afterEach(() => {
    fs.rmSync(outside, { recursive: true, force: true });
  });

  function fenceSession(driver: LlmDriver, onAddRoot?: (dir: string) => void) {
    return new Session({
      config,
      driver,
      tools: new ToolRegistry([...fileTools(), askUserTool()]),
      sandbox: new Sandbox([root]),
      // full-auto: only the fence (not the policy) can force the pause.
      gate: new ModeApprovalGate("code", "full-auto"),
      onAddRoot,
    });
  }

  it("pauses for approval even under full-auto, and runs on allow-once", async () => {
    const target = path.join(outside, "ext.txt");
    let remembered: string[] = [];
    const s = fenceSession(callThenAnswer("write_file", { path: target, content: "external" }), (d) =>
      remembered.push(d),
    );
    await s.send("write outside");
    expect(s.status).toBe("awaiting-approval");
    expect(s.awaitingApproval?.outOfFence?.paths[0]).toBe(target);
    expect(fs.existsSync(target)).toBe(false);

    await s.approve({ approve: true }); // allow once (no addRoot)
    expect(fs.readFileSync(target, "utf8")).toBe("external");
    expect(remembered).toEqual([]); // one-shot, not persisted
  });

  it("remembers the root when addRoot is set (persist callback + widen)", async () => {
    const target = path.join(outside, "keep.txt");
    const remembered: string[] = [];
    const s = fenceSession(callThenAnswer("write_file", { path: target, content: "x" }), (d) => remembered.push(d));
    await s.send("write outside");
    await s.approve({ approve: true, addRoot: true });
    expect(fs.existsSync(target)).toBe(true);
    expect(remembered).toEqual([fs.realpathSync(outside)]);
  });

  it("denies out-of-fence access on deny", async () => {
    const target = path.join(outside, "no.txt");
    const s = fenceSession(callThenAnswer("write_file", { path: target, content: "x" }));
    await s.send("write outside");
    await s.approve({ approve: false });
    expect(fs.existsSync(target)).toBe(false);
    const toolEntry = s.conversation.entries.find((e) => e.type === "tool");
    expect(toolEntry && toolEntry.type === "tool" && toolEntry.content).toContain("denied by user");
  });
});

describe("mode denial", () => {
  it("denies a write in Ask mode (no pause, tool error)", async () => {
    const s = new Session({
      config,
      driver: callThenAnswer("write_file", { path: "x.txt", content: "nope" }),
      tools: new ToolRegistry([...fileTools(), askUserTool()]),
      sandbox: new Sandbox([root]),
      gate: new ModeApprovalGate("ask", "manual"),
    });
    await s.send("write a file");
    expect(s.status).toBe("idle"); // denied inline, no approval pause
    expect(fs.existsSync(path.join(root, "x.txt"))).toBe(false);
    const toolEntry = s.conversation.entries.find((e) => e.type === "tool");
    expect(toolEntry && toolEntry.type === "tool" && toolEntry.isError).toBe(true);
    expect(toolEntry && toolEntry.type === "tool" && toolEntry.content).toContain("Ask mode");
  });
});
