import { describe, it, expect } from "vitest";
import { ModeApprovalGate } from "../src/tools/mode-gate";
import type { Tool, ToolKind } from "../src/tools/types";

function fakeTool(name: string, kind: ToolKind, mutates: boolean): Tool {
  return {
    name,
    kind,
    mutates,
    def: { type: "function", function: { name, parameters: { type: "object", properties: {} } } },
    execute: async () => ({ content: "" }),
  };
}

const read = fakeTool("read_file", "read", false);
const write = fakeTool("write_file", "write", true);
const del = fakeTool("delete_file", "write", true);
const cmd = fakeTool("run_command", "command", true);

describe("mode capability", () => {
  it("Ask mode is read-only", () => {
    const g = new ModeApprovalGate("ask", "full-auto");
    expect(g.check(read, {})).toEqual({ kind: "allow" });
    expect(g.check(write, { path: "x.md" }).kind).toBe("deny");
    expect(g.check(cmd, { command: "ls" }).kind).toBe("deny");
  });

  it("Plan mode allows markdown writes and git commands only", () => {
    const g = new ModeApprovalGate("plan", "full-auto");
    expect(g.check(write, { path: "plan.md" })).toEqual({ kind: "allow" });
    expect(g.check(write, { path: "code.ts" }).kind).toBe("deny");
    expect(g.check(del, { path: "plan.md" }).kind).toBe("deny");
    expect(g.check(cmd, { command: "git commit -m x" })).toEqual({ kind: "allow" });
    expect(g.check(cmd, { command: "rm -rf /" }).kind).toBe("deny");
  });

  it("Code mode allows everything (approval still applies)", () => {
    const g = new ModeApprovalGate("code", "full-auto");
    expect(g.check(write, { path: "code.ts" })).toEqual({ kind: "allow" });
    expect(g.check(cmd, { command: "npm test" })).toEqual({ kind: "allow" });
  });
});

describe("approval policy (Code mode)", () => {
  it("manual prompts for mutating tools", () => {
    expect(new ModeApprovalGate("code", "manual").check(write, { path: "a" }).kind).toBe("prompt");
  });
  it("read-only denies side effects", () => {
    expect(new ModeApprovalGate("code", "read-only").check(cmd, { command: "ls" }).kind).toBe("deny");
  });
  it("auto-safe auto-approves allowlisted commands, prompts otherwise", () => {
    const g = new ModeApprovalGate("code", "auto-safe", ["git status", "npm test"]);
    expect(g.check(cmd, { command: "npm test -- --watch" })).toEqual({ kind: "allow" });
    expect(g.check(cmd, { command: "rm x" }).kind).toBe("prompt");
    expect(g.check(write, { path: "a" }).kind).toBe("prompt");
  });
});
