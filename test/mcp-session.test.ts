/**
 * P7a Tier-1: MCP tools driven through a real `Session` — the same gate, the
 * same D-19 soft fence, the same approval pause as a native tool (D-47b/d).
 * The MCP server is a real stdio child; the model is the fake driver.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Session } from "../src/session/session";
import { Sandbox } from "../src/tools/sandbox";
import { ToolRegistry } from "../src/tools/registry";
import { ModeApprovalGate } from "../src/tools/mode-gate";
import { McpManager } from "../src/mcp/client";
import type { LoadedSettings } from "../src/mcp/config";
import type { LlmDriver, StreamEvent } from "../src/llm/types";
import type { ModelConfig } from "../src/config/types";

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
let outside: string;
let configDir: string;
let mcp: McpManager;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-mcpsess-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-outside-"));
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-mcpsesscfg-"));
  const settings: LoadedSettings = {
    servers: [
      {
        name: "testsrv",
        scope: "global",
        config: {
          command: process.execPath,
          args: [SERVER],
          pathFields: ["path", "target"],
          notPathFields: ["text"],
        },
      },
    ],
    problems: [],
    files: { global: path.join(configDir, "mcp_settings.json"), workspace: path.join(root, ".jlcode", "mcp_settings.json") },
  };
  mcp = await McpManager.start({ workspace: root, settings });
});

afterEach(async () => {
  await mcp.close();
  for (const dir of [root, outside, configDir]) fs.rmSync(dir, { recursive: true, force: true });
});

function session(driver: LlmDriver, approval: "manual" | "full-auto" = "manual") {
  return new Session({
    config,
    driver,
    tools: new ToolRegistry([...mcp.tools()]),
    sandbox: new Sandbox([root]),
    gate: new ModeApprovalGate("code", approval),
  });
}

describe("MCP tools in a session", () => {
  it("runs an in-fence MCP write after approval, like any native tool", async () => {
    const target = path.join(root, "made.txt");
    const s = session(callThenAnswer("testsrv__touch_file", { path: target, body: "from mcp" }));
    await s.send("make a file");
    expect(s.status).toBe("awaiting-approval");
    expect(s.awaitingApproval?.tool).toBe("testsrv__touch_file");
    expect(fs.existsSync(target)).toBe(false);

    await s.approve({ approve: true });
    expect(s.status).toBe("idle");
    expect(fs.readFileSync(target, "utf8")).toBe("from mcp");
    const toolEntry = s.conversation.entries.find((e) => e.type === "tool");
    expect(toolEntry && toolEntry.type === "tool" && toolEntry.content).toContain("wrote ");
  });

  it("an out-of-fence MCP path prompts as an escape, even under full-auto (D-19)", async () => {
    const target = path.join(outside, "escaped.txt");
    const s = session(callThenAnswer("testsrv__touch_file", { path: target, body: "nope" }), "full-auto");
    await s.send("write outside");
    expect(s.status).toBe("awaiting-approval");
    expect(s.awaitingApproval?.outOfFence?.paths[0]).toBe(fs.realpathSync(outside) + path.sep + "escaped.txt");
    expect(fs.existsSync(target)).toBe(false);

    await s.approve({ approve: false });
    expect(fs.existsSync(target)).toBe(false);
  });

  it("a field the user classified as prose never trips the fence", async () => {
    // `text` is in notPathFields: slashy or not, it is never fence-checked, so a
    // read-only tool with only prose args runs straight through.
    const s = session(callThenAnswer("testsrv__echo", { text: "../../etc/passwd is just text" }), "full-auto");
    await s.send("echo something slashy");
    expect(s.status).toBe("idle");
    const toolEntry = s.conversation.entries.find((e) => e.type === "tool");
    expect(toolEntry && toolEntry.type === "tool" && toolEntry.content).toContain("echo: ../../etc/passwd");
  });

  it("an unclassified slashy field is fenced fail-closed until it is answered", async () => {
    // `note` is in neither list — an escaping value must still be caught.
    const s = session(
      callThenAnswer("testsrv__echo", { text: "hi", note: path.join(outside, "secret.txt") }),
      "full-auto",
    );
    await s.send("echo with a mystery field");
    expect(s.status).toBe("awaiting-approval");
    expect(s.awaitingApproval?.reason).toBe("access outside the workspace");
  });

  it("Ask mode blocks an unannotated MCP tool but allows a readOnlyHint one (D-47b)", async () => {
    const blocked = new Session({
      config,
      driver: callThenAnswer("testsrv__echo", { text: "hi" }),
      tools: new ToolRegistry([...mcp.tools()]),
      sandbox: new Sandbox([root]),
      gate: new ModeApprovalGate("ask", "manual"),
    });
    await blocked.send("try to echo");
    expect(blocked.status).toBe("idle");
    const denied = blocked.conversation.entries.find((e) => e.type === "tool");
    expect(denied && denied.type === "tool" && denied.content).toMatch(/denied: Ask mode is read-only/);

    const allowed = new Session({
      config,
      driver: callThenAnswer("testsrv__peek", { target: "notes.md" }),
      tools: new ToolRegistry([...mcp.tools()]),
      sandbox: new Sandbox([root]),
      gate: new ModeApprovalGate("ask", "manual"),
    });
    await allowed.send("peek");
    const ok = allowed.conversation.entries.find((e) => e.type === "tool");
    expect(ok && ok.type === "tool" && ok.content).toBe("peeked notes.md");
  });
});
