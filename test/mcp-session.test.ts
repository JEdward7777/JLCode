/**
 * P7a/P7b Tier-1: MCP tools driven through a real `Session` — the same gate, the
 * same D-19 soft fence, the same approval pause as a native tool (D-47b/d) —
 * plus the learn-on-pause questions that settle JLCode's conservative guesses
 * (D-48). The MCP server is a real stdio child; the model is the fake driver.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Session } from "../src/session/session";
import { Sandbox } from "../src/tools/sandbox";
import { ToolRegistry, defaultTools } from "../src/tools/registry";
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
    tools: new ToolRegistry([...defaultTools(), ...mcp.tools()]),
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

  /**
   * H-08, found by P7c against the real `file_utils` server. The exploit fits in
   * one session: hand a server a root outside the fence (which *does* pause),
   * allow it once, and every later call reaches that root through a bare
   * relative name — no slash, so the bridge never classifies it as a path, so the
   * fence never evaluates it. Allow-once therefore promised something the fence
   * could not keep, and the fix is to stop offering it for a tool that can
   * remember what it is handed.
   */
  describe("an escaping path on an MCP server is never a one-shot grant (H-08)", () => {
    it("refuses a plain approve, and says why, without running the tool", async () => {
      const target = path.join(outside, "escaped.txt");
      const s = session(callThenAnswer("testsrv__touch_file", { path: target, body: "nope" }), "full-auto");
      await s.send("write outside");
      expect(s.status).toBe("awaiting-approval");
      expect(s.awaitingApproval?.outOfFence?.requiresRoot).toBe(true);

      await s.approve({ approve: true }); // the old allow-once answer
      expect(fs.existsSync(target)).toBe(false); // ← the file the old path would have written
      const tool = s.conversation.entries.filter((e) => e.type === "tool").at(-1);
      expect(tool && tool.type === "tool" && tool.content).toContain("cannot be allowed just once");
      expect(s.status).toBe("idle");
    });

    it("runs it when the user widens the fence on purpose", async () => {
      const target = path.join(outside, "escaped.txt");
      const s = session(callThenAnswer("testsrv__touch_file", { path: target, body: "yes" }), "full-auto");
      await s.send("write outside");
      await s.approve({ approve: true, addRoot: true });
      expect(fs.readFileSync(target, "utf8")).toBe("yes");
    });

    it("leaves allow-once alone for a native tool, whose paths JLCode resolves itself", async () => {
      const target = path.join(outside, "native.txt");
      const s = session(callThenAnswer("write_file", { path: target, content: "native" }), "full-auto");
      await s.send("write outside with a native tool");
      expect(s.status).toBe("awaiting-approval");
      expect(s.awaitingApproval?.outOfFence?.requiresRoot).toBeUndefined();

      await s.approve({ approve: true }); // still a meaningful one-shot
      expect(fs.readFileSync(target, "utf8")).toBe("native");
    });
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

  it("Ask mode asks about an unannotated MCP tool but allows a readOnlyHint one (D-47b/D-48)", async () => {
    // The block rests on JLCode's own guess that the tool writes, so instead of
    // denying outright the session stops and offers to settle it (D-48).
    const blocked = new Session({
      config,
      driver: callThenAnswer("testsrv__echo", { text: "hi" }),
      tools: new ToolRegistry([...mcp.tools()]),
      sandbox: new Sandbox([root]),
      gate: new ModeApprovalGate("ask", "manual"),
    });
    await blocked.send("try to echo");
    expect(blocked.status).toBe("awaiting-approval");
    expect(blocked.awaitingApproval?.learn?.askWrite).toBe(true);
    expect(blocked.awaitingApproval?.learn?.modeBlocked).toMatch(/Ask mode is read-only/);

    // Confirming that it does write leaves the mode wall exactly where it was.
    await blocked.approve({ approve: true, learned: { writes: true } });
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

  // ---- Learn-on-pause (D-48). JLCode guesses conservatively about MCP tools;
  // the guess is what makes it stop, so a pause that is happening anyway also
  // offers to settle it. It never stops *just* to ask.

  it("an out-of-fence pause offers the unclassified field, and a prose answer sticks", async () => {
    const note = path.join(outside, "secret.txt");
    const s = session(callThenAnswer("testsrv__echo", { text: "hi", note }), "full-auto");
    await s.send("echo with a mystery field");
    expect(s.status).toBe("awaiting-approval");
    const learn = s.awaitingApproval?.learn;
    expect(learn?.fields).toEqual([{ field: "note", value: note, escapes: true }]);
    // The escape reports which arg produced it, so the browser can drop it once
    // the user says it is prose.
    expect(s.awaitingApproval?.outOfFence?.fields).toEqual(["note"]);

    // Denied — but the answer is a fact about the tool, so it is kept anyway.
    await s.approve({ approve: false, learned: { fields: { note: false } } });
    expect(mcp.serverConfig("testsrv")?.notPathFields).toContain("note");
    const written = JSON.parse(fs.readFileSync(path.join(configDir, "mcp_settings.json"), "utf8"));
    expect(written.mcpServers.testsrv.notPathFields).toContain("note");

    // Same call again: `note` is prose now, so nothing is fenced and nothing asked.
    const again = session(callThenAnswer("testsrv__echo", { text: "hi", note }), "full-auto");
    await again.send("echo again");
    expect(again.status).toBe("idle");
  });

  it("answering \"it is a path\" keeps fencing it, without asking twice", async () => {
    const note = path.join(outside, "secret.txt");
    const first = session(callThenAnswer("testsrv__echo", { text: "hi", note }), "full-auto");
    await first.send("echo");
    await first.approve({ approve: false, learned: { fields: { note: true } } });
    expect(mcp.serverConfig("testsrv")?.pathFields).toContain("note");

    const again = session(callThenAnswer("testsrv__echo", { text: "hi", note }), "full-auto");
    await again.send("echo again");
    expect(again.status).toBe("awaiting-approval");
    expect(again.awaitingApproval?.reason).toBe("access outside the workspace");
    expect(again.awaitingApproval?.learn?.fields ?? []).toEqual([]); // asked once, not again
  });

  it("a manual-approval pause carries the write question, and the answer relaxes the tool", async () => {
    const s = session(callThenAnswer("testsrv__echo", { text: "hi" }), "manual");
    await s.send("echo");
    expect(s.status).toBe("awaiting-approval");
    expect(s.awaitingApproval?.kind).toBe("command"); // presumed to write (D-47b)
    expect(s.awaitingApproval?.learn?.askWrite).toBe(true);

    await s.approve({ approve: true, learned: { writes: false } });
    expect(mcp.serverConfig("testsrv")?.readTools).toContain("echo");

    // Now known read-only: no approval prompt at all the next time.
    const again = session(callThenAnswer("testsrv__echo", { text: "hi" }), "manual");
    await again.send("echo again");
    expect(again.status).toBe("idle");
    const out = again.conversation.entries.find((e) => e.type === "tool");
    expect(out && out.type === "tool" && out.content).toBe("echo: hi");
  });

  it("Ask mode's block is a question, and read-only unblocks the call (D-48)", async () => {
    const blocked = new Session({
      config,
      driver: callThenAnswer("testsrv__echo", { text: "hi" }),
      tools: new ToolRegistry([...mcp.tools()]),
      sandbox: new Sandbox([root]),
      gate: new ModeApprovalGate("ask", "manual"),
    });
    await blocked.send("echo in ask mode");
    expect(blocked.status).toBe("awaiting-approval");
    expect(blocked.awaitingApproval?.learn?.modeBlocked).toBeDefined();

    await blocked.approve({ approve: true, learned: { writes: false } });
    const out = blocked.conversation.entries.find((e) => e.type === "tool");
    expect(out && out.type === "tool" && out.content).toBe("echo: hi");
    expect(mcp.serverConfig("testsrv")?.readTools).toContain("echo");
  });

  it("never stops just to ask: a full-auto in-fence call runs unattended", async () => {
    // `path` is a known path field and lands inside the fence; the policy would
    // let the write through either way, so no question is worth the interruption.
    const target = path.join(root, "auto.txt");
    const s = session(callThenAnswer("testsrv__touch_file", { path: target, body: "x" }), "full-auto");
    await s.send("write inside the fence");
    expect(s.status).toBe("idle");
    expect(fs.readFileSync(target, "utf8")).toBe("x");
    expect(mcp.serverConfig("testsrv")?.readTools ?? []).not.toContain("touch_file");
    expect(mcp.serverConfig("testsrv")?.writeTools ?? []).not.toContain("touch_file");
  });

  it("a readOnlyHint tool is never asked about — the server already said so", async () => {
    const s = session(callThenAnswer("testsrv__peek", { target: "notes.md" }), "manual");
    await s.send("peek");
    expect(s.status).toBe("idle"); // read tools need no approval
    const peek = mcp.tools().find((t) => t.name === "testsrv__peek")!;
    expect(peek.writeUnknown?.()).toBe(false);
  });
});
