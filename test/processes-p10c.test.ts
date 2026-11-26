/**
 * Phase 10, slice P10c (D-104, D-105; plan reviews R1–R7): the completion
 * notice a background process sends its thread, and the queue's `parked` flag.
 *
 *   - A background process that exits on its own, or is killed by the person's
 *     Kill or by its timeout, queues a notice (a new `InboundMeta` kind,
 *     `process`) that wakes an idle agent; mid-turn it lands at the next model
 *     call (D-52). It says how the process ended, the runtime and the read
 *     call. Never recorded in the inbox (G12).
 *   - None for the agent's own `delete_file` (R3 nit) and none from a disposed
 *     registry (R2 must-fix 1).
 *   - A process "Stop and kill processes" killed is queued **parked** (R1
 *     must-fix 4, R5): it opens no turn. A hard Stop keeps queued notices,
 *     parked (R2 must-fix 2), and no drain opens a turn on a parked-only queue —
 *     the held-for-a-missing-model drain included (R3 must-fix 1, R4 nit). Wake
 *     ignores the gate (R4 must-fix 1). The wording says "process notices
 *     waiting" rather than "owes a reply" (R5).
 *
 * Real children; POSIX `sh`, so those skip on win32. Waits are on session and
 * registry events, never a clock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { Sandbox } from "../src/tools/sandbox";
import { TaskRegistry, processNoticeText, type TaskView } from "../src/tools/task-registry";
import { ProcessStore } from "../src/tools/process-store";
import { runCommandTool, backgroundLaunchText } from "../src/tools/shell-tool";
import { fileTools } from "../src/tools/file-tools";
import { ModeApprovalGate } from "../src/tools/mode-gate";
import { ToolRegistry } from "../src/tools/registry";
import { Session } from "../src/session/session";
import { fakeAgentDriver } from "../src/session/fake";
import type { ChatRequest, LlmDriver, StreamEvent } from "../src/llm/types";
import type { ModelConfig } from "../src/config/types";
import { createServer } from "../src/server/server";
import { createSessionFactory } from "../src/server/session-factory";
import { ConversationStore, agentConversationId } from "../src/persist/conversation-store";
import { ModelCatalog } from "../src/llm/models";
import { loadConfig, saveConfig, defaultConfig } from "../src/config/store";
import { addModelConfig, setBinding, resolveForCwd } from "../src/config/operations";
import { resolvePaths, type JlcodePaths } from "../src/paths";
import type { SessionManager } from "../src/session/manager";
import type { QueuedMessage, SessionEvent } from "../src/session/types";

/** Commands that run the same under `sh` and `cmd.exe` (D-105 / Windows): the
 *  session-level logic here is queue and parking, not shell behaviour, so it
 *  runs everywhere. Double quotes outside, single inside, survive both. */
// Plain quotes, not JSON.stringify: that would double Windows' backslashes.
const NODE = `"${process.execPath}"`;
const js = (code: string): string => `${NODE} -e "${code}"`;
/** Waits for stdin to end, then exits 0 — `cat` without the output. */
const CAT = js("process.stdin.resume()");
/** Runs until killed. */
const SLEEP = js("setTimeout(()=>{},30000)");
const SLEEP2 = js("setTimeout(()=>{},31000)");
/** Prints one line, then behaves as CAT. */
const ECHO_CAT = js("console.log('out');process.stdin.resume()");
/** Waits for stdin to end, then exits 3. */
const CAT_EXIT3 = js("process.stdin.on('end',()=>process.exit(3)).resume()");
const esc = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let root: string;
let data: string;
let store: ProcessStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-p10c-ws-"));
  data = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-p10c-data-"));
  store = new ProcessStore(path.join(data, "processes"));
});

const opened: Session[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.disposeProcesses();
  store.stop();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(data, { recursive: true, force: true });
});

const config = (id = "cfg_x", model = "m"): ModelConfig => ({
  id,
  name: id,
  openRouterKey: "sk",
  model,
  defaultMode: "code",
  defaultApproval: "full-auto",
  environment: { turnTimestamps: false },
  createdAt: "",
  updatedAt: "",
});

const toolCall = (name: string, args: unknown): StreamEvent[] => [
  { type: "tool_call", index: 0, id: `c_${Math.random().toString(16).slice(2)}`, name, argsDelta: JSON.stringify(args) },
  { type: "finish", reason: "tool_calls" },
];
const text = (t: string): StreamEvent[] => [
  { type: "text", delta: t },
  { type: "finish", reason: "stop" },
];
const userTexts = (req: ChatRequest): string[] =>
  req.messages.filter((m) => m.role === "user" && typeof m.content === "string").map((m) => m.content as string);
async function* hang(signal?: AbortSignal): AsyncGenerator<StreamEvent> {
  yield { type: "text", delta: "thinking" };
  await new Promise<void>((_r, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
}

/** A driver answering call N (1-based) with `script(n, req, signal)`; every
 *  request is kept. */
function scripted(script: (n: number, req: ChatRequest, signal?: AbortSignal) => AsyncGenerator<StreamEvent> | StreamEvent[]) {
  const requests: ChatRequest[] = [];
  const driver: LlmDriver = {
    async *streamChat(req, opts): AsyncGenerator<StreamEvent> {
      requests.push(req);
      yield* script(requests.length, req, opts?.signal);
    },
  };
  return { driver, requests };
}

function makeSession(driver: LlmDriver, extra: Partial<ConstructorParameters<typeof Session>[0]> = {}) {
  const reg = new TaskRegistry({ graceMs: 200 });
  const session = new Session({
    config: config(),
    driver,
    tools: new ToolRegistry([...fileTools(), runCommandTool()]),
    sandbox: new Sandbox([root]),
    processes: store,
    tasks: reg,
    mode: "code",
    approval: "full-auto",
    buildGate: (m, a) => new ModeApprovalGate(m, a, []),
    ...extra,
  });
  opened.push(session);
  const events: SessionEvent[] = [];
  session.onEvent((e) => events.push(e));
  return { session, reg, events };
}

/** The first event matching `pred`, from now on. */
const next = (s: Session, pred: (e: SessionEvent) => boolean): Promise<SessionEvent> =>
  new Promise((resolve) => {
    const off = s.onEvent((e) => {
      if (pred(e)) {
        off();
        resolve(e);
      }
    });
  });
/** Resolves once a process notice is in the queue. */
const noticeQueued = (s: Session): Promise<QueuedMessage> =>
  new Promise((resolve) => {
    const hit = () => s.queuedMessages.find((m) => m.inbound?.kind === "process");
    const found = hit();
    if (found) return resolve(found);
    const off = s.onEvent((e) => {
      const m = e.type === "queue" ? hit() : undefined;
      if (m) {
        off();
        resolve(m);
      }
    });
  });
/** Resolves with the notice text once the turn that took it in has settled. */
const noticeTurn = (s: Session): Promise<string> =>
  new Promise((resolve) => {
    let notice: string | undefined;
    s.onEvent((e) => {
      if (e.type === "user" && e.text.startsWith("[Background process")) notice ??= e.text;
      if (notice !== undefined && e.type === "settled") resolve(notice);
    });
  });
async function ended(reg: TaskRegistry, id: string): Promise<TaskView> {
  const v = await reg.whenEnded(id, 10_000);
  if (!v) throw new Error(`task ${id} did not end`);
  return v;
}
const processEntries = (s: Session) =>
  s.conversation.entries.filter((e) => e.type === "user" && e.inbound?.kind === "process") as { text: string; inbound: { from: string } }[];

/** Turn 1 launches `command` in the background and the turn ends; later calls
 *  answer by `then`. Returns once idle, with the process id. */
async function launched(command: string, then: (n: number, req: ChatRequest, signal?: AbortSignal) => AsyncGenerator<StreamEvent> | StreamEvent[] = () => text("noted"), extra?: Partial<ConstructorParameters<typeof Session>[0]>) {
  const { driver, requests } = scripted((n, req, signal) => {
    if (n === 1) return toolCall("run_command", { command, background: true });
    if (n === 2) return text("launched");
    return then(n, req, signal);
  });
  const made = makeSession(driver, extra);
  await made.session.send("go");
  const id = made.reg.all()[0]!.id;
  expect(made.session.status).toBe("idle");
  return { ...made, requests, id };
}

describe("the notice text (D-104)", () => {
  it("says how it ended, the runtime and the read call; a quiet process says so; a long command is one capped line", () => {
    const view: TaskView = { id: "task_abc", command: "npm test", startedAt: 1_000, endedAt: 135_000, status: "exited", exitCode: 1, background: true };
    expect(processNoticeText(view, 1412)).toBe(
      "[Background process task_abc ended (exited 1) after 2m 14s: $ npm test]\n" +
        'Its output (1,412 lines) stays readable: read_file(process: "task_abc") — offset: -20 for the last 20 lines; stream: "stdout" or "stderr" for one stream.',
    );
    expect(processNoticeText({ ...view, status: "killed", killReason: "user" }, 1)).toContain("ended (killed by the user)");
    expect(processNoticeText({ ...view, failedToStart: "failed to start: spawn sh ENOENT" }, 0)).toBe(
      "[Background process task_abc ended (failed to start: spawn sh ENOENT) after 2m 14s: $ npm test]\n" +
        'It wrote no output; its log is still there: read_file(process: "task_abc").',
    );
    const long = processNoticeText({ ...view, command: `cat <<EOF\n${"x".repeat(10)}\nEOF` }, 0);
    expect(long.split("\n")[0]).toBe("[Background process task_abc ended (exited 1) after 2m 14s: $ cat <<EOF …]");
    expect(processNoticeText({ ...view, command: "y".repeat(500) }, 0).split("\n")[0]!.length).toBeLessThan(300);
  });

  it("the launch text says a notice will come (the result only, no definition changed)", () => {
    expect(backgroundLaunchText("task_abc", "sleep 1")).toMatch(/\nWhen it ends you'll get a notice saying how, unless you killed it with delete_file\.$/);
  });
});

describe("a background process's end wakes an idle agent (D-104, D-88)", () => {
  it("exits on its own: one turn opens, carrying the notice; never an inbox record", async () => {
    const { session, reg, events, requests, id } = await launched(CAT);
    const turn = noticeTurn(session);
    await reg.write(id, "", true); // EOF: cat exits 0
    const notice = await turn;
    expect(notice).toMatch(new RegExp(`^\\[Background process ${id} ended \\(exited 0\\) after \\d+s: \\$ ${esc(CAT)}\\]\\n`));
    expect(notice).toContain(`read_file(process: "${id}")`);
    expect(requests).toHaveLength(3);
    expect(userTexts(requests[2]!).at(-1)).toBe(notice);
    expect(processEntries(session)).toEqual([expect.objectContaining({ text: notice, inbound: expect.objectContaining({ from: id, kind: "process" }) })]);
    expect(events.some((e) => e.type === "inbox")).toBe(false); // G12
    expect(session.queuedMessages).toEqual([]);
    expect(session.status).toBe("idle");
  });

  it("the person's Kill (the panel) sends a notice that wakes it", async () => {
    const { session, requests, id } = await launched(SLEEP);
    const turn = noticeTurn(session);
    expect(session.killTask(id)).toBe(true);
    expect(await turn).toContain(`[Background process ${id} ended (killed by the user)`);
    expect(requests).toHaveLength(3);
  });

  it("its timeout sends a notice that wakes it", async () => {
    const { driver, requests } = scripted((n) =>
      n === 1 ? toolCall("run_command", { command: SLEEP, background: true, timeout: 0.3 }) : text("ok"),
    );
    const { session, reg } = makeSession(driver);
    const turn = noticeTurn(session);
    await session.send("go");
    const id = reg.all()[0]!.id;
    expect(await turn).toContain(`[Background process ${id} ended (killed by its timeout)`);
    expect(requests).toHaveLength(3);
  });

  it("delete_file sends none — the call already said how it ended", async () => {
    const { driver, requests } = scripted((n, req) => {
      if (n === 1) return toolCall("run_command", { command: SLEEP, background: true });
      if (n === 2) return toolCall("delete_file", { process: /process (task_[0-9a-f]+)/.exec(String(req.messages.at(-1)!.content))![1] });
      return text("killed it");
    });
    const { session, reg, events } = makeSession(driver);
    await session.send("go");
    const id = reg.all()[0]!.id;
    expect(await ended(reg, id)).toMatchObject({ status: "killed", killReason: "agent" });
    expect(requests).toHaveLength(3);
    expect(session.queuedMessages).toEqual([]);
    expect(processEntries(session)).toEqual([]);
    expect(events.some((e) => e.type === "queue" && e.queue.length > 0)).toBe(false);
  });

  it("a foreground command sends none (G8)", async () => {
    const { driver, requests } = scripted((n) => (n === 1 ? toolCall("run_command", { command: "echo hi" }) : text("ok")));
    const { session, reg } = makeSession(driver);
    await session.send("go");
    await ended(reg, reg.all()[0]!.id);
    expect(requests).toHaveLength(2);
    expect(session.queuedMessages).toEqual([]);
  });

  it("mid-turn it lands at the next model call (D-52) and opens no turn of its own", async () => {
    let session!: Session;
    let reg!: TaskRegistry;
    const { driver, requests } = scripted(async function* (n) {
      if (n === 1) return yield* toolCall("run_command", { command: ECHO_CAT, background: true });
      if (n === 2) {
        // While this call is out, the process ends: its notice waits in the queue.
        const queued = noticeQueued(session);
        await reg.write(reg.all()[0]!.id, "", true);
        await queued;
        return yield* toolCall("list_dir", { processes: true });
      }
      yield* text("read it");
    });
    ({ session, reg } = makeSession(driver));
    await session.send("go");
    expect(requests).toHaveLength(3);
    const notice = userTexts(requests[2]!).at(-1)!;
    expect(notice).toMatch(new RegExp(`^\\[Background process task_[0-9a-f]+ ended \\(exited 0\\) after \\d+s: \\$ ${esc(ECHO_CAT)}\\]\\nIts output \\(1 line\\)`));
    expect(requests[2]!.messages.at(-1)).toMatchObject({ role: "user", content: notice });
    expect(session.queuedMessages).toEqual([]);
    expect(session.status).toBe("idle");
  });

  it("a spawn that fails mid-turn sends a 'failed to start' notice (R6)", async () => {
    const gone = path.join(root, "gone");
    fs.mkdirSync(gone);
    const realStat = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation(((p: fs.PathLike, o?: fs.StatSyncOptions) => {
      const st = realStat(p, o as never);
      if (p === gone) fs.rmSync(gone, { recursive: true, force: true });
      return st;
    }) as typeof fs.statSync);
    const { driver, requests } = scripted((n) => (n === 1 ? toolCall("run_command", { command: "echo never", cwd: "gone", background: true }) : text("ok")));
    const { session } = makeSession(driver);
    const turn = noticeTurn(session);
    await session.send("go");
    expect(await turn).toMatch(/^\[Background process task_[0-9a-f]+ ended \(failed to start: .+\) after \d+s: \$ echo never\]/);
    // Landed in the launching turn, or opened one of its own — either way, read once.
    expect(requests.filter((r) => userTexts(r).some((t) => t.includes("failed to start"))).length).toBeGreaterThan(0);
  });
});

describe("several processes ending at once (P10c review R1)", () => {
  /** A stand-in child: the registry only listens to its events and streams. */
  function fakeChild(): ChildProcess {
    return Object.assign(new EventEmitter(), {
      pid: 4242,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: () => true,
    }) as unknown as ChildProcess;
  }

  it("N background processes ending in the same tick on an idle session open exactly one turn carrying all N", async () => {
    const { driver, requests } = scripted(() => text("noted"));
    const { session, reg } = makeSession(driver);
    const N = 4;
    const children = Array.from({ length: N }, () => fakeChild());
    const ids = children.map((c, i) => reg.start(`job ${i}`, c, () => {}, { background: true }).id);
    const turn = noticeTurn(session);
    for (const c of children) c.emit("close", 0, null); // all end before any microtask runs
    await turn;
    expect(requests).toHaveLength(1);
    const said = userTexts(requests[0]!).filter((t) => t.startsWith("[Background process"));
    expect(said).toHaveLength(N);
    ids.forEach((id, i) => expect(said[i]).toContain(`${id} ended (exited 0)`));
    expect(session.queuedMessages).toEqual([]);
    expect(session.status).toBe("idle");
  });
});

describe("parked notices (R1 must-fix 4, R2 must-fix 2, R3–R5)", () => {
  it("'Stop and kill processes' on an idle session: parked, no turn; 'process notices waiting'; Wake opens one turn carrying it", async () => {
    const { session, reg, requests, id } = await launched(SLEEP);
    const queued = noticeQueued(session);
    session.stop("hard", { killProcesses: true });
    expect(await ended(reg, id)).toMatchObject({ status: "killed", killReason: "stop" });
    const notice = await queued;
    expect(notice).toMatchObject({ parked: true, inbound: { kind: "process", from: id } });
    expect(notice.text).toContain("ended (killed by Stop)");
    // Nothing opens a turn on it: not a delivery's startNext, not anything.
    await session.startNext();
    expect(requests).toHaveLength(2);
    expect(session.status).toBe("idle");
    expect(session.restState).toBe("owes-reply");
    expect(session.parkedWaiting).toBe("process");
    // Wake is the person's explicit act and ignores the gate (R4 must-fix 1).
    const turn = noticeTurn(session);
    const woke = session.wake();
    expect(woke.outcome).toBe("woken");
    await woke.done;
    expect(await turn).toBe(notice.text);
    expect(requests).toHaveLength(3);
    expect(userTexts(requests[2]!).at(-1)).toBe(notice.text);
    expect(session.queuedMessages).toEqual([]);
  });

  it("a parked notice rides the next turn something else opens", async () => {
    const { session, reg, requests, id } = await launched(SLEEP);
    const queued = noticeQueued(session);
    session.stop("hard", { killProcesses: true });
    await ended(reg, id);
    const notice = await queued;
    await session.send("hello");
    expect(requests).toHaveLength(3);
    const said = userTexts(requests[2]!);
    expect(said).toContain("hello");
    expect(said).toContain(notice.text);
    expect(session.queuedMessages).toEqual([]);
  });

  it("an unparked arrival opens one turn that carries the parked one too", async () => {
    const { driver, requests } = scripted((n) => {
      if (n === 1) return toolCall("run_command", { command: SLEEP, background: true });
      if (n === 2) return toolCall("run_command", { command: CAT, background: true });
      return text("ok");
    });
    const { session, reg } = makeSession(driver);
    await session.send("go");
    const [sleeper, cat] = reg.all();
    // Kill only the sleeper "by Stop" — through the registry, as Stop does.
    const first = noticeQueued(session);
    reg.kill(sleeper!.id, "stop");
    expect(await first).toMatchObject({ parked: true });
    expect(requests).toHaveLength(3);
    const turn = noticeTurn(session);
    await reg.write(cat!.id, "", true);
    await turn;
    expect(requests).toHaveLength(4);
    const said = userTexts(requests[3]!).filter((t) => t.startsWith("[Background process"));
    expect(said).toHaveLength(2);
    expect(said[0]).toContain(`${sleeper!.id} ended (killed by Stop)`);
    expect(said[1]).toContain(`${cat!.id} ended (exited 0)`);
  });

  it("a hard Stop mid-turn keeps a queued notice, parked, and announces it (R2 must-fix 2, R3 nit)", async () => {
    let session!: Session;
    let reg!: TaskRegistry;
    const { driver, requests } = scripted(async function* (n, _req, signal) {
      if (n === 1) return yield* toolCall("run_command", { command: CAT_EXIT3, background: true });
      const queued = noticeQueued(session);
      await reg.write(reg.all()[0]!.id, "", true); // it ends while this call is out
      await queued;
      yield* hang(signal);
    });
    let events: SessionEvent[];
    ({ session, reg, events } = makeSession(driver));
    const turn = session.send("go");
    await next(session, (e) => e.type === "text");
    session.setQueue([...session.queuedMessages.map((m) => ({ text: m.text })), { text: "typed while it ran" }]);
    const before = events.length;
    session.stop("hard");
    await turn;
    expect(session.status).toBe("idle");
    expect(session.queuedMessages).toEqual([expect.objectContaining({ parked: true, inbound: expect.objectContaining({ kind: "process" }) })]);
    expect(session.queuedMessages[0]!.text).toContain("ended (exited 3)");
    // The queue event after the Stop carries the kept entry, so the browser's
    // text-keyed edit doesn't drop it.
    const announced = events.slice(before).filter((e) => e.type === "queue").at(0) as Extract<SessionEvent, { type: "queue" }>;
    expect(announced.queue.map((m) => m.inbound?.kind)).toEqual(["process"]);
    // No inbox drop for an id that was never recorded (R3 nit).
    expect(events.slice(before).some((e) => e.type === "inbox-dropped")).toBe(false);
    expect(requests).toHaveLength(2);
  });

  it("…and the held-for-a-missing-model drain doesn't open a turn on it (R3 must-fix 1, R4 nit)", async () => {
    const A = config("cfg_a", "model-a");
    const B = config("cfg_b", "model-b");
    const live = new Map([
      [A.id, A],
      [B.id, B],
    ]);
    let session!: Session;
    let reg!: TaskRegistry;
    const { driver, requests } = scripted(async function* (n, _req, signal) {
      if (n === 1) return yield* toolCall("run_command", { command: CAT, background: true });
      if (n === 2) {
        const queued = noticeQueued(session);
        await reg.write(reg.all()[0]!.id, "", true); // it ends while this call is out
        await queued;
        return yield* hang(signal);
      }
      yield* text("should not be called");
    });
    ({ session, reg } = makeSession(driver, {
      lookupConfig: (id) => live.get(id),
      deriveRetarget: (c) => ({ config: c, driver, watchdogMs: 0, maxToolIterations: 50, acceptsImages: false }),
    }));
    await session.switchModel(A.id); // the branch runs under A
    const turn = session.send("go");
    await next(session, (e) => e.type === "text");
    live.delete(A.id); // the branch's model is gone…
    expect(await session.switchModel(B.id)).toBe("pending"); // …and a pick waits for the idle point
    session.stop("hard");
    await turn;
    expect(session.status).toBe("idle");
    expect(session.queuedMessages.map((m) => [m.inbound?.kind, m.parked])).toEqual([["process", true]]);
    expect(requests).toHaveLength(2); // no turn opened
  });

  it("an idle session whose model is gone: a picked model's held drain skips a parked-only queue", async () => {
    const A = config("cfg_a", "model-a");
    const B = config("cfg_b", "model-b");
    const live = new Map([
      [A.id, A],
      [B.id, B],
    ]);
    const { driver, requests } = scripted((n) => (n === 1 ? toolCall("run_command", { command: SLEEP, background: true }) : text("ok")));
    const { session, reg } = makeSession(driver, {
      lookupConfig: (id) => live.get(id),
      deriveRetarget: (c) => ({ config: c, driver, watchdogMs: 0, maxToolIterations: 50, acceptsImages: false }),
    });
    await session.switchModel(A.id);
    await session.send("go");
    const queued = noticeQueued(session);
    session.stop("hard", { killProcesses: true });
    await ended(reg, reg.all()[0]!.id);
    await queued;
    live.delete(A.id);
    expect(session.modelMissing).toBeDefined();
    expect(await session.switchModel(B.id)).toBe("applied");
    expect(requests).toHaveLength(2);
    expect(session.queuedMessages).toHaveLength(1);
  });

  it("a process that ends while a Stop is unwinding the turn is parked too", async () => {
    let session!: Session;
    let reg!: TaskRegistry;
    const { driver, requests } = scripted(async function* (n, _req, signal) {
      if (n === 1) return yield* toolCall("run_command", { command: CAT, background: true });
      yield { type: "text", delta: "thinking" };
      // The Stop lands, then the process ends before the loop has unwound.
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
      const id = reg.all()[0]!.id;
      const q = noticeQueued(session);
      await reg.write(id, "", true);
      await q;
      throw new DOMException("aborted", "AbortError");
    });
    ({ session, reg } = makeSession(driver));
    const turn = session.send("go");
    await next(session, (e) => e.type === "text");
    session.stop("hard");
    await turn;
    expect(session.status).toBe("idle");
    expect(session.queuedMessages.map((m) => [m.inbound?.kind, m.parked])).toEqual([["process", true]]);
    expect(requests).toHaveLength(2);
  });
});

describe("a disposed thread is silent (R2 must-fix 1)", () => {
  it("closing a thread with a running background process queues no notice, then or later", async () => {
    const { session, reg, events, id } = await launched(SLEEP);
    const before = events.length;
    const end = new Promise<void>((resolve) => reg.onEvent((e) => e.type === "task-end" && resolve()));
    session.disposeProcesses();
    await end;
    expect(reg.get(id)).toMatchObject({ status: "killed", killReason: "stop" });
    expect(session.queuedMessages).toEqual([]);
    expect(events.slice(before).some((e) => e.type === "queue")).toBe(false);
  });
});

describe("the fake driver's default process is the newest launch (P10b review nit)", () => {
  it("kill: after a listing names an older id targets the newest process", async () => {
    const { session, reg } = makeSession(fakeAgentDriver());
    await session.send(`bg: ${SLEEP}`);
    await session.send(`bg: ${SLEEP2}`);
    const [older, newer] = reg.all();
    // A listing prints both ids — the older one last if it sorts there; the
    // default must still be the newest launch.
    await session.send(`procs:`);
    await session.send(`run: echo ${older!.id}`);
    await session.send("kill:");
    expect(await ended(reg, newer!.id)).toMatchObject({ killReason: "agent" });
    expect(reg.get(older!.id)).toMatchObject({ status: "running" });
  });
});

// ---------------------------------------------------------------------------
// Through the server and a real agent tree: the wording `list_agents` gives a
// parent (R5), and a closed child reopened at once carries no notice (R2).

describe("through the server: wording and close (R2 must-fix 1, R5)", () => {
  const OPUS = "anthropic/claude-opus-5";
  let dir: string;
  let paths: JlcodePaths;
  let workspace: string;
  let convStore: ConversationStore;
  let catalog: ModelCatalog;
  const saved = { config: process.env.JLCODE_CONFIG_DIR, data: process.env.JLCODE_DATA_DIR };
  let live: SessionManager | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-p10c-srv-"));
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
  /** A root that spawned agent-1, which launched a background process. */
  async function childWithProcess() {
    const server = makeServer();
    const res = await post(server.app, "/chat", { text: `spawn: bg: ${SLEEP}` });
    const root = server.manager.get(res.json.sessionId)!;
    await server.agents.idle();
    const child = () => server.manager.list().find((s) => s.agentInfo?.name === "agent-1");
    await until(server.manager, () => child()?.status === "idle" && root.status === "idle");
    expect(child()!.taskList).toHaveLength(1);
    // The child's own "finished" notice went to the root; clear it so the
    // root's queue is only what this test makes.
    await post(server.app, `/session/${root.id}/queue`, { queue: [] });
    return { ...server, root, child: child()! };
  }

  it("a child left with only parked process notices reads 'has process notices waiting' to its parent", async () => {
    const { app, agents, root, child } = await childWithProcess();
    expect(agents.listAgents(root, false)).not.toContain("process notices");
    const queued = noticeQueued(child);
    expect((await post(app, `/session/${root.id}/stop`, { killProcesses: true })).status).toBe(200);
    await queued;
    expect(child.status).toBe("idle");
    expect(child.restState).toBe("owes-reply");
    expect(agents.listAgents(root, false)).toContain("agent-1");
    expect(agents.listAgents(root, false)).toContain("has process notices waiting");
  });

  it("/chat on a running session is a 409 with code 'busy' and the session to queue to (P10c review R2)", async () => {
    const server = makeServer();
    const first = post(server.app, "/chat", { text: "hang: think" });
    await until(server.manager, () => server.manager.list().some((s) => s.status === "running"));
    const session = server.manager.list()[0]!;
    const busy = await post(server.app, "/chat", { sessionId: session.id, text: "while you think" });
    expect(busy.status).toBe(409);
    expect(busy.json).toMatchObject({ code: "busy", sessionId: session.id });
    // Reached by conversation alone (a stale tab's fallback): the busy body
    // names the live session it attached to.
    const attached = await post(server.app, "/chat", { sessionId: "sess_gone", conversationId: session.conversation.id, text: "again" });
    expect(attached.status).toBe(409);
    expect(attached.json).toMatchObject({ code: "busy", sessionId: session.id });
    session.stop("hard");
    await first;
    expect(session.status).toBe("idle");
  });

  it("closing a child with a running process and reopening it at once: no process notice anywhere (R2 must-fix 1)", async () => {
    const { agents, root, child } = await childWithProcess();
    const rootId = root.conversation.id;
    const agentId = child.conversation.id.slice(agentConversationId(rootId, "").length);
    const reg = (child as unknown as { tasks: TaskRegistry }).tasks;
    const ends: TaskView[] = [];
    reg.onEvent((e) => e.type === "task-end" && ends.push(e.task));
    agents.closeChild(root, "agent-1");
    expect(ends).toHaveLength(1); // dispose finished it, synchronously
    expect(child.queuedMessages.filter((m) => m.inbound?.kind === "process")).toEqual([]);
    const back = agents.reopen(root, agentId);
    expect(back.queuedMessages.filter((m) => m.inbound?.kind === "process")).toEqual([]);
    expect(back.conversation.inbox ?? []).toEqual([]);
    expect(root.queuedMessages.filter((m) => m.inbound?.kind === "process")).toEqual([]);
  });
});
