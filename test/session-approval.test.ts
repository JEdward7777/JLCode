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

  // X-23: the pause is where you decide, so what the write *does* has to be on
  // it. The tool computes the preview; this is the wiring that carries it.
  it("carries a file preview on the pause, so the write is readable before it runs", async () => {
    fs.writeFileSync(path.join(root, "over.txt"), "one\ntwo\n");
    const s = session(callThenAnswer("write_file", { path: "over.txt", content: "one\nTWO\n" }));
    await s.send("rewrite over.txt");
    const preview = s.awaitingApproval?.preview;
    expect(preview?.kind).toBe("diff");
    expect(preview?.kind === "diff" && preview.files[0]!.patch).toContain("+TWO");

    const fresh = session(callThenAnswer("write_file", { path: "brand-new.txt", content: "hello\n" }));
    await fresh.send("write brand-new.txt");
    const created = fresh.awaitingApproval?.preview;
    expect(created?.kind).toBe("file");
    expect(created?.kind === "file" && created.action).toBe("create");
    expect(created?.kind === "file" && created.body).toBe("hello");
  });

  it("carries a preview of what a delete would destroy (X-23)", async () => {
    fs.writeFileSync(path.join(root, "doomed.txt"), "line one\nline two\n");
    const s = session(callThenAnswer("delete_file", { path: "doomed.txt" }));
    await s.send("delete doomed.txt");
    const preview = s.awaitingApproval?.preview;
    expect(preview?.kind).toBe("file");
    expect(preview?.kind === "file" && preview.action).toBe("delete");
    expect(preview?.kind === "file" && preview.body).toContain("line one");
    expect(preview?.kind === "file" && preview.bytes).toBe(18);
    expect(fs.existsSync(path.join(root, "doomed.txt"))).toBe(true);
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

  it("appends a note typed with the decision, after the tool result (D-51)", async () => {
    const s = session(callThenAnswer("write_file", { path: "d.txt", content: "x" }));
    await s.send("write d.txt");
    await s.approve({ approve: true, note: "  and then run the tests  " });
    const kinds = s.conversation.entries.map((e) => e.type);
    expect(kinds).toEqual(["user", "assistant", "tool", "user", "assistant"]);
    const note = s.conversation.entries[3]!;
    expect(note.type === "user" && note.text).toBe("and then run the tests"); // trimmed
  });

  it("appends the note on a deny too (D-51)", async () => {
    const s = session(callThenAnswer("write_file", { path: "e.txt", content: "x" }));
    await s.send("write e.txt");
    await s.approve({ approve: false, note: "use f.txt instead" });
    const note = s.conversation.entries.find((e, i) => i > 0 && e.type === "user");
    expect(note && note.type === "user" && note.text).toBe("use f.txt instead");
    expect(s.conversation.entries.map((e) => e.type).indexOf("tool")).toBeLessThan(
      s.conversation.entries.findIndex((e, i) => i > 0 && e.type === "user"),
    );
  });

  it("holds the note until the whole tool batch drains (D-51)", async () => {
    // Two calls in one assistant message: a user turn wedged between their
    // results would be malformed on the wire, so the note waits for both.
    let n = 0;
    const driver: LlmDriver = {
      async *streamChat(): AsyncGenerator<StreamEvent> {
        n++;
        if (n === 1) {
          yield { type: "tool_call", index: 0, id: "c1", name: "write_file", argsDelta: JSON.stringify({ path: "g1.txt", content: "1" }) };
          yield { type: "tool_call", index: 1, id: "c2", name: "write_file", argsDelta: JSON.stringify({ path: "g2.txt", content: "2" }) };
          yield { type: "finish", reason: "tool_calls" };
        } else {
          yield { type: "text", delta: "done" };
          yield { type: "finish", reason: "stop" };
        }
      },
    };
    const s = session(driver);
    await s.send("write two files");
    await s.approve({ approve: true, note: "note after both" }); // first call
    expect(s.status).toBe("awaiting-approval"); // second call still pending
    expect(s.conversation.entries.some((e, i) => i > 0 && e.type === "user")).toBe(false);
    await s.approve({ approve: true });
    expect(s.conversation.entries.map((e) => e.type)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "user",
      "assistant",
    ]);
  });
});

describe("ask_user flow (D-18)", () => {
  it("pauses for input, then resumes with the answer", async () => {
    const s = session(callThenAnswer("ask_user", { question: "Which color?", options: ["red", "blue"] }));
    await s.send("pick a color");
    expect(s.status).toBe("awaiting-input");
    expect(s.awaitingInput?.questions[0]?.question).toBe("Which color?");
    expect(s.awaitingInput?.questions[0]?.options).toEqual(["red", "blue"]);

    await s.answer("blue");
    expect(s.status).toBe("idle");
    const toolEntry = s.conversation.entries.find((e) => e.type === "tool");
    expect(toolEntry && toolEntry.type === "tool" && toolEntry.content).toBe("blue");
  });

  it("parses a multi-question form and formats the answers as a labeled block", async () => {
    const s = session(
      callThenAnswer("ask_user", {
        questions: [
          { header: "Store", question: "Which store?", options: ["sqlite", "postgres"] },
          { header: "Env", question: "Which envs?", options: ["dev", "prod"], multiSelect: true },
        ],
      }),
    );
    await s.send("configure");
    expect(s.awaitingInput?.questions).toHaveLength(2);
    expect(s.awaitingInput?.questions[1]?.multiSelect).toBe(true);

    await s.answer([
      { header: "Store", question: "Which store?", answer: "postgres", chosen: ["postgres"] },
      { header: "Env", question: "Which envs?", answer: "dev, prod", chosen: ["dev", "prod"] },
    ]);
    const toolEntry = s.conversation.entries.find((e) => e.type === "tool");
    const content = toolEntry && toolEntry.type === "tool" ? toolEntry.content : "";
    expect(content).toContain(`Store — Which store?: chose "postgres"`);
    expect(content).toContain(`Env — Which envs?: chose "dev", "prod"`);
  });
});

/**
 * D-72 — the escape hatch. A person answering a question must always be able to
 * say something the model didn't offer, and to say nothing at all; and the tool
 * result has to keep those apart from a picked option, or the model proceeds on
 * "the closest wrong answer" with full confidence.
 */
describe("ask_user escape hatch (D-72)", () => {
  const result = (s: ReturnType<typeof session>): string => {
    const e = s.conversation.entries.find((x) => x.type === "tool");
    return e && e.type === "tool" ? e.content : "";
  };

  it("keeps a plain single answer verbatim — D-18's contract is untouched", async () => {
    const s = session(callThenAnswer("ask_user", { question: "Which color?", options: ["red", "blue"] }));
    await s.send("pick");
    await s.answer([{ question: "Which color?", answer: "blue", chosen: ["blue"] }]);
    expect(result(s)).toBe("blue");
  });

  it("says so when the user typed instead of picking one of the options", async () => {
    const s = session(callThenAnswer("ask_user", { question: "Which color?", options: ["red", "blue"] }));
    await s.send("pick");
    await s.answer([{ question: "Which color?", answer: "teal", typed: "teal" }]);
    const out = result(s);
    expect(out).toContain("picked none of the offered options and typed: teal");
    // The distinction is the whole point: this must not read as "they said teal
    // is one of your options".
    expect(out).not.toBe("teal");
  });

  it("passes free text through bare when no options were offered", async () => {
    const s = session(callThenAnswer("ask_user", { question: "What's the ticket?" }));
    await s.send("ask");
    await s.answer([{ question: "What's the ticket?", answer: "JL-411", typed: "JL-411" }]);
    expect(result(s)).toBe("JL-411");
  });

  it("reports a decline as a decline, with the instruction not to substitute an option", async () => {
    const s = session(callThenAnswer("ask_user", { question: "Which color?", options: ["red", "blue"] }));
    await s.send("pick");
    await s.answer([{ question: "Which color?", answer: "", declined: true }]);
    const out = result(s);
    expect(out).toContain("The user declined to answer:");
    expect(out).toContain("declined — the user did not answer this");
    expect(out).toContain("Do not substitute the closest one");
    expect(out).not.toBe("");
  });

  it("treats a blank answer as a decline even without the flag", async () => {
    const s = session(callThenAnswer("ask_user", { question: "Which color?", options: ["red", "blue"] }));
    await s.send("pick");
    await s.answer([{ question: "Which color?", answer: "" }]);
    // No `declined` flag and no chosen/typed — an empty string handed to the
    // model reads as an answer, so it is rendered as the decline it is.
    expect(result(s)).toContain("The user declined to answer:");
  });

  it("mixes: a partly answered form keeps each question's shape and warns once", async () => {
    const s = session(
      callThenAnswer("ask_user", {
        questions: [
          { header: "Store", question: "Which store?", options: ["sqlite", "postgres"] },
          { header: "Env", question: "Which envs?", options: ["dev", "prod"], multiSelect: true },
          { header: "Notes", question: "Anything else?" },
        ],
      }),
    );
    await s.send("configure");
    await s.answer([
      { header: "Store", question: "Which store?", answer: "", declined: true },
      { header: "Env", question: "Which envs?", answer: "dev, staging", chosen: ["dev"], typed: "staging" },
      { header: "Notes", question: "Anything else?", answer: "go slow", typed: "go slow" },
    ]);
    const out = result(s);
    expect(out).toContain("The user answered:");
    expect(out).toContain("Store — Which store?: declined");
    expect(out).toContain(`Env — Which envs?: chose "dev", and also typed: staging`);
    expect(out).toContain("Notes — Anything else?: go slow");
    // Once, not per declined question.
    expect(out.match(/Do not substitute the closest one/g)).toHaveLength(1);
  });

  it("says outright when the whole form was skipped", async () => {
    const s = session(
      callThenAnswer("ask_user", {
        questions: [
          { question: "Which store?", options: ["sqlite", "postgres"] },
          { question: "Which envs?", options: ["dev", "prod"] },
        ],
      }),
    );
    await s.send("configure");
    await s.answer([
      { question: "Which store?", answer: "", declined: true },
      { question: "Which envs?", answer: "", declined: true },
    ]);
    expect(result(s)).toContain("The user declined to answer any of these questions:");
  });

  it("`required` refuses a blank — and the pause survives the refusal", async () => {
    const s = session(callThenAnswer("ask_user", { question: "Which ticket?", required: true }));
    await s.send("ask");
    expect(s.awaitingInput?.questions[0]?.required).toBe(true);
    await expect(s.answer([{ question: "Which ticket?", answer: "", declined: true }])).rejects.toThrow(
      /requires an answer/,
    );
    // Still askable — a rejected answer must not consume the question.
    expect(s.status).toBe("awaiting-input");
    expect(s.awaitingInput?.questions[0]?.question).toBe("Which ticket?");
    await s.answer([{ question: "Which ticket?", answer: "JL-411", typed: "JL-411" }]);
    expect(s.status).toBe("idle");
    expect(result(s)).toBe("JL-411");
  });

  it("`required` never forces one of the options — typing satisfies it", async () => {
    const s = session(
      callThenAnswer("ask_user", { question: "Which color?", options: ["red", "blue"], required: true }),
    );
    await s.send("pick");
    await s.answer([{ question: "Which color?", answer: "teal", typed: "teal" }]);
    expect(s.status).toBe("idle");
    expect(result(s)).toContain("picked none of the offered options and typed: teal");
  });

  it("no longer advertises allowFreeText — typing is not the model's to withhold", () => {
    const params = askUserTool().def.function.parameters as Record<string, any>;
    const item = params.properties.questions.items.properties;
    expect(item.allowFreeText).toBeUndefined();
    expect(item.required).toBeDefined();
    expect(askUserTool().def.function.description).toMatch(/can always type an answer/);
  });
});

describe("live mode/approval switch (D-07/D-08)", () => {
  it("re-gates the session and emits a mode event", async () => {
    const events: string[] = [];
    // Re-issues the write on every user turn (so both sends attempt it), then
    // answers once the tool result comes back.
    const rewriteEachTurn: LlmDriver = {
      async *streamChat(req): AsyncGenerator<StreamEvent> {
        const last = req.messages[req.messages.length - 1];
        if (last?.role === "user") {
          yield {
            type: "tool_call",
            index: 0,
            id: `c${req.messages.length}`,
            name: "write_file",
            argsDelta: JSON.stringify({ path: "m.txt", content: "x" }),
          };
          yield { type: "finish", reason: "tool_calls" };
        } else {
          yield { type: "text", delta: "All set." };
          yield { type: "finish", reason: "stop" };
        }
      },
    };
    const s = new Session({
      config,
      driver: rewriteEachTurn,
      tools: new ToolRegistry([...fileTools(), askUserTool()]),
      sandbox: new Sandbox([root]),
      mode: "ask",
      approval: "manual",
      buildGate: (mode, approval) => new ModeApprovalGate(mode, approval),
    });
    s.onEvent((e) => {
      if (e.type === "mode") events.push(`${e.mode}/${e.approval}`);
    });
    expect(s.mode).toBe("ask");

    // In Ask mode a write is denied inline (no pause).
    await s.send("write in ask mode");
    expect(s.status).toBe("idle");
    expect(fs.existsSync(path.join(root, "m.txt"))).toBe(false);

    // Switch to Code/manual → the same write now pauses for approval.
    s.setModeApproval("code", "manual");
    expect(events).toEqual(["code/manual"]);
    await s.send("write in code mode");
    expect(s.status).toBe("awaiting-approval");
    await s.approve({ approve: true });
    expect(fs.readFileSync(path.join(root, "m.txt"), "utf8")).toBe("x");
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
