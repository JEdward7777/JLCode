/**
 * P7a Tier-1: the MCP client against a **real stdio server child** (no mock) —
 * discovery, the bridged `Tool` shape and classification (D-47b), calls, dead
 * servers, and learned path fields persisting to the owning settings file
 * (D-47d). Free: the child is a local node script, no model involved.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpManager } from "../src/mcp/client";
import { bridgedToolName, renderMcpContent } from "../src/mcp/bridge";
import { Sandbox } from "../src/tools/sandbox";
import { ModeApprovalGate } from "../src/tools/mode-gate";
import type { LoadedSettings } from "../src/mcp/config";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-test-server.mjs");

let workspace: string;
let configDir: string;
let managers: McpManager[];

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-mcpws-"));
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-mcpcfg-"));
  managers = [];
});
afterEach(async () => {
  for (const m of managers) await m.close();
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
});

/** Settings pointing at the fixture server, injected so no real file is read. */
function settings(overrides: Record<string, unknown> = {}, scope: "global" | "workspace" = "global"): LoadedSettings {
  return {
    servers: [
      {
        name: "testsrv",
        scope,
        config: { command: process.execPath, args: [SERVER], ...overrides },
      },
    ],
    problems: [],
    files: {
      global: path.join(configDir, "mcp_settings.json"),
      workspace: path.join(workspace, ".jlcode", "mcp_settings.json"),
    },
  };
}

async function start(loaded: LoadedSettings): Promise<McpManager> {
  const manager = await McpManager.start({ workspace, settings: loaded });
  managers.push(manager);
  return manager;
}

describe("McpManager against a real stdio server", () => {
  it("discovers tools and bridges them with namespaced names", async () => {
    const manager = await start(settings());
    const [status] = manager.statuses();
    expect(status!.state).toBe("connected");
    expect(status!.tools).toEqual([
      "testsrv__echo",
      "testsrv__peek",
      "testsrv__screenshot",
      "testsrv__touch_file",
    ]);
    expect(manager.tools().map((t) => t.name)).toEqual(status!.tools);
  });

  it("classifies conservatively unless the server sends readOnlyHint (D-47b)", async () => {
    const manager = await start(settings());
    const byName = Object.fromEntries(manager.tools().map((t) => [t.name, t]));
    const echo = byName.testsrv__echo!;
    expect(echo.kind).toBe("command");
    expect(echo.mutates).toBe(true);
    const peek = byName.testsrv__peek!;
    expect(peek.kind).toBe("read");
    expect(peek.mutates).toBe(false);
    // The server's own schema is forwarded verbatim to the model.
    expect(echo.def.function.parameters).toMatchObject({ type: "object", required: ["text"] });
    expect(echo.def.function.description).toMatch(/^\[mcp:testsrv]/);
  });

  it("calls a tool and returns its text content", async () => {
    const manager = await start(settings());
    const echo = manager.tools().find((t) => t.name === "testsrv__echo")!;
    const result = await echo.execute({ text: "hi" }, { sandbox: new Sandbox([workspace]) });
    expect(result).toEqual({ content: "echo: hi" });
  });

  it("an erroring tool comes back as an error result, not a throw", async () => {
    const manager = await start(settings());
    const touch = manager.tools().find((t) => t.name === "testsrv__touch_file")!;
    const result = await touch.execute(
      { path: path.join(workspace, "nope", "deep", "x.txt") },
      { sandbox: new Sandbox([workspace]) },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/write failed/);
  });

  it("a server that dies is reported, never fatal — other servers still work", async () => {
    const loaded = settings();
    loaded.servers.push({
      name: "deadsrv",
      scope: "global",
      config: { command: process.execPath, args: [SERVER], env: { JLCODE_TEST_MCP_FAIL: "1" } },
    });
    const manager = await start(loaded);
    const byName = Object.fromEntries(manager.statuses().map((s) => [s.name, s]));
    expect(byName.testsrv!.state).toBe("connected");
    expect(byName.deadsrv!.state).toBe("failed");
    expect(byName.deadsrv!.error).toBeTruthy();
    expect(manager.tools().every((t) => t.name.startsWith("testsrv__"))).toBe(true);
  });

  it("a disabled server is listed but not started", async () => {
    const manager = await start(settings({ disabled: true }));
    expect(manager.statuses()[0]!.state).toBe("disabled");
    expect(manager.tools()).toEqual([]);
  });

  it("alwaysAllow marks a tool pre-approved — the gate stops prompting (D-47b)", async () => {
    const manager = await start(settings({ alwaysAllow: ["echo"] }));
    const byName = Object.fromEntries(manager.tools().map((t) => [t.name, t]));
    const echo = byName.testsrv__echo!;
    const touch = byName.testsrv__touch_file!;
    expect(echo.autoApprove).toBe(true);
    expect(touch.autoApprove).toBe(false);
    const manual = new ModeApprovalGate("code", "manual");
    expect(manual.check(echo, {})).toEqual({ kind: "allow" });
    expect(manual.check(touch, {})).toEqual({ kind: "prompt" });
    // Pre-approval never beats the mode gate or the read-only policy.
    expect(new ModeApprovalGate("ask", "manual").check(echo, {}).kind).toBe("deny");
    expect(new ModeApprovalGate("code", "read-only").check(echo, {}).kind).toBe("deny");
  });

  it("learned path fields persist to the file that owns the server (D-47d)", async () => {
    const manager = await start(settings({ pathFields: ["path"] }));
    const echo = manager.tools().find((t) => t.name === "testsrv__echo")!;
    // Before any answer: a slashy unknown field is fenced *and* flagged to ask.
    const before = echo.classifyPaths!({ path: "a/b.txt", note: "docs/readme" });
    expect(before.paths.map((p) => p.field)).toEqual(["path", "note"]);
    expect(before.unknown.map((u) => u.field)).toEqual(["note"]);

    echo.rememberPathField!("note", false);
    const after = echo.classifyPaths!({ path: "a/b.txt", note: "docs/readme" });
    expect(after.paths.map((p) => p.field)).toEqual(["path"]); // no longer fenced
    expect(after.unknown).toEqual([]); // and never asked again

    const written = JSON.parse(fs.readFileSync(path.join(configDir, "mcp_settings.json"), "utf8")) as {
      mcpServers: Record<string, { pathFields: string[]; notPathFields: string[] }>;
    };
    expect(written.mcpServers.testsrv!.notPathFields).toEqual(["note"]);
    expect(written.mcpServers.testsrv!.pathFields).toEqual(["path"]);
  });

  it("a workspace-scoped server writes its learned fields to the workspace file", async () => {
    const manager = await start(settings({}, "workspace"));
    const echo = manager.tools().find((t) => t.name === "testsrv__echo")!;
    echo.rememberPathField!("text", true);
    const file = path.join(workspace, ".jlcode", "mcp_settings.json");
    const written = JSON.parse(fs.readFileSync(file, "utf8")) as {
      mcpServers: Record<string, { pathFields: string[] }>;
    };
    expect(written.mcpServers.testsrv!.pathFields).toEqual(["text"]);
    expect(fs.existsSync(path.join(configDir, "mcp_settings.json"))).toBe(false);
  });
});

describe("bridge helpers", () => {
  it("namespaces and sanitizes tool names into the model-facing charset", () => {
    expect(bridgedToolName("file_utils", "read_file_range")).toBe("file_utils__read_file_range");
    expect(bridgedToolName("my server!", "do.thing")).toBe("my_server___do_thing");
    expect(bridgedToolName("s".repeat(40), "t".repeat(40))).toHaveLength(64);
  });

  it("renders text, falls back to structured content, and names non-image blocks", async () => {
    expect((await renderMcpContent({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).content).toBe(
      "a\nb",
    );
    expect((await renderMcpContent({ content: [], structuredContent: { ok: 1 } })).content).toBe('{"ok":1}');
    expect((await renderMcpContent({ content: [{ type: "audio", data: "AAAA", mimeType: "audio/wav" }] })).content).toMatch(
      /\[audio audio\/wav, ~3 bytes/,
    );
    expect(
      (await renderMcpContent({ content: [{ type: "resource", resource: { uri: "file:///x", text: "body" } }] })).content,
    ).toBe("file:///x:\nbody");
  });
});
