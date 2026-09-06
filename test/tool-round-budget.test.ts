/**
 * The tool-round budget and its pause (D-79).
 *
 * The bug this replaces: `runLoop` counted iterations in a `for` and, on
 * exhausting them, fell out of the bottom into the same code as a finished
 * answer — status `idle`, no event, no journal line, and the last batch of tool
 * calls left un-run and then discarded by the next `send`. On screen that looked
 * exactly like the agent choosing to stop, and the dropped call is how work gets
 * missed: the model believes it ran.
 */
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
import type { AssistantEntry, Entry } from "../src/conversation/types";

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

/** Calls a tool every turn, for `rounds` turns, then answers. A model that will
 *  not stop on its own is the only thing the budget is there for. */
function toolLoopDriver(rounds: number, tool = "read_file", args: unknown = { path: "a.txt" }): LlmDriver {
  let calls = 0;
  return {
    async *streamChat(): AsyncGenerator<StreamEvent> {
      calls++;
      if (calls <= rounds) {
        yield { type: "tool_call", index: 0, id: `call_${calls}`, name: tool, argsDelta: JSON.stringify(args) };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text", delta: "Done." };
        yield { type: "finish", reason: "stop" };
      }
    },
  };
}

/** Every tool call on the branch got a result — the invariant the old cap broke. */
function orphanedCalls(entries: Entry[]): string[] {
  const answered = new Set(entries.filter((e) => e.type === "tool").map((e) => e.toolCallId));
  return entries
    .filter((e): e is AssistantEntry => e.type === "assistant")
    .flatMap((e) => e.toolCalls ?? [])
    .map((c) => c.id)
    .filter((id) => !answered.has(id));
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-budget-"));
  fs.writeFileSync(path.join(root, "a.txt"), "content");
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function makeSession(driver: LlmDriver, maxToolIterations = 3): { session: Session; events: SessionEvent[] } {
  const session = new Session({
    config,
    driver,
    maxToolIterations,
    tools: new ToolRegistry(fileTools()),
    sandbox: new Sandbox([root]),
  });
  const events: SessionEvent[] = [];
  session.onEvent((e) => events.push(e));
  return { session, events };
}

describe("tool-round budget (D-79)", () => {
  it("pauses on awaiting-continue instead of ending the turn silently", async () => {
    const { session, events } = makeSession(toolLoopDriver(99), 3);
    await session.send("go");

    expect(session.status).toBe("awaiting-continue");
    const pause = events.find((e) => e.type === "awaiting-continue");
    expect(pause).toBeDefined();
    expect(session.awaitingContinue).toMatchObject({ rounds: 3, budget: 3, nextBudget: 6 });
  });

  it("leaves no tool call without a result — the pause sits before the next model call", async () => {
    const { session } = makeSession(toolLoopDriver(99), 3);
    await session.send("go");

    expect(orphanedCalls(session.conversation.entries)).toEqual([]);
    // Three model turns, three tool calls, three results.
    expect(session.conversation.entries.filter((e) => e.type === "tool")).toHaveLength(3);
  });

  it("records the pause in the debug journal (D-15)", async () => {
    const { session, events } = makeSession(toolLoopDriver(99), 3);
    await session.send("go");

    const notes = events.filter((e) => e.type === "debug" && e.record.kind === "note");
    expect(notes).toHaveLength(1);
    const record = (notes[0] as { record: { kind: "note"; message: string } }).record;
    expect(record.message).toContain("3 model turns");
    expect(record.message).toContain("Continue → 6");
  });

  it("continueRun doubles the budget and finishes the same turn", async () => {
    // 5 tool rounds then an answer: budget 3 pauses, 6 finishes it.
    const { session } = makeSession(toolLoopDriver(5), 3);
    await session.send("go");
    expect(session.status).toBe("awaiting-continue");

    await session.continueRun();

    expect(session.status).toBe("idle");
    expect(orphanedCalls(session.conversation.entries)).toEqual([]);
    const last = session.conversation.entries.at(-1) as AssistantEntry;
    expect(last.text).toBe("Done.");
  });

  it("pauses again on the doubled budget rather than running away", async () => {
    const { session } = makeSession(toolLoopDriver(99), 2);
    await session.send("go");
    expect(session.awaitingContinue).toMatchObject({ rounds: 2, budget: 2, nextBudget: 4 });

    await session.continueRun();

    expect(session.status).toBe("awaiting-continue");
    expect(session.awaitingContinue).toMatchObject({ rounds: 4, budget: 4, nextBudget: 8 });
  });

  it("continueRun on a session that is not paused is an error, not a stray turn", async () => {
    const { session } = makeSession(toolLoopDriver(0), 3);
    await session.send("go");
    expect(session.status).toBe("idle");
    await expect(session.continueRun()).rejects.toThrow(/No pending continue/);
  });

  it("counts per user message, so a fresh send starts a fresh budget", async () => {
    const { session } = makeSession(toolLoopDriver(2), 3);
    await session.send("first"); // 2 tool rounds + the answer = 3 turns, just fits
    expect(session.status).toBe("idle");

    // A second message on the same session gets its own budget rather than
    // inheriting a spent one.
    await session.send("second");
    expect(session.status).toBe("idle");
    expect(orphanedCalls(session.conversation.entries)).toEqual([]);
  });
});

describe("tool-round budget across a mid-turn pause (D-79)", () => {
  /** Asks a question on turn 1, then loops on tools forever. */
  function askThenLoop(): LlmDriver {
    let calls = 0;
    return {
      async *streamChat(): AsyncGenerator<StreamEvent> {
        calls++;
        if (calls === 1) {
          yield {
            type: "tool_call",
            index: 0,
            id: "call_ask",
            name: "ask_user",
            argsDelta: JSON.stringify({ questions: [{ question: "which?" }] }),
          };
          yield { type: "finish", reason: "tool_calls" };
        } else {
          yield { type: "tool_call", index: 0, id: `call_${calls}`, name: "read_file", argsDelta: JSON.stringify({ path: "a.txt" }) };
          yield { type: "finish", reason: "tool_calls" };
        }
      },
    };
  }

  it("an ask_user answer resumes the same turn on the same budget", async () => {
    // The old counter restarted at zero on every resume, which is why the stop
    // landed at an unpredictable number of turns.
    const { session } = makeSession(askThenLoop(), 3);
    await session.send("go");
    expect(session.status).toBe("awaiting-input");

    await session.answer("this one");

    // Turn 1 (the question) counted, so only 2 rounds remain — not 3 more.
    expect(session.status).toBe("awaiting-continue");
    expect(session.awaitingContinue).toMatchObject({ rounds: 3, budget: 3 });
    expect(orphanedCalls(session.conversation.entries)).toEqual([]);
  });
});
