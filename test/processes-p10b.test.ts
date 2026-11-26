/**
 * Phase 10, slice P10b (D-104, D-105, D-106; plan reviews R1–R7): background
 * launch, stdin, kill and list through the file tools; the watchdog's
 * "background" answer; Stop sparing background processes, and "Stop and kill
 * processes".
 *
 *   - `run_command(background: true)` returns at once with the id and the exact
 *     calls; no watchdog; the per-call timeout still applies; a spawn failure
 *     ends the task "failed to start" (R6).
 *   - `write_file(process:)` appends exactly `content` (close = EOF), refuses an
 *     ended process, and survives EPIPE (G10). Its gate is its own rule, checked
 *     first, so `path`/`command` can't steer it (R1 must-fix 3, D-105d); the
 *     approval card reads as stdin to a process.
 *   - `delete_file(process:)` kills the tree in every mode with no approval (G9)
 *     and says how it ended.
 *   - `list_dir(processes: true)`: background only (G8), an ended process listed
 *     exactly once.
 *   - D-106: the watchdog backgrounds a stdin-waiting command, then
 *     `write_file(process:)` feeds it to completion (R3 must-fix 2: the test
 *     stops at the log).
 *   - Stop spares background processes; "Stop and kill processes" fans down the
 *     tree and each session decides by its own status (R4/R5); closing still
 *     kills (R1 must-fix 1).
 *
 * Real children where the lifecycle is the point. Commands are POSIX `sh`, so
 * those tests skip on win32; the gate and the tools' wording run everywhere.
 * Waits are on registry/session events; the few polls are on a log the child
 * writes, which has no event of its own.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Sandbox } from "../src/tools/sandbox";
import { TaskRegistry, formatDuration, type TaskEvent, type TaskView } from "../src/tools/task-registry";
import { ProcessStore } from "../src/tools/process-store";
import { runCommandTool, backgroundLaunchText } from "../src/tools/shell-tool";
import { fileTools } from "../src/tools/file-tools";
import { killTree, shellSpawnOptions } from "../src/tools/kill-tree";
import { ModeApprovalGate } from "../src/tools/mode-gate";
import { ToolRegistry } from "../src/tools/registry";
import { Session, parseWatchdogDecision } from "../src/session/session";
import { fakeAgentDriver } from "../src/session/fake";
import { createServer } from "../src/server/server";
import { createSessionFactory } from "../src/server/session-factory";
import { ConversationStore } from "../src/persist/conversation-store";
import { ModelCatalog } from "../src/llm/models";
import { loadConfig, saveConfig, defaultConfig } from "../src/config/store";
import { addModelConfig, setBinding, resolveForCwd } from "../src/config/operations";
import { resolvePaths, type JlcodePaths } from "../src/paths";
import type { Tool, ToolContext } from "../src/tools/types";
import type { ChatRequest, LlmDriver, StreamEvent } from "../src/llm/types";
import type { ApprovalPolicy, Mode, ModelConfig } from "../src/config/types";
import type { ApprovalRequest, SessionEvent } from "../src/session/types";
import type { SessionManager } from "../src/session/manager";

const posix = process.platform !== "win32";

let root: string; // the workspace
let data: string; // stands in for the data dir
let store: ProcessStore;
let tasks: TaskRegistry;
let ctx: ToolContext;
/** Process groups a test left behind on purpose (a daemon holding a pipe). */
const reap: number[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-p10b-ws-"));
  data = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-p10b-data-"));
  store = new ProcessStore(path.join(data, "processes"));
  tasks = new TaskRegistry({ dir: () => store.lease("cv_test"), graceMs: 200 });
  ctx = { sandbox: new Sandbox([root]), tasks };
});
afterEach(() => {
  tasks.dispose();
  for (const pid of reap.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  store.stop();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(data, { recursive: true, force: true });
});

const [readTool, writeTool, deleteTool, listTool] = fileTools();
const run = (args: Record<string, unknown>, c: ToolContext = ctx) => runCommandTool().execute(args, c);
const write = (args: Record<string, unknown>, c: ToolContext = ctx) => writeTool!.execute(args, c);
const del = (args: Record<string, unknown>, c: ToolContext = ctx) => deleteTool!.execute(args, c);
const list = (c: ToolContext = ctx) => listTool!.execute({ processes: true }, c);
const read = (args: Record<string, unknown>, c: ToolContext = ctx) => readTool!.execute(args, c);

const idOf = (text: string): string => /process (task_[0-9a-f]+)/.exec(text)![1]!;
const view = (id: string, reg: TaskRegistry = tasks): TaskView => reg.get(id)!;
const logOf = (id: string, reg: TaskRegistry = tasks): string => fs.readFileSync(reg.log(id)!.file, "utf8");

/** Wait for a task to finish — the registry's own event, never a clock. */
async function ended(id: string, reg: TaskRegistry = tasks): Promise<TaskView> {
  const v = await reg.whenEnded(id, 10_000);
  if (!v) throw new Error(`task ${id} did not end`);
  return v;
}

/** Poll a log for text (a child's output has no event of its own). */
async function logHas(id: string, text: string, reg: TaskRegistry = tasks, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!logOf(id, reg).includes(text)) {
    if (Date.now() - start > ms) throw new Error(`log never showed ${JSON.stringify(text)}: ${JSON.stringify(logOf(id, reg))}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const config: ModelConfig = {
  id: "cfg_x",
  name: "T",
  openRouterKey: "sk",
  model: "m",
  defaultMode: "code",
  defaultApproval: "full-auto",
  createdAt: "",
  updatedAt: "",
};

const toolCall = (name: string, args: unknown, id = `c_${Math.random().toString(16).slice(2)}`): StreamEvent[] => [
  { type: "tool_call", index: 0, id, name, argsDelta: JSON.stringify(args) },
  { type: "finish", reason: "tool_calls" },
];
const text = (t: string): StreamEvent[] => [
  { type: "text", delta: t },
  { type: "finish", reason: "stop" },
];
const lastContent = (req: ChatRequest): string => {
  const c = req.messages[req.messages.length - 1]?.content;
  return typeof c === "string" ? c : "";
};
/** Resolves with the text of the first process notice the session's
 *  transcript takes in (P10c), once the turn carrying it has settled. */
const noticeTurn = (s: Session): Promise<string> =>
  new Promise((resolve) => {
    let notice: string | undefined;
    s.onEvent((e) => {
      if (e.type === "user" && e.text.startsWith("[Background process")) notice ??= e.text;
      if (notice !== undefined && e.type === "settled") resolve(notice);
    });
  });
const toolResults = (s: Session) =>
  s.conversation.entries.filter((e) => e.type === "tool").map((e) => (e as { content: string }).content);

/** Sessions a test built; their processes are closed after it. */
const opened: Session[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.disposeProcesses();
});

function makeSession(opts: {
  driver: LlmDriver;
  mode?: Mode;
  approval?: ApprovalPolicy;
  allowlist?: string[];
  watchdogMs?: number;
  reg?: TaskRegistry;
}): { session: Session; approvals: ApprovalRequest[]; events: SessionEvent[] } {
  const session = new Session({
    config,
    driver: opts.driver,
    tools: new ToolRegistry([...fileTools(), runCommandTool()]),
    sandbox: new Sandbox([root]),
    processes: store,
    ...(opts.reg ? { tasks: opts.reg } : {}),
    ...(opts.watchdogMs !== undefined ? { watchdogMs: opts.watchdogMs } : {}),
    mode: opts.mode ?? "code",
    approval: opts.approval ?? "full-auto",
    buildGate: (m, a) => new ModeApprovalGate(m, a, opts.allowlist ?? []),
  });
  opened.push(session);
  const approvals: ApprovalRequest[] = [];
  const events: SessionEvent[] = [];
  session.onEvent((e) => {
    events.push(e);
    if (e.type === "awaiting-approval") approvals.push(e.request);
  });
  return { session, approvals, events };
}

// ---------------------------------------------------------------------------

describe("run_command(background: true) (D-104)", () => {
  it.skipIf(!posix)("returns at once with the id, the command and the exact read/write/kill calls", async () => {
    const t0 = Date.now();
    const res = await run({ command: "sleep 30", background: true });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(res.isError).toBeFalsy();
    const id = idOf(res.content);
    expect(res.content).toBe(backgroundLaunchText(id, "sleep 30"));
    expect(res.content).toContain(`Started in the background as process ${id}: $ sleep 30`);
    expect(res.content).toContain(`read_file(process: "${id}")`);
    expect(res.content).toContain(`write_file(process: "${id}", content: "…")`);
    expect(res.content).toContain(`delete_file(process: "${id}")`);
    expect(res.content).toContain("list_dir(processes: true)");
    expect(view(id)).toMatchObject({ status: "running", background: true, command: "sleep 30" });
  });

  it.skipIf(!posix)("its output is on disk and readable while it runs; it ends on its own as exit 0", async () => {
    const id = idOf((await run({ command: "echo one; echo two", background: true })).content);
    const end = await ended(id);
    expect(end).toMatchObject({ status: "exited", exitCode: 0 });
    expect((await read({ process: id })).content).toBe("one\ntwo\n[lines 1–2 of 2 · exited 0]");
  });

  it.skipIf(!posix)("the per-call timeout still applies to a background process", async () => {
    const id = idOf((await run({ command: "sleep 30", background: true, timeout: 0.2 })).content);
    expect(await ended(id)).toMatchObject({ status: "killed", killReason: "timeout" });
  });

  it.skipIf(!posix)("a spawn that fails (cwd gone after the fence check) answers 'failed to start' and lists as ended, fds closed once (R6)", async () => {
    const gone = path.join(root, "gone");
    fs.mkdirSync(gone);
    const closeSpy = vi.spyOn(fs, "closeSync");
    const openSpy = vi.spyOn(fs, "openSync");
    const realStat = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation(((p: fs.PathLike, o?: fs.StatSyncOptions) => {
      const st = realStat(p, o as never);
      if (p === gone) fs.rmSync(gone, { recursive: true, force: true });
      return st;
    }) as typeof fs.statSync);
    const res = await run({ command: "echo never", cwd: "gone", background: true });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/^failed to start: /);
    const [t] = tasks.all();
    await ended(t!.id);
    const listing = (await list()).content;
    expect(listing).toContain(`${t!.id} · echo never · ended (failed to start: `);
    const logFds = openSpy.mock.results
      .filter((_, i) => String(openSpy.mock.calls[i]![0]).includes(t!.id))
      .map((r) => r.value as number);
    expect(logFds).toHaveLength(3);
    for (const fd of logFds) expect(closeSpy.mock.calls.filter((c) => c[0] === fd)).toHaveLength(1);
  });

  it("without a registry it says so rather than launching something nobody can reach", async () => {
    const res = await run({ command: "sleep 30", background: true }, { sandbox: new Sandbox([root]) });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("needs a process registry");
  });

  it("is advertised briefly enough for a model that never saw it", () => {
    const d = runCommandTool().def.function;
    expect(d.description).toContain("'background: true'");
    expect(d.description).toContain("read_file(process: id)");
    expect(d.description).toContain("write_file(process: id, content)");
    expect(d.description).toContain("delete_file(process: id)");
    expect(d.description).toContain("list_dir(processes: true)");
    expect(d.description).toContain("survives Stop");
    expect(d.description).toContain("move it to the background"); // the watchdog's third answer
    const props = (d.parameters as { properties: Record<string, { type: string }> }).properties;
    expect(props.background?.type).toBe("boolean");
  });

  it.skipIf(!posix)("has no watchdog: a background launch arms none, even with a tiny interval", async () => {
    let asks = 0;
    const driver: LlmDriver = {
      async *streamChat(req): AsyncGenerator<StreamEvent> {
        const last = lastContent(req);
        if (last.includes("[watchdog]")) {
          asks++;
          yield* toolCall("decide_kill", { action: "kill" });
        } else if (req.messages[req.messages.length - 1]?.role === "tool") yield* text("ok");
        else yield* toolCall("run_command", { command: "sleep 30", background: true });
      },
    };
    const reg = new TaskRegistry({ graceMs: 200 });
    const set = vi.spyOn(globalThis, "setTimeout");
    const { session } = makeSession({ driver, watchdogMs: 4321, reg });
    await session.send("go");
    const id = idOf(toolResults(session)[0]!);
    // The watchdog arms synchronously on task-start: no timer at its interval.
    expect(set.mock.calls.some((c) => c[1] === 4321)).toBe(false);
    expect(asks).toBe(0);
    expect(view(id, reg).status).toBe("running");
  });
});

describe("write_file(process:) — stdin (D-104, G10)", () => {
  it.skipIf(!posix)("appends exactly the content, no newline added; close sends EOF and the process finishes", async () => {
    const id = idOf((await run({ command: "cat", background: true })).content);
    const a = await write({ process: id, content: "ab" });
    expect(a.isError).toBeFalsy();
    expect(a.content).toContain(`wrote 2 bytes to the stdin of process ${id}`);
    await write({ process: id, content: "c\n", path: "ignored.md", command: "ignored" });
    await logHas(id, "abc\n");
    const c = await write({ process: id, close: true });
    expect(c.content).toContain("closed its stdin (EOF)");
    expect(await ended(id)).toMatchObject({ status: "exited", exitCode: 0 });
    expect(logOf(id)).toBe("abc\n");
    expect(fs.existsSync(path.join(root, "ignored.md"))).toBe(false);
  });

  it.skipIf(!posix)("content and close together: the bytes, then EOF", async () => {
    const id = idOf((await run({ command: "wc -c", background: true })).content);
    const res = await write({ process: id, content: "12345", close: true });
    expect(res.content).toContain("wrote 5 bytes");
    expect(res.content).toContain("then closed it (EOF)");
    await ended(id);
    expect(logOf(id).trim()).toBe("5");
  });

  it.skipIf(!posix)("writing to an ended process is an error that still points at its output", async () => {
    const id = idOf((await run({ command: "echo done", background: true })).content);
    await ended(id);
    const res = await write({ process: id, content: "late\n" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain(`Process ${id} has ended (exited 0)`);
    expect(res.content).toContain(`read_file(process: "${id}")`);
  });

  it.skipIf(!posix)("a child that has exited counts as ended even before its task finishes (R6)", async () => {
    const child = spawn("echo pid=$$; sleep 30 &", shellSpawnOptions(root));
    reap.push(child.pid!);
    const { id } = tasks.start("x", child, () => killTree(child));
    await new Promise((r) => child.once("exit", r));
    expect(view(id).status).toBe("running"); // the daemon holds the pipe: no close yet
    const res = await write({ process: id, content: "x" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("has ended");
  });

  it.skipIf(!posix)("after close, and when the process closes its own input (EPIPE), it says the input is closed — nothing throws", async () => {
    const a = idOf((await run({ command: "sleep 30", background: true })).content);
    await write({ process: a, close: true });
    const again = await write({ process: a, content: "more" });
    expect(again.isError).toBe(true);
    expect(again.content).toContain("has closed its input");

    const b = idOf((await run({ command: "exec 0<&-; echo ready; sleep 30", background: true })).content);
    await logHas(b, "ready");
    // The first write may land in the pipe before the kernel reports the
    // closed reader; by the second, EPIPE has surfaced as an `error` event.
    const first = await write({ process: b, content: "x\n" });
    const second = first.isError ? first : await write({ process: b, content: "y\n" });
    expect(second.isError).toBe(true);
    expect(second.content).toContain("has closed its input");
    expect(view(b).status).toBe("running");
  });

  it.skipIf(!posix)("close: true with content, to a process that closed its input: an error, not 'then closed it' (review R1)", async () => {
    const id = idOf((await run({ command: "exec 0<&-; echo ready; sleep 5", background: true })).content);
    await logHas(id, "ready");
    const res = await write({ process: id, content: "x".repeat(10), close: true });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("has closed its input");
    expect(res.content).not.toContain("closed it (EOF)");
  });

  it("an unknown id is an error naming what this conversation has; bad arguments are refused", async () => {
    const res = await write({ process: "task_nope", content: "x" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('No process "task_nope"');
    expect((await write({ process: "", content: "x" })).content).toContain("must be a process id");
    expect((await write({ process: "task_nope" })).content).toContain("needs 'content' to send, or 'close: true'");
  });

  it("is advertised: process and close, path no longer required, gated like a command", () => {
    const d = writeTool!.def.function;
    const params = d.parameters as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(params.properties)).toEqual(expect.arrayContaining(["path", "content", "process", "close"]));
    expect(params.required ?? []).not.toContain("path");
    expect(d.description).toContain("stdin");
    expect(d.description).toContain("no newline is added");
    expect(d.description).toContain("'close: true'");
    expect(d.description).toContain("approved like running a command");
    expect(writeTool!.processAware).toBe(true);
    expect(deleteTool!.processAware).toBe(true);
  });
});

describe("the stdin gate: its own rule, checked first (R1 must-fix 3, D-105d)", () => {
  const stdin = { process: "task_x", content: "y\n" };
  const gate = (mode: Mode, policy: ApprovalPolicy, allow: string[] = []) => new ModeApprovalGate(mode, policy, allow);

  it("Ask and Plan deny; code: read-only denies, manual and auto-safe prompt, full-auto allows", () => {
    expect(gate("ask", "full-auto").check(writeTool!, stdin)).toMatchObject({ kind: "deny", reason: expect.stringContaining("Ask mode") });
    expect(gate("plan", "full-auto").check(writeTool!, stdin)).toMatchObject({ kind: "deny", reason: expect.stringContaining("Plan mode") });
    expect(gate("code", "read-only").check(writeTool!, stdin).kind).toBe("deny");
    expect(gate("code", "manual").check(writeTool!, stdin).kind).toBe("prompt");
    expect(gate("code", "auto-safe").check(writeTool!, stdin).kind).toBe("prompt");
    expect(gate("code", "full-auto").check(writeTool!, stdin).kind).toBe("allow");
  });

  it("ignored arguments can't steer it: a .md path doesn't pass Plan, a git command doesn't hit an allowlist", () => {
    // Plan's markdown rule and its git allowlist both read args the call ignores.
    expect(gate("plan", "full-auto").check(writeTool!, { ...stdin, path: "notes.md" }).kind).toBe("deny");
    expect(gate("plan", "full-auto").check(writeTool!, { ...stdin, command: "git status" }).kind).toBe("deny");
    // auto-safe never consults its allowlist for stdin, whatever `command` says.
    expect(gate("code", "auto-safe", ["git status", ""]).check(writeTool!, { ...stdin, command: "git status" }).kind).toBe("prompt");
    // The plain file write keeps its old rule.
    expect(gate("plan", "full-auto").check(writeTool!, { path: "notes.md", content: "x" }).kind).toBe("allow");
  });

  it("delete_file(process:) is allowed in every mode and under every policy, with no approval (G9)", () => {
    for (const mode of ["ask", "plan", "code"] as Mode[]) {
      for (const policy of ["read-only", "manual", "auto-safe", "full-auto"] as ApprovalPolicy[]) {
        expect(gate(mode, policy).check(deleteTool!, { process: "task_x", path: "/etc/passwd" }).kind).toBe("allow");
      }
    }
    // A file delete is still a write.
    expect(gate("ask", "full-auto").check(deleteTool!, { path: "a.txt" }).kind).toBe("deny");
  });

  it("only the native tools carry the rule: a same-named tool without it is gated as before", () => {
    const impostor: Tool = { ...deleteTool!, processGate: undefined, processAware: undefined };
    expect(gate("ask", "full-auto").check(impostor, { process: "task_x" }).kind).toBe("deny");
  });
});

describe("the stdin approval card and the session's gate", () => {
  it.skipIf(!posix)("manual: the card reads as stdin to a process (kind command, a stdin preview), and approving writes it", async () => {
    const reg = new TaskRegistry({ graceMs: 200 });
    const id = idOf((await run({ command: "cat", background: true }, { sandbox: new Sandbox([root]), tasks: reg })).content);
    const driver: LlmDriver = {
      async *streamChat(req): AsyncGenerator<StreamEvent> {
        if (req.messages[req.messages.length - 1]?.role === "tool") yield* text("ok");
        // A junk out-of-fence path rides along: ignored, so neither fenced nor shown.
        else yield* toolCall("write_file", { process: id, content: "hi there\n", path: "/elsewhere/x.md" });
      },
    };
    const { session, approvals } = makeSession({ driver, approval: "manual", reg });
    await session.send("go");
    expect(approvals).toHaveLength(1);
    const card = approvals[0]!;
    expect(card).toMatchObject({ tool: "write_file", kind: "command" });
    expect(card.reason).toContain("input to a running process");
    expect(card.outOfFence).toBeUndefined();
    expect(card.preview).toMatchObject({ kind: "stdin", process: id, command: "cat", state: "running", body: "hi there", bytes: 9, close: false });
    await session.approve({ approve: true });
    expect(toolResults(session)[0]).toContain(`wrote 9 bytes to the stdin of process ${id}`);
    await logHas(id, "hi there\n", reg);
  });

  it.skipIf(!posix)("Ask mode denies the write but lets delete_file kill the process, with no card", async () => {
    const reg = new TaskRegistry({ graceMs: 200 });
    const id = idOf((await run({ command: "sleep 30", background: true }, { sandbox: new Sandbox([root]), tasks: reg })).content);
    let turn = 0;
    const driver: LlmDriver = {
      async *streamChat(): AsyncGenerator<StreamEvent> {
        turn++;
        if (turn === 1) yield* toolCall("write_file", { process: id, content: "x", path: "a.md" });
        else if (turn === 2) yield* toolCall("delete_file", { process: id, path: "/etc/hosts" });
        else yield* text("ok");
      },
    };
    const { session, approvals } = makeSession({ driver, mode: "ask", reg });
    await session.send("go");
    expect(approvals).toHaveLength(0);
    const [w, d] = toolResults(session);
    expect(w).toContain("denied: Ask mode is read-only");
    expect(d).toMatch(new RegExp(`Process ${id} ended \\(killed with delete_file\\) after \\d+s`));
    expect(view(id, reg)).toMatchObject({ status: "killed", killReason: "agent" });
  });

  it("the stdin preview flags a write that will fail", () => {
    const p = writeTool!.preview!({ process: "task_nope", content: "a\nb\n", close: true }, ctx);
    expect(p).toMatchObject({ kind: "stdin", process: "task_nope", body: "a\nb", bytes: 4, close: true });
    expect((p as { error?: string }).error).toContain("no process");
    expect(deleteTool!.preview!({ process: "task_nope", path: "a.txt" }, ctx)).toBeUndefined();
  });
});

describe("delete_file(process:) — kill (D-104, G9)", () => {
  it.skipIf(!posix)("kills the whole tree and says how it ended; the output stays readable", async () => {
    const id = idOf((await run({ command: "echo up; sleep 30 & sleep 30", background: true })).content);
    await logHas(id, "up\n");
    const res = await del({ process: id });
    expect(res.isError).toBeFalsy();
    expect(res.content).toMatch(new RegExp(`^Process ${id} ended \\(killed with delete_file\\) after \\d+s\\.`));
    expect(res.content).toContain(`read_file(process: "${id}")`);
    expect(view(id)).toMatchObject({ status: "killed", killReason: "agent" });
    expect((await read({ process: id })).content).toContain("up\n[lines 1–1 of 1 · killed with delete_file]");
  });

  it.skipIf(!posix)("an already-ended process: nothing to kill, its outcome kept", async () => {
    const id = idOf((await run({ command: "true", background: true })).content);
    await ended(id);
    const res = await del({ process: id });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain(`Process ${id} had already ended (exited 0); nothing to kill.`);
    expect(view(id).killReason).toBeUndefined();
  });

  it("a process already being killed (not yet finished) says so, not 'had already ended' (review R1)", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4545,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: () => true,
    }) as unknown as ChildProcess;
    const { id } = tasks.start("fake", child, () => {}); // the kill lands, the child lingers
    tasks.kill(id, "user");
    const res = await del({ process: id });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain(`Process ${id} is already being killed (killed by the user)`);
    expect(res.content).not.toContain("had already ended");
  });

  it("an unknown id is an error; a path it ignores is never touched", async () => {
    fs.writeFileSync(path.join(root, "keep.txt"), "x");
    const res = await del({ process: "task_nope", path: "keep.txt" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('No process "task_nope"');
    expect(fs.existsSync(path.join(root, "keep.txt"))).toBe(true);
  });

  it("is advertised: process, no approval, path no longer required", () => {
    const d = deleteTool!.def.function;
    const params = d.parameters as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(params.properties)).toEqual(["path", "process"]);
    expect(params.required ?? []).not.toContain("path");
    expect(d.description).toContain("kill that process and everything it started");
    expect(d.description).toContain("no approval");
  });
});

describe("list_dir(processes: true) (D-104, G8)", () => {
  it.skipIf(!posix)("the how-to line, then one row per background process; foreground never listed", async () => {
    const empty = (await list()).content;
    expect(empty).toContain("No background processes. Start one with run_command(background: true)");
    expect(empty).toContain("read_file(process: ID)");

    const fg = await run({ command: "echo foreground" });
    expect(fg.content).toContain("foreground");
    const id = idOf((await run({ command: "printf 'a\\nb\\n'; echo err >&2; sleep 30", background: true })).content);
    await logHas(id, "err\n");
    const out = (await list()).content.split("\n");
    expect(out[0]).toBe(
      'Background processes — read: read_file(process: ID) · write stdin: write_file(process: ID, content: "…") · kill: delete_file(process: ID)',
    );
    expect(out).toHaveLength(2); // only the background one
    expect(out[1]).toMatch(new RegExp(`^${id} · printf .* · running · \\d+s · stdout 2 lines, stderr 1 lines$`));
  });

  it.skipIf(!posix)("an ended process appears in exactly one listing, then drops off — still readable", async () => {
    const id = idOf((await run({ command: "printf 'no newline'", background: true })).content);
    await ended(id);
    const first = (await list()).content;
    // Ended: the unterminated last line counts (R2 must-fix 3).
    expect(first).toMatch(new RegExp(`${id} · printf 'no newline' · ended \\(exited 0\\) · \\d+s · stdout 1 lines, stderr 0 lines`));
    expect(first).toContain("listed once, then drops off");
    const second = (await list()).content;
    expect(second).not.toContain(id);
    expect((await read({ process: id })).content).toContain("no newline");
  });

  it.skipIf(!posix)("a process seen running then ended is listed once more, ended", async () => {
    const id = idOf((await run({ command: "sleep 30", background: true })).content);
    expect((await list()).content).toContain(`${id} · sleep 30 · running`);
    tasks.kill(id, "user");
    await ended(id);
    expect((await list()).content).toContain(`${id} · sleep 30 · ended (killed by the user)`);
    expect((await list()).content).not.toContain(id);
  });

  it("with processes set, a path it ignores is not fenced — no prompt (G9)", async () => {
    let turn = 0;
    const driver: LlmDriver = {
      async *streamChat(): AsyncGenerator<StreamEvent> {
        yield* ++turn === 1 ? toolCall("list_dir", { processes: true, path: "/somewhere/outside" }) : text("ok");
      },
    };
    const { session, approvals } = makeSession({ driver, approval: "manual" });
    await session.send("go");
    expect(approvals).toHaveLength(0);
    expect(toolResults(session)[0]).toContain("No background processes");
  });

  it("is advertised", () => {
    const d = listTool!.def.function;
    expect(d.description).toContain("'processes: true'");
    expect(Object.keys((d.parameters as { properties: object }).properties)).toEqual(["path", "processes"]);
  });

  it("formats runtimes the way a person says them", () => {
    expect(formatDuration(4_200)).toBe("4s");
    expect(formatDuration(133_000)).toBe("2m 13s");
    expect(formatDuration(3_720_000)).toBe("1h 02m");
  });
});

describe("the watchdog can background a command (D-106)", () => {
  it("decide_kill reads action, and a bare kill: true/false as kill/keep", () => {
    expect(parseWatchdogDecision({ action: "background" })).toBe("background");
    expect(parseWatchdogDecision({ action: "kill" })).toBe("kill");
    expect(parseWatchdogDecision({ action: "keep" })).toBe("keep");
    expect(parseWatchdogDecision({ kill: true })).toBe("kill");
    expect(parseWatchdogDecision({ kill: false })).toBe("keep");
    expect(parseWatchdogDecision({ action: "explode" })).toBe("keep");
    expect(parseWatchdogDecision(null)).toBe("keep");
  });

  it.skipIf(!posix)("backgrounds `read x; echo got $x`, then write_file(process:) feeds it to completion: exit 0, 'got …' in its log", async () => {
    let asks = 0;
    let watchdogTools: unknown;
    const driver: LlmDriver = {
      async *streamChat(req): AsyncGenerator<StreamEvent> {
        const last = req.messages[req.messages.length - 1];
        const content = lastContent(req);
        if (last?.role === "user" && content.startsWith("[Background process")) {
          yield* text("noted"); // its completion notice (P10c)
        } else if (content.includes("[watchdog]")) {
          asks++;
          watchdogTools = req.tools;
          yield* toolCall("decide_kill", { action: "background", reason: "it is waiting for input" });
        } else if (last?.role === "tool" && content.includes("Moved to the background")) {
          yield* toolCall("write_file", { process: idOf(content), content: "hello\n" });
        } else if (last?.role === "tool") {
          yield* text("fed it");
        } else {
          yield* toolCall("run_command", { command: "read x; echo got $x" });
        }
      },
    };
    const reg = new TaskRegistry({ graceMs: 200 });
    const { session } = makeSession({ driver, watchdogMs: 30, reg });
    const noticed = noticeTurn(session);
    await session.send("go");
    expect(asks).toBe(1); // backgrounded: never watched again
    const [moved, wrote] = toolResults(session);
    const id = idOf(moved!);
    expect(moved).toMatch(new RegExp(`^Moved to the background after \\d+s — still running as process ${id}: \\$ read x; echo got \\$x\\n`));
    expect(moved).toContain("Its output so far stays readable from line 1.");
    expect(moved).toContain(`write_file(process: "${id}", content: "…")`);
    expect(wrote).toContain(`wrote 6 bytes to the stdin of process ${id}`);
    const end = await ended(id, reg);
    expect(end).toMatchObject({ status: "exited", exitCode: 0, background: true });
    expect(logOf(id, reg)).toContain("got hello");
    // P10c (R3 must-fix 2 moved it here): the backgrounded command's end sends
    // its notice, which the agent reads.
    expect(await noticed).toMatch(new RegExp(`^\\[Background process ${id} ended \\(exited 0\\) after \\d+s: \\$ read x; echo got \\$x\\]`));
    // The question offers the third answer.
    const def = (watchdogTools as { function: { name: string; parameters: { properties: { action: { enum: string[] } }; required: string[] } } }[])[0]!;
    expect(def.function.name).toBe("decide_kill");
    expect(def.function.parameters.properties.action.enum).toEqual(["kill", "keep", "background"]);
    expect(def.function.parameters.required).toEqual(["action"]);
  });

  it.skipIf(!posix)("a child that already exited while a daemon holds its pipe: backgrounding ends it, exit 0 (R5)", async () => {
    const driver: LlmDriver = {
      async *streamChat(req): AsyncGenerator<StreamEvent> {
        const last = req.messages[req.messages.length - 1];
        if (lastContent(req).includes("[watchdog]")) yield* toolCall("decide_kill", { action: "background" });
        else if (last?.role === "tool" || lastContent(req).startsWith("[Background process")) yield* text("ok");
        else yield* toolCall("run_command", { command: "echo pid=$$; sleep 30 &" });
      },
    };
    const reg = new TaskRegistry({ graceMs: 200 });
    const { session } = makeSession({ driver, watchdogMs: 30, reg });
    const noticed = noticeTurn(session);
    await session.send("go");
    const id = idOf(toolResults(session)[0]!);
    const end = await ended(id, reg);
    reap.push(Number(/pid=(\d+)/.exec(logOf(id, reg))![1]));
    expect(end).toMatchObject({ status: "exited", exitCode: 0, background: true });
    expect(await noticed).toContain(`[Background process ${id} ended (exited 0)`); // P10c
  });

  it.skipIf(!posix)("the flip resolves run_command once with the moved text; the later close doesn't resolve it again", async () => {
    const events: TaskEvent[] = [];
    tasks.onEvent((e) => events.push(e));
    const pending = run({ command: "sleep 0.3; echo finished" });
    const start = events.find((e) => e.type === "task-start")!;
    expect(tasks.toBackground(start.task.id)).toBe(true);
    const res = await pending;
    expect(res.content).toMatch(/^Moved to the background after \d+s/);
    const end = await ended(start.task.id);
    expect(end).toMatchObject({ status: "exited", exitCode: 0 });
    expect(logOf(start.task.id)).toBe("finished\n");
    expect(tasks.toBackground(start.task.id)).toBe(false); // finished
  });

  it.skipIf(!posix)("the per-call timeout stays armed after the flip (R2 nit)", async () => {
    const events: TaskEvent[] = [];
    tasks.onEvent((e) => events.push(e));
    const pending = run({ command: "sleep 30", timeout: 0.3 });
    const start = events.find((e) => e.type === "task-start")!;
    tasks.toBackground(start.task.id);
    expect((await pending).content).toMatch(/^Moved to the background/);
    expect(await ended(start.task.id)).toMatchObject({ status: "killed", killReason: "timeout", background: true });
  });

  it.skipIf(!posix)("the old answers still work: kill: true kills, and the description names all three", async () => {
    const driver: LlmDriver = {
      async *streamChat(req): AsyncGenerator<StreamEvent> {
        const last = req.messages[req.messages.length - 1];
        if (lastContent(req).includes("[watchdog]")) yield* toolCall("decide_kill", { kill: true });
        else if (last?.role === "tool") yield* text("ok");
        else yield* toolCall("run_command", { command: "sleep 30" });
      },
    };
    const { session } = makeSession({ driver, watchdogMs: 20 });
    await session.send("go");
    expect(toolResults(session)[0]).toContain("[killed by the watchdog");
  });
});

describe("Stop spares background processes; 'Stop and kill processes' (D-104, R1 G11, R3–R5)", () => {
  /** Turn 1 launches `sleep 30` in the background; later turns per `then`. */
  function bgThen(then: (turn: number, req: ChatRequest, signal?: AbortSignal) => AsyncGenerator<StreamEvent>): LlmDriver {
    let turn = 0;
    return {
      async *streamChat(req, opts): AsyncGenerator<StreamEvent> {
        turn++;
        if (turn === 1) yield* toolCall("run_command", { command: "sleep 30", background: true });
        else yield* then(turn, req, opts?.signal);
      },
    };
  }
  async function* hang(signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    yield { type: "text", delta: "thinking" };
    await new Promise<void>((_r, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  }

  it.skipIf(!posix)("a hard Stop kills the foreground command and leaves the background one running", async () => {
    const reg = new TaskRegistry({ graceMs: 200 });
    const driver = bgThen(async function* (turn) {
      if (turn === 2) yield* toolCall("run_command", { command: "sleep 30" });
      else yield* text("ok");
    });
    const { session } = makeSession({ driver, reg });
    reg.onEvent((e) => {
      if (e.type === "task-start" && !e.task.background) session.stop("hard");
    });
    await session.send("go");
    const [bg, fg] = reg.all();
    expect(bg).toMatchObject({ background: true, status: "running" });
    expect(fg).toMatchObject({ status: "killed", killReason: "stop" });
    expect(toolResults(session)[1]).toContain("[killed by global stop]");
  });

  it.skipIf(!posix)("idle: kills the processes (reason stop) and nothing else — no queue clear, no stopped event; the notice is parked (P10c)", async () => {
    const reg = new TaskRegistry({ graceMs: 200 });
    const { session, events } = makeSession({ driver: bgThen(async function* () { yield* text("ok"); }), reg });
    await session.send("go");
    expect(session.status).toBe("idle");
    session.setQueue([{ text: "held for later" }]);
    const before = events.length;
    const [bg] = reg.all();
    session.stop("hard", { killProcesses: true });
    expect(await ended(bg!.id, reg)).toMatchObject({ status: "killed", killReason: "stop" });
    // P10c: the process's notice joins the queue, parked — nothing was cleared.
    const queued = session.queuedMessages;
    expect(queued[0]).toMatchObject({ text: "held for later" });
    expect(queued[1]).toMatchObject({ parked: true, inbound: { kind: "process", from: bg!.id } });
    expect(queued).toHaveLength(2);
    expect(events.slice(before).some((e) => e.type === "stopped")).toBe(false);
    expect(session.status).toBe("idle");
  });

  it.skipIf(!posix)("mid-turn: the hard Stop plus the kill, even when asked with the soft scope", async () => {
    const reg = new TaskRegistry({ graceMs: 200 });
    const { session, events } = makeSession({ driver: bgThen((_t, _r, signal) => hang(signal)), reg });
    const turn = session.send("go");
    await new Promise<void>((resolve) => session.onEvent((e) => e.type === "text" && resolve()));
    expect(session.status).toBe("running");
    const [bg] = reg.all();
    session.stop("soft", { killProcesses: true });
    await turn;
    expect(events.some((e) => e.type === "stopped" && e.scope === "hard")).toBe(true);
    expect(await ended(bg!.id, reg)).toMatchObject({ status: "killed", killReason: "stop" });
    expect(session.status).toBe("idle");
  });
});

describe("the dispose nit from P10a (review R2)", () => {
  function fakeChild(): ChildProcess {
    return Object.assign(new EventEmitter(), {
      pid: 4343,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: () => true,
    }) as unknown as ChildProcess;
  }

  it("a task-update listener that throws inside dispose's kill: the tree is still signalled, finish still runs, timers cleared, no late task-end", () => {
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const ends: TaskView[] = [];
    let killed = 0;
    const child = fakeChild();
    const { id } = tasks.start("fake", child, () => killed++, { timeoutMs: 987_654 });
    tasks.onEvent((e) => {
      if (e.type === "task-update") throw new Error("listener blew up");
      if (e.type === "task-end") ends.push(e.task);
    });
    expect(() => tasks.dispose()).not.toThrow();
    expect(killed).toBe(1);
    expect(ends).toHaveLength(1); // during dispose, not after
    expect(ends[0]).toMatchObject({ id, status: "killed", killReason: "stop" });
    expect(clear).toHaveBeenCalled();
    child.emit("exit", null, "SIGKILL");
    child.emit("close", null, "SIGKILL");
    expect(ends).toHaveLength(1);
  });

  it("a throwing task-update listener on an ordinary kill still signals the tree", () => {
    let killed = 0;
    const { id } = tasks.start("fake", fakeChild(), () => killed++);
    tasks.onEvent((e) => {
      if (e.type === "task-update") throw new Error("listener blew up");
    });
    expect(() => tasks.kill(id, "user")).toThrow("listener blew up");
    expect(killed).toBe(1);
  });
});

describe("fake-driver commands for the peek (P10c)", () => {
  it.skipIf(!posix)("bg:, stdin:, procs:, eof: and kill: drive a background process offline", async () => {
    const reg = new TaskRegistry({ graceMs: 200 });
    const { session } = makeSession({ driver: fakeAgentDriver(), reg });
    await session.send("bg: cat");
    const id = idOf(toolResults(session)[0]!);
    await session.send("stdin: hello");
    await logHas(id, "hello\n", reg);
    await session.send(`stdin: ${id} | again`);
    await logHas(id, "again\n", reg);
    await session.send("procs:");
    expect(toolResults(session)[3]).toContain(`${id} · cat · running`);
    await session.send("eof:");
    // Its exit sends a notice (P10c) that opens a turn of its own: wait for
    // that turn to settle before typing again.
    const noticed = new Promise<void>((resolve) => {
      let opened = false;
      session.onEvent((e) => {
        if (e.type === "user" && e.text.startsWith("[Background process")) opened = true;
        if (opened && e.type === "settled") resolve();
      });
    });
    expect(await ended(id, reg)).toMatchObject({ status: "exited", exitCode: 0 });
    await noticed;
    await session.send("bg: sleep 30");
    const second = idOf(toolResults(session)[5]!);
    await session.send("kill:");
    expect(toolResults(session)[6]).toContain(`Process ${second} ended (killed with delete_file)`);
  });
});

// ---------------------------------------------------------------------------
// Through the server and a real agent tree: the stop flag fans down, and every
// close path still kills a background process (R1 must-fix 1).

describe("through the server: the stop flag fans down the tree; closing still kills (R1 G11, must-fix 1)", () => {
  const OPUS = "anthropic/claude-opus-5";
  let dir: string;
  let paths: JlcodePaths;
  let workspace: string;
  let convStore: ConversationStore;
  let catalog: ModelCatalog;
  const saved = { config: process.env.JLCODE_CONFIG_DIR, data: process.env.JLCODE_DATA_DIR };
  let live: SessionManager | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-p10b-srv-"));
    process.env.JLCODE_CONFIG_DIR = path.join(dir, "config");
    process.env.JLCODE_DATA_DIR = path.join(dir, "data");
    paths = resolvePaths();
    fs.mkdirSync(path.dirname(paths.modelsCacheFile), { recursive: true });
    fs.writeFileSync(
      paths.modelsCacheFile,
      JSON.stringify({ fetchedAt: "2099-01-01T00:00:00.000Z", windows: { [OPUS]: 1_000_000 }, modalities: { [OPUS]: ["text"] }, prices: {}, limits: {} }),
    );
    workspace = path.join(dir, "work");
    fs.mkdirSync(workspace, { recursive: true });
    convStore = new ConversationStore(path.join(dir, "conversations"), { fsync: false });
    catalog = new ModelCatalog({ file: paths.modelsCacheFile });
    const cfg = defaultConfig();
    const a = addModelConfig(cfg, {
      name: "opus",
      model: OPUS,
      openRouterKey: "sk-or-v1-client-a-0000000000aaaa",
      defaultMode: "code",
      defaultApproval: "full-auto",
      environment: { turnTimestamps: false },
    });
    saveConfig(setBinding(a.config, workspace, a.added.id), paths);
  });
  afterEach(async () => {
    for (const s of live?.list() ?? []) s.disposeProcesses();
    live = undefined;
    await convStore.close();
    process.env.JLCODE_CONFIG_DIR = saved.config;
    process.env.JLCODE_DATA_DIR = saved.data;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeServer() {
    const deps = { paths, cwd: workspace, makeDriver: () => fakeAgentDriver(), mcpTools: () => [], catalog };
    const server = createServer({
      resolveConfig: () => resolveForCwd(loadConfig(paths), workspace),
      newSession: createSessionFactory(deps),
      listConfigs: () => loadConfig(paths).modelConfigs,
      store: convStore,
      workingDir: workspace,
      version: "0.0.0",
    });
    live = server.manager;
    return server;
  }
  async function post(app: ReturnType<typeof makeServer>["app"], url: string, body: unknown = {}) {
    const res = await app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  }
  function until(manager: SessionManager, pred: () => boolean): Promise<void> {
    return new Promise((resolve) => {
      if (pred()) return resolve();
      const unsub = manager.subscribe(() => {
        if (pred()) {
          unsub();
          resolve();
        }
      });
    });
  }
  /** A root that launched a background process and spawned agent-1, which did too. */
  async function treeWithProcesses() {
    const server = makeServer();
    const res = await post(server.app, "/chat", { text: "bg: sleep 30" });
    const root = server.manager.get(res.json.sessionId)!;
    await until(server.manager, () => root.status === "idle");
    await root.send("spawn: bg: sleep 30");
    await server.agents.idle();
    const child = () => server.manager.list().find((s) => s.agentInfo?.name === "agent-1");
    await until(server.manager, () => child()?.status === "idle" && root.status === "idle");
    const ends = new Map<Session, TaskView[]>();
    for (const s of [root, child()!]) {
      const list: TaskView[] = [];
      ends.set(s, list);
      s.onEvent((e) => e.type === "task-end" && list.push(e.task));
    }
    expect(root.taskList).toHaveLength(1);
    expect(child()!.taskList).toHaveLength(1);
    return { ...server, root, child: child()!, ends };
  }
  /** Resolves once `s` has reported a task-end — its own event, no clock. */
  const settle = (s: Session, ends: TaskView[]) =>
    new Promise<void>((resolve) => {
      if (ends.length > 0) return resolve();
      s.onEvent((e) => e.type === "task-end" && resolve());
    });

  it.skipIf(!posix)("plain Stop spares every background process in the tree; the flag kills them all, idle sessions untouched otherwise", async () => {
    const { app, root, child, ends } = await treeWithProcesses();
    expect((await post(app, `/session/${root.id}/stop`, { scope: "hard" })).status).toBe(200);
    expect(root.taskList).toHaveLength(1);
    expect(child.taskList).toHaveLength(1);
    expect((await post(app, `/session/${root.id}/stop`, { killProcesses: true })).status).toBe(200);
    await settle(root, ends.get(root)!);
    await settle(child, ends.get(child)!);
    for (const s of [root, child]) {
      expect(ends.get(s)![0]).toMatchObject({ status: "killed", killReason: "stop", background: true });
      expect(s.status).toBe("idle");
    }
  });

  it.skipIf(!posix)("close_agent's subtree close and a root's close still kill background processes", async () => {
    const { app, agents, root, child, ends } = await treeWithProcesses();
    agents.closeChild(root, "agent-1");
    expect(ends.get(child)!).toHaveLength(1);
    expect(ends.get(child)![0]).toMatchObject({ status: "killed", killReason: "stop" });
    expect(root.taskList).toHaveLength(1); // the parent's own is untouched
    await post(app, `/session/${root.id}/close`);
    await agents.idle();
    expect(ends.get(root)!).toHaveLength(1);
    expect(ends.get(root)![0]).toMatchObject({ status: "killed", background: true });
  });
});
