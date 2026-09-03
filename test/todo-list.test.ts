import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Session } from "../src/session/session";
import { Sandbox } from "../src/tools/sandbox";
import { ToolRegistry, defaultTools } from "../src/tools/registry";
import { todoTools, TODO_READ, TODO_WRITE } from "../src/tools/todo-tools";
import {
  foldTodos,
  planTodoSnapshot,
  planTodoWrite,
  renderTodoDiff,
  renderTodoList,
  todosOn,
  todoTip,
} from "../src/conversation/todos";
import { createServer } from "../src/server/server";
import { ConversationStore } from "../src/persist/conversation-store";
import type { LlmDriver, StreamEvent } from "../src/llm/types";
import type { ModelConfig } from "../src/config/types";
import type { SessionEvent } from "../src/session/types";
import type { TodoEntry } from "../src/conversation/types";

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

/** A driver that plays a scripted list of tool calls, one per turn, then answers. */
function scripted(calls: { name: string; args: unknown }[], answer = "Done."): LlmDriver {
  let turn = 0;
  return {
    async *streamChat(): AsyncGenerator<StreamEvent> {
      const call = calls[turn++];
      if (call) {
        yield { type: "tool_call", index: 0, id: `call_${turn}`, name: call.name, argsDelta: JSON.stringify(call.args) };
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-todo-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function makeSession(driver: LlmDriver): { session: Session; events: SessionEvent[] } {
  const session = new Session({
    config,
    driver,
    tools: new ToolRegistry(todoTools()),
    sandbox: new Sandbox([root]),
  });
  const events: SessionEvent[] = [];
  session.onEvent((e) => events.push(e));
  return { session, events };
}

/** The last tool result the model was handed. */
function lastToolResult(session: Session): { content: string; isError: boolean } {
  const entry = [...session.conversation.entries].reverse().find((e) => e.type === "tool");
  if (!entry || entry.type !== "tool") throw new Error("no tool entry");
  return { content: entry.content, isError: entry.isError ?? false };
}

describe("todo fold + operations (X-31)", () => {
  it("folds add / mark / set in order", () => {
    const items = foldTodos([
      { op: "add", items: [{ id: "a", text: "one" }, { id: "b", text: "two" }] },
      { op: "mark", ids: ["a"], done: true },
      { op: "add", items: [{ id: "c", text: "three" }] },
    ]);
    expect(items).toEqual([
      { id: "a", text: "one", done: true },
      { id: "b", text: "two", done: false },
      { id: "c", text: "three", done: false },
    ]);
    // A `set` snapshot replaces wholesale — that is what leaving edit mode means.
    expect(foldTodos([{ op: "add", items: [{ id: "a", text: "one" }] }, { op: "set", items: [] }])).toEqual([]);
  });

  it("strikes by exact text or by id, never by position", () => {
    const items = [
      { id: "t1", text: "write the fold", done: false },
      { id: "t2", text: "write the tools", done: false },
    ];
    const byText = planTodoWrite(items, { strike: ["write the fold"] });
    expect(byText.ok && byText.items[0]!.done).toBe(true);
    expect(byText.ok && byText.items[1]!.done).toBe(false);
    const byId = planTodoWrite(items, { strike: ["t2"] });
    expect(byId.ok && byId.items[1]!.done).toBe(true);
  });

  it("fails loudly on a miss, with the current list attached, and applies nothing", () => {
    const items = [{ id: "t1", text: "write the fold", done: false }];
    const plan = planTodoWrite(items, { add: ["a new one"], strike: ["write the folds"] });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toContain("no item matches");
    expect(plan.error).toContain("t1"); // the id is in the attached list
    expect(plan.error).toContain("write the fold");
    // Atomic: the good half of the batch did not sneak through.
    expect(items).toHaveLength(1);
  });

  it("refuses a near miss rather than striking the neighbour", () => {
    const items = [
      { id: "t1", text: "add the peek", done: false },
      { id: "t2", text: "add the peeks", done: false },
    ];
    const plan = planTodoWrite(items, { strike: ["add the pee"] });
    expect(plan.ok).toBe(false);
    expect(items.every((i) => !i.done)).toBe(true);
  });

  it("points at the ids when two items read alike", () => {
    // Only a person's snapshot can create this; the ids are the way out of it.
    const items = [
      { id: "t1", text: "same", done: false },
      { id: "t2", text: "same", done: false },
    ];
    const plan = planTodoWrite(items, { strike: ["same"] });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toContain("t1");
    expect(plan.error).toContain("t2");
    expect(planTodoWrite(items, { strike: ["t2"] }).ok).toBe(true);
  });

  it("folds an edit: rewording, noting, and clearing a note", () => {
    const items = foldTodos([
      { op: "add", items: [{ id: "a", text: "regenerate fixtures (~2 calls)" }, { id: "b", text: "two" }] },
      { op: "edit", edits: [{ id: "a", text: "regenerate fixtures (~5 calls)" }] },
      { op: "edit", edits: [{ id: "a", note: "done — commit 6173b82" }] },
      { op: "edit", edits: [{ id: "b", note: "gone" }, { id: "b", note: "" }] },
    ]);
    expect(items[0]).toEqual({ id: "a", text: "regenerate fixtures (~5 calls)", done: false, note: "done — commit 6173b82" });
    // An empty note clears it rather than storing "", and an absent field leaves
    // the other alone — the two fields have different authors.
    expect(items[1]).toEqual({ id: "b", text: "two", done: false });
  });

  it("rewords and notes in one atomic call, and reports what it touched", () => {
    const items = [
      { id: "t1", text: "regenerate fixtures (~2 calls)", done: false },
      { id: "t2", text: "write the tools", done: false },
    ];
    const plan = planTodoWrite(items, {
      edit: [
        { item: "regenerate fixtures (~2 calls)", text: "regenerate fixtures (~5 calls)" },
        { item: "t2", note: "done — commit 6173b82" },
      ],
      strike: ["t2"],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.items[0]!.text).toBe("regenerate fixtures (~5 calls)");
    expect(plan.items[1]).toEqual({ id: "t2", text: "write the tools", done: true, note: "done — commit 6173b82" });
    expect(plan.changed.sort()).toEqual(["t1", "t2"]);
  });

  it("refuses an edit that would duplicate another item, or that asks for nothing", () => {
    const items = [
      { id: "t1", text: "one", done: false },
      { id: "t2", text: "two", done: false },
    ];
    expect(planTodoWrite(items, { edit: [{ item: "t1", text: "two" }] }).ok).toBe(false);
    expect(planTodoWrite(items, { edit: [{ item: "t1", text: "  " }] }).ok).toBe(false);
    expect(planTodoWrite(items, { edit: [{ item: "t1" }] }).ok).toBe(false);
    const missed = planTodoWrite(items, { add: ["three"], edit: [{ item: "nope", note: "x" }] });
    expect(missed.ok).toBe(false);
    if (missed.ok) return;
    expect(missed.error).toContain("no item matches");
    expect(missed.error).toContain("one"); // the current list rides along
  });

  it("rejects a duplicate add, which would make strike-by-text ambiguous", () => {
    const items = [{ id: "t1", text: "one", done: false }];
    expect(planTodoWrite(items, { add: ["one"] }).ok).toBe(false);
    expect(planTodoWrite(items, { add: ["two", "two"] }).ok).toBe(false);
  });

  it("rejects an empty call rather than pretending to work", () => {
    expect(planTodoWrite([], {}).ok).toBe(false);
  });

  it("renders every item with its id and a census", () => {
    const text = renderTodoList([
      { id: "t1", text: "one", done: true },
      { id: "t2", text: "two", done: false },
    ]);
    expect(text).toContain("1 of 2 items still undone");
    expect(text).toContain("[x] t1  one");
    expect(text).toContain("[ ] t2  two");
    expect(renderTodoList([])).toBe("The todo list is empty.");
  });

  it("hangs a note under its item, and marks the rows a call changed", () => {
    const items = [
      { id: "t1", text: "one", done: true, note: "done — commit 6173b82" },
      { id: "t2", text: "two", done: false },
    ];
    const plain = renderTodoList(items);
    expect(plain).toContain("[x] t1  one");
    expect(plain).toContain("↳ done — commit 6173b82");
    expect(plain).not.toContain("→"); // no gutter when nothing is being marked
    const marked = renderTodoList(items, ["t2"]);
    expect(marked).toContain("→ marks what this call changed");
    expect(marked).toContain("→ [ ] t2  two");
    expect(marked).toContain("  [x] t1  one");
  });

  it("says what changed across a person's edit, and caps a flood", () => {
    const before = [
      { id: "t1", text: "read the harness", done: false },
      { id: "t2", text: "wire it up", done: false },
      { id: "t3", text: "delete me", done: false },
    ];
    const after = [
      { id: "t1", text: "read the harness", done: true },
      { id: "t2", text: "wire the renderer", done: false },
      { id: "t7", text: "check the favicon slice", done: false },
    ];
    expect(renderTodoDiff(before, after)).toEqual([
      "x t1  read the harness",
      "~ t2  wire the renderer (was: wire it up)",
      "+ t7  check the favicon slice",
      "- t3  delete me",
    ]);
    // A note appearing on an otherwise unchanged item is itself the change.
    expect(renderTodoDiff(before, [{ ...before[0]!, note: "n" }, before[1]!, before[2]!])[0]).toBe(
      "~ t1  read the harness (note: n)",
    );
    // Re-ordering alone touches no item — the caller says so in its own words.
    expect(renderTodoDiff(before, [before[2]!, before[1]!, before[0]!])).toEqual([]);
    const flood = Array.from({ length: 20 }, (_, n) => ({ id: `x${n}`, text: `item ${n}`, done: false }));
    const capped = renderTodoDiff([], flood, 5);
    expect(capped).toHaveLength(6);
    expect(capped[5]).toBe("…and 15 more changes.");
  });

  it("keeps ids across a person's edit, and reports no-change as no-change", () => {
    const current = [
      { id: "t1", text: "one", done: false },
      { id: "t2", text: "two", done: false },
    ];
    expect(planTodoSnapshot(current, current)).toBeNull(); // opened the editor, changed nothing
    const op = planTodoSnapshot(current, [
      { id: "t2", text: "two", done: true },
      { id: "t1", text: "one reworded", done: false },
      { text: "typed by hand" },
    ]);
    expect(op).not.toBeNull();
    const items = foldTodos([op!]);
    expect(items.map((i) => i.id).slice(0, 2)).toEqual(["t2", "t1"]); // re-ordered, ids intact
    expect(items[1]!.text).toBe("one reworded"); // reworded, id intact
    expect(items[2]!.id).toMatch(/^td_/); // a new row gets a fresh id
    // An emptied row is a deletion, not a blank item.
    expect(foldTodos([planTodoSnapshot(current, [{ id: "t1", text: "  " }, { id: "t2", text: "two" }])!])).toHaveLength(1);
  });

  it("keeps the agent's notes through a person's save unless they clear them", () => {
    const current = [
      { id: "t1", text: "one", done: true, note: "done — commit 6173b82" },
      { id: "t2", text: "two", done: false, note: "blocked on the fence" },
    ];
    // A client that knows nothing about notes sends none — and erases none.
    expect(planTodoSnapshot(current, [{ id: "t1", text: "one", done: true }, { id: "t2", text: "two" }])).toBeNull();
    const op = planTodoSnapshot(current, [
      { id: "t1", text: "one", done: true, note: "" }, // emptied in the editor → cleared
      { id: "t2", text: "two reworded", done: false, note: "still blocked" },
    ]);
    const items = foldTodos([op!]);
    expect(items[0]).toEqual({ id: "t1", text: "one", done: true });
    expect(items[1]).toEqual({ id: "t2", text: "two reworded", done: false, note: "still blocked" });
  });
});

describe("the read barrier (X-31)", () => {
  it("refuses the first write, hands back the list, and lets the retry through", async () => {
    const { session } = makeSession(
      scripted([
        { name: TODO_WRITE, args: { add: ["fold the ops"] } },
        { name: TODO_WRITE, args: { add: ["fold the ops"] } },
      ]),
    );
    await session.send("go");
    const results = session.conversation.entries.filter((e) => e.type === "tool");
    expect(results).toHaveLength(2);
    expect(results[0]!.isError).toBe(true);
    expect(results[0]!.content).toContain("read the todo list before writing");
    // …and the refusal *was* the look, so the identical retry lands.
    expect(results[1]!.isError ?? false).toBe(false);
    expect(session.todos.map((t) => t.text)).toEqual(["fold the ops"]);
  });

  it("re-arms after the person edits, so a stale write cannot land blind", async () => {
    const { session } = makeSession(
      scripted([
        { name: TODO_READ, args: {} },
        { name: TODO_WRITE, args: { add: ["one"] } },
        { name: TODO_WRITE, args: { add: ["two"] } },
      ]),
    );
    await session.send("go");
    expect(session.todos.map((t) => t.text)).toEqual(["one", "two"]);

    // The person edits between turns; the agent's next write is refused once.
    await session.setTodos([...session.todos, { text: "and mine" }]);
    const refused = await runWrite(session, { add: ["three"] });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("changed since you last read it");
    expect(refused.content).toContain("and mine");
    const accepted = await runWrite(session, { add: ["three"] });
    expect(accepted.isError).toBe(false);
    expect(session.todos.map((t) => t.text)).toEqual(["one", "two", "and mine", "three"]);
  });
});

/** Drive one `todo_write` through a real turn (the tool path, not a private call). */
async function runWrite(session: Session, args: unknown): Promise<{ content: string; isError: boolean }> {
  const driver = scripted([{ name: TODO_WRITE, args }]);
  (session as unknown as { driver: LlmDriver }).driver = driver;
  await session.send("more");
  return lastToolResult(session);
}

describe("todo state on the branch (X-31)", () => {
  it("records ops as tree entries and folds them per branch", async () => {
    const { session, events } = makeSession(
      scripted([
        { name: TODO_READ, args: {} },
        { name: TODO_WRITE, args: { add: ["one", "two"] } },
        { name: TODO_WRITE, args: { strike: ["one"] } },
      ]),
    );
    await session.send("go");
    const ops = session.conversation.entries.filter((e): e is TodoEntry => e.type === "todo");
    expect(ops).toHaveLength(2);
    expect(ops.every((e) => e.by === "agent")).toBe(true);
    expect(session.todos).toEqual([
      { id: expect.stringMatching(/^td_/), text: "one", done: true },
      { id: expect.stringMatching(/^td_/), text: "two", done: false },
    ]);
    // The panel is told each time, with the folded list.
    const announced = events.filter((e) => e.type === "todos");
    expect(announced).toHaveLength(2);
    expect(announced[1]!.type === "todos" && announced[1]!.items[0]!.done).toBe(true);
  });

  it("hands the write back as the whole list, with this call's rows marked", async () => {
    const { session } = makeSession(
      scripted([{ name: TODO_READ, args: {} }, { name: TODO_WRITE, args: { add: ["one", "two"] } }]),
    );
    await session.send("go");
    const ids = session.todos.map((t) => t.id);
    // No re-read in between: the agent's own write left it current, which is
    // what the guidance now says out loud (D-77).
    const result = await runWrite(session, { edit: [{ item: "one", note: "done — commit 6173b82" }], strike: ["one"] });
    expect(result.isError).toBe(false);
    expect(result.content).toContain(`→ [x] ${ids[0]}  one`);
    expect(result.content).toContain("↳ done — commit 6173b82");
    expect(result.content).toContain(`  [ ] ${ids[1]}  two`); // untouched, unmarked, still shown
  });

  it("rewinding shows the list as it stood there; the ops never replay to the model", async () => {
    const { session } = makeSession(
      scripted([
        { name: TODO_READ, args: {} },
        { name: TODO_WRITE, args: { add: ["one"] } },
        { name: TODO_WRITE, args: { add: ["two"] } },
      ]),
    );
    await session.send("go");
    const conv = session.conversation;
    const firstOp = conv.entries.find((e) => e.type === "todo")!;
    expect(todosOn(conv, firstOp.id).map((t) => t.text)).toEqual(["one"]);
    expect(todosOn(conv, conv.activeLeaf).map((t) => t.text)).toEqual(["one", "two"]);
    expect(todoTip(conv, firstOp.id)).toBe(firstOp.id);
    // The ops carry no wire message of their own — the tool results already told
    // the model what happened.
    const wire = JSON.stringify((session as unknown as { wire(): unknown[] }).wire());
    expect(wire).not.toContain('"todo"');
  });

  it("survives a resume: the log folds back to the same list", async () => {
    const { session } = makeSession(
      scripted([
        { name: TODO_READ, args: {} },
        { name: TODO_WRITE, args: { add: ["survive me"] } },
      ]),
    );
    await session.send("go");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-todo-store-"));
    try {
      const store = new ConversationStore(dir);
      await store.create({ id: session.conversation.id, workingDir: root });
      for (const entry of session.conversation.entries) await store.entry(session.conversation.id, entry);
      await store.flush();
      const loaded = store.load(session.conversation.id)!;
      expect(todosOn(loaded, loaded.activeLeaf).map((t) => t.text)).toEqual(["survive me"]);
      await store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the nudges (X-31)", () => {
  it("puts the usage instructions in the prompt only when the tools are there", () => {
    const withTools = new Session({ config, driver: scripted([]), tools: new ToolRegistry(defaultTools()), sandbox: new Sandbox([root]) });
    expect((withTools as unknown as { systemPrompt: string }).systemPrompt).toContain(TODO_WRITE);
    const without = new Session({ config, driver: scripted([]) });
    expect((without as unknown as { systemPrompt: string }).systemPrompt).not.toContain(TODO_WRITE);
  });

  it("states the count in the compaction summary, and the list outlives the cut", async () => {
    const { session } = makeSession(
      scripted([
        { name: TODO_READ, args: {} },
        { name: TODO_WRITE, args: { add: ["one", "two"] } },
        { name: TODO_WRITE, args: { strike: ["one"] } },
      ]),
    );
    await session.send("go");
    (session as unknown as { driver: LlmDriver }).driver = {
      async *streamChat(): AsyncGenerator<StreamEvent> {
        yield { type: "text", delta: "## Goal\nship X-31" };
        yield { type: "finish", reason: "stop" };
      },
    };
    expect(await session.compact()).toBe(true);
    const summary = session.conversation.entries.filter((e) => e.type === "compaction").pop()!;
    expect(summary.type === "compaction" && summary.summary).toContain("1 of 2 items still undone");
    expect(summary.type === "compaction" && summary.summary).toContain(TODO_READ);
    // Not restated in the summary — the ops are still on the branch above the cut.
    expect(summary.type === "compaction" && summary.summary).not.toContain("two");
    expect(session.todos).toHaveLength(2);
  });

  it("queues a message when the person edits — without opening a turn of its own", async () => {
    const { session, events } = makeSession(scripted([]));
    expect(await session.setTodos([{ text: "mine" }])).toBe(true);
    expect(session.status).toBe("idle"); // no model call was made on their behalf
    expect(session.queuedMessages).toHaveLength(1);
    expect(session.queuedMessages[0]!.text).toContain("1 of 1 item still undone");
    // The census *and* what changed (D-77) — the count alone left the agent to
    // re-read before it could tell whether the edit touched its work. The full
    // list is still a read away: this is a diff, not the payload.
    expect(session.queuedMessages[0]!.text).toContain("+ ");
    expect(session.queuedMessages[0]!.text).toContain("mine");
    expect(session.queuedMessages[0]!.text).toContain(TODO_READ);
    expect(events.some((e) => e.type === "todos")).toBe(true);
    // Nothing changed → nobody is told anything.
    expect(await session.setTodos(session.todos)).toBe(false);
    expect(session.queuedMessages).toHaveLength(1);
  });
});

describe("the todo list over HTTP (X-31)", () => {
  let storeDir: string;
  let store: ConversationStore;
  beforeEach(() => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-todo-srv-"));
    store = new ConversationStore(storeDir);
  });
  afterEach(async () => {
    await store.close();
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  function makeApp() {
    return createServer({
      resolveConfig: () => config,
      newSession: (c, conversation) =>
        new Session({
          config: c,
          driver: scripted([]),
          conversation,
          tools: new ToolRegistry(todoTools()),
          sandbox: new Sandbox([root]),
        }),
      store,
      workingDir: root,
      version: "0.0.0",
    }).app;
  }

  async function send(app: ReturnType<typeof makeApp>, url: string, method: string, body: unknown) {
    const res = await app.request(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  }

  it("ships the list on the state frame and takes the person's commit", async () => {
    const app = makeApp();
    const id = (await send(app, "/session", "POST", {})).json.sessionId as string;
    expect((await send(app, "/chat", "POST", { sessionId: id, text: "hi" })).json.todos).toEqual([]);

    const put = await send(app, `/session/${id}/todos`, "PUT", { items: [{ text: "from the browser" }, { text: "done one", done: true }] });
    expect(put.status).toBe(200);
    expect(put.json.changed).toBe(true);
    expect(put.json.todos).toEqual([
      { id: expect.stringMatching(/^td_/), text: "from the browser", done: false },
      { id: expect.stringMatching(/^td_/), text: "done one", done: true },
    ]);
    expect(put.json.queue).toHaveLength(1);

    // Committing the same list again changes nothing and queues nothing more.
    const again = await send(app, `/session/${id}/todos`, "PUT", { items: put.json.todos });
    expect(again.json.changed).toBe(false);
    expect(again.json.queue).toHaveLength(1);

    // A note the person types lands; a save that says nothing about notes keeps
    // the ones already there (D-77).
    const noted = await send(app, `/session/${id}/todos`, "PUT", {
      items: [{ ...put.json.todos[0], note: "done — by hand" }, put.json.todos[1]],
    });
    expect(noted.json.todos[0].note).toBe("done — by hand");
    const blind = await send(app, `/session/${id}/todos`, "PUT", {
      items: [{ id: noted.json.todos[0].id, text: "from the browser", done: false }, noted.json.todos[1]],
    });
    expect(blind.json.todos[0].note).toBe("done — by hand");

    // …and it is durable: the ops are in the conversation log.
    const conv = store.load(put.json.conversationId as string)!;
    expect(todosOn(conv, conv.activeLeaf).map((t) => t.text)).toEqual(["from the browser", "done one"]);
    expect(await send(app, `/session/${id}/todos`, "PUT", { items: "nope" })).toMatchObject({ status: 400 });
  });
});
