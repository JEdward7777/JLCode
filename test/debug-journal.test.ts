import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { DebugJournal } from "../src/persist/debug-journal";
import { Session } from "../src/session/session";
import { Sandbox } from "../src/tools/sandbox";
import { ToolRegistry } from "../src/tools/registry";
import { fileTools } from "../src/tools/file-tools";
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

/** First turn writes a file, later turns answer. */
function toolThenAnswer(): LlmDriver {
  let n = 0;
  return {
    async *streamChat(): AsyncGenerator<StreamEvent> {
      n++;
      if (n === 1) {
        yield { type: "reasoning", delta: "let me write it" };
        yield { type: "tool_call", index: 0, id: "c1", name: "write_file", argsDelta: JSON.stringify({ path: "a.txt", content: "hi" }) };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text", delta: "All done." };
        yield { type: "finish", reason: "stop" };
      }
    },
  };
}

let root: string;
let jdir: string;
let journal: DebugJournal;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-dj-ws-"));
  jdir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-dj-logs-"));
  journal = new DebugJournal(jdir);
});
afterEach(async () => {
  await journal.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(jdir, { recursive: true, force: true });
});

describe("DebugJournal", () => {
  it("records per-turn llm + tool detail from a session run", async () => {
    const session = new Session({
      config,
      driver: toolThenAnswer(),
      tools: new ToolRegistry(fileTools()),
      sandbox: new Sandbox([root]),
      gate: undefined, // AllowAllGate default → runs the tool
    });
    const convId = session.conversation.id;
    session.onEvent((e) => {
      if (e.type === "debug") void journal.record(convId, e.record);
    });

    await session.send("write a file");
    await journal.flush();

    const recs = journal.read(convId) as Array<Record<string, any>>;
    const llm = recs.filter((r) => r.kind === "llm");
    const tool = recs.filter((r) => r.kind === "tool");

    // Two model turns (tool_call turn + final answer), one tool execution.
    expect(llm.length).toBe(2);
    expect(tool.length).toBe(1);
    expect(tool[0]!.name).toBe("write_file");
    expect(tool[0]!.isError).toBe(false);
    expect(typeof tool[0]!.ms).toBe("number");
    expect(llm[0]!.reasoningPreview).toContain("let me write it");
    expect(llm[0]!.tools).toContain("write_file");
    expect(recs.every((r) => typeof r.ts === "string")).toBe(true);
  });

  it("links each record to the assistant turn that produced it (entryId, D-15)", async () => {
    const session = new Session({
      config,
      driver: toolThenAnswer(),
      tools: new ToolRegistry(fileTools()),
      sandbox: new Sandbox([root]),
    });
    const convId = session.conversation.id;
    session.onEvent((e) => {
      if (e.type === "debug") void journal.record(convId, e.record);
    });
    await session.send("write a file");
    await journal.flush();

    const recs = journal.read(convId) as Array<Record<string, any>>;
    const assistants = session.conversation.entries.filter((e) => e.type === "assistant");
    expect(assistants.length).toBe(2);
    const [toolTurn, finalTurn] = assistants;

    const llm = recs.filter((r) => r.kind === "llm");
    const tool = recs.filter((r) => r.kind === "tool");
    // The llm records carry the id of the assistant entry they created…
    expect(llm[0]!.entryId).toBe(toolTurn!.id);
    expect(llm[1]!.entryId).toBe(finalTurn!.id);
    // …and the tool record attributes to the assistant turn that issued the call.
    expect(tool[0]!.entryId).toBe(toolTurn!.id);
  });

  it("records the error on a failed turn", async () => {
    const failing: LlmDriver = {
      // eslint-disable-next-line require-yield
      async *streamChat(): AsyncGenerator<StreamEvent> {
        throw new Error("provider exploded");
      },
    };
    const session = new Session({ config, driver: failing, maxConsecutiveFailures: 5 });
    const convId = session.conversation.id;
    session.onEvent((e) => {
      if (e.type === "debug") void journal.record(convId, e.record);
    });
    await session.send("go");
    await journal.flush();
    const recs = journal.read(convId) as Array<Record<string, any>>;
    expect(recs[0]!.kind).toBe("llm");
    expect(recs[0]!.error).toContain("provider exploded");
  });
});
