/**
 * P10c in the browser (D-104; plan reviews R1 G13, R4, R5): the process notice
 * card, the status wording for parked notices, what plain Stop and "Stop and
 * kill processes" are enabled by, and the stdin approval read aloud. Plus the
 * two server-side nits folded into this slice: `killAll`/`killForeground`
 * finish their loop past a throwing listener, and the stdin preview flags a
 * child that exited in its grace.
 *
 * Tier-0, pure functions and fake children; nothing spawns.
 */
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { agentCard, agentStatus, isForeground, parkedWaiting, subtreeWorking, treeHasProcesses } from "../web/src/agents";
import { newSlice, type SessionSlice } from "../web/src/session-state";
import { speechFor } from "../web/src/tts";
import type { AgentInfo, EntryView, QueuedMessage, TaskView } from "../web/src/api";
import { ApiError, QueueFallbackError, isBusyRefusal, sendOrQueue } from "../web/src/api";
import { TaskRegistry, processNoticeText, type TaskView as ServerTaskView } from "../src/tools/task-registry";
import { fileTools } from "../src/tools/file-tools";
import { Sandbox } from "../src/tools/sandbox";

const info = (name: string, depth: number, parent: string | null): AgentInfo => ({ name, depth, parentSessionId: parent, rootSessionId: "r" });
const slice = (id: string, agent: AgentInfo | null, patch: Partial<SessionSlice> = {}): SessionSlice => ({ ...newSlice(id), agent, ...patch });
const task = (id: string, background: boolean): TaskView => ({ id, command: "sleep 30", startedAt: 0, status: "running", ...(background ? { background: true } : {}) });
const notice = (from: string, parked: boolean, kind: "process" | "finished" = "process"): QueuedMessage => ({
  id: `q_${from}`,
  text: "…",
  inbound: { id: `m_${from}`, from, kind },
  ...(parked ? { parked: true } : {}),
});

describe("the process notice card (P10c)", () => {
  const entry = (text: string, from = "task_0123456789ab"): EntryView =>
    ({ id: "e1", parent: null, type: "user", text, inbound: { id: "m1", from, kind: "process" } }) as EntryView;
  const view: ServerTaskView = { id: "task_0123456789ab", command: "npm test", startedAt: 0, endedAt: 4_000, status: "exited", exitCode: 0, background: true };

  it("reads the server's own words back: head, how it ended and how long, the command", () => {
    expect(agentCard(entry(processNoticeText(view, 12)))).toEqual({
      kind: "process",
      peer: null,
      head: "process ended",
      detail: "task_0123456789ab · exited 0 · 4s",
      body: "$ npm test",
    });
  });

  it("a kill, a non-zero exit or a failed start is warn-toned", () => {
    for (const v of [
      { ...view, status: "killed" as const, killReason: "user" as const },
      { ...view, exitCode: 2 },
      { ...view, failedToStart: "failed to start: spawn sh ENOENT (no such file)" },
    ]) {
      const card = agentCard(entry(processNoticeText(v, 0)))!;
      expect(card).toMatchObject({ kind: "process", tone: "warn" });
    }
    expect(agentCard(entry(processNoticeText({ ...view, failedToStart: "failed to start: x (y)" }, 0)))!.detail).toBe(
      "task_0123456789ab · failed to start: x (y) · 4s",
    );
  });

  it("text it can't parse still renders as a process card, never as the person", () => {
    expect(agentCard(entry("something else"))).toMatchObject({ kind: "process", head: "process ended", body: "something else", peer: null });
  });
});

describe("parked notices read as waiting, not owed (R5)", () => {
  it("parkedWaiting: all parked process notices, all parked mixed, or not parked", () => {
    expect(parkedWaiting([])).toBeNull();
    expect(parkedWaiting([notice("t1", true), notice("t2", true)])).toBe("process");
    expect(parkedWaiting([notice("t1", true), notice("agent-1", true, "finished")])).toBe("parked");
    expect(parkedWaiting([notice("t1", true), notice("t2", false)])).toBeNull();
    expect(parkedWaiting([{ id: "q", text: "typed" }, notice("t1", true)])).toBe("process"); // the person's words are not owed
  });

  it("the dot keeps Wake on offer but says what is waiting", () => {
    expect(agentStatus(slice("r", null, { rest: "owes-reply", queue: [notice("t1", true)] }), false)).toEqual({ dot: "wake", label: "process notices waiting" });
    expect(agentStatus(slice("r", null, { rest: "owes-reply", queue: [notice("a", true, "finished")] }), false)).toEqual({ dot: "wake", label: "notices waiting" });
    expect(agentStatus(slice("r", null, { rest: "owes-reply", queue: [notice("t1", false)] }), false)).toEqual({ dot: "wake", label: "owes a reply" });
  });
});

describe("background processes don't make a pane busy (D-104, R4)", () => {
  it("a foreground command is 'task running'; a background one at rest is idle, 'process running'", () => {
    expect(agentStatus(slice("r", null, { tasks: [task("t1", false)] }), false)).toEqual({ dot: "busy", label: "task running" });
    expect(agentStatus(slice("r", null, { tasks: [task("t1", true)] }), false)).toEqual({ dot: "idle", label: "process running" });
    expect(isForeground(task("t", false))).toBe(true);
    expect(isForeground(task("t", true))).toBe(false);
  });

  it("plain Stop's subtree check ignores background processes; the kill item's check finds them, here or below (G13)", () => {
    const tree = (patch: Record<string, Partial<SessionSlice>>) => [
      slice("r", info("root", 0, null), patch.r),
      slice("a1", info("agent-1", 1, "r"), patch.a1),
      slice("a2", info("agent-2", 2, "a1"), patch.a2),
    ];
    const deepBg = tree({ a2: { tasks: [task("t", true)] } });
    expect(subtreeWorking(deepBg, "r")).toBe(false);
    expect(treeHasProcesses(deepBg, "r")).toBe(true);
    expect(treeHasProcesses(deepBg, "a2")).toBe(true);
    const deepFg = tree({ a2: { tasks: [task("t", false)] } });
    expect(subtreeWorking(deepFg, "r")).toBe(true);
    expect(treeHasProcesses(deepFg, "r")).toBe(false);
    expect(treeHasProcesses(tree({ r: { tasks: [task("t", true)] } }), "r")).toBe(true);
    expect(treeHasProcesses(tree({ r: { tasks: [task("t", true)] } }), "a1")).toBe(false); // a parent's is not a child's
  });
});

describe("a stdin approval read aloud names the process, not an ignored path (P10b review nit)", () => {
  const stdinApproval = (preview: Record<string, unknown>) =>
    ({
      id: "a1",
      tool: "write_file",
      kind: "command",
      reason: "input to a running process",
      args: { process: "task_0123456789ab", content: "yes\n", path: "decoy.md", command: "rm -rf /" },
      preview: { kind: "stdin", process: "task_0123456789ab", body: "yes\n", bytes: 4, close: false, ...preview },
    }) as unknown as SessionSlice["pendingApproval"];

  it("says input, to which process and command — never the decoy args", () => {
    const [said] = speechFor(slice("r", null, { pendingApproval: stdinApproval({ command: "python3 ask.py" }) }));
    expect(said!.text).toBe("Approval needed to send input to process task_0123456789ab, python3 ask.py.");
    expect(said!.text).not.toContain("decoy");
    expect(said!.text).not.toContain("rm -rf");
  });

  it("an EOF-only write and content-then-EOF say so", () => {
    expect(speechFor(slice("r", null, { pendingApproval: stdinApproval({ bytes: 0, body: "", close: true }) }))[0]!.text).toBe(
      "Approval needed to close the input of process task_0123456789ab.",
    );
    expect(speechFor(slice("r", null, { pendingApproval: stdinApproval({ close: true }) }))[0]!.text).toBe(
      "Approval needed to send input, then end of input, to process task_0123456789ab.",
    );
  });
});

// ---- Server-side nits folded into P10c. ----

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

describe("killAll / killForeground finish the loop past a throwing listener (P10b review nit)", () => {
  for (const which of ["killAll", "killForeground"] as const) {
    it(`${which}: every task is signalled, and the listener's error still surfaces`, () => {
      const reg = new TaskRegistry({ graceMs: 50 });
      const signalled: string[] = [];
      const ids = ["a", "b", "c"].map((n) => reg.start(`cmd ${n}`, fakeChild(), () => signalled.push(n)).id);
      reg.onEvent((e) => {
        if (e.type === "task-update") throw new Error("listener blew up");
      });
      expect(() => reg[which]("stop")).toThrow("listener blew up");
      expect(signalled).toEqual(["a", "b", "c"]);
      for (const id of ids) expect(reg.get(id)).toMatchObject({ status: "killed", killReason: "stop" });
      reg.dispose();
    });
  }
});

describe("the stdin preview flags a child that exited in its grace (P10b review nit)", () => {
  it("still 'running' until it finishes, but the write will fail — and the card says so", () => {
    const reg = new TaskRegistry({ graceMs: 60_000 });
    const child = fakeChild();
    const { id } = reg.start("read x", child, () => {}, { background: true });
    (child.stdout as PassThrough).write("partial"); // a stream still open: the grace waits
    child.emit("exit", 0, null);
    expect(reg.get(id)).toMatchObject({ status: "running" });
    expect(reg.childHasExited(id)).toBe(true);
    const write = fileTools()[1]!;
    const preview = write.preview!({ process: id, content: "hi\n" }, { sandbox: new Sandbox([process.cwd()]), tasks: reg });
    expect(preview).toMatchObject({ kind: "stdin", error: `process ${id} has exited — this write will fail` });
    reg.dispose();
    expect(reg.childHasExited(id)).toBe(false); // finished now: the ordinary "has ended" applies
  });
});

describe("a send that finds the session busy is queued, not lost (P10c review R1)", () => {
  const busy = () => new ApiError("session is busy; queue the message instead", 409, { error: "busy…", code: "busy" });
  const missing = () => new ApiError("model gone", 409, { code: "model-config-missing" });

  it("sends when it can", async () => {
    const queued: string[] = [];
    const out = await sendOrQueue("s1", "hi", {}, { send: async () => ({ sessionId: "s1" }), queue: async (_id, t) => void queued.push(t) });
    expect(out).toEqual({ sessionId: "s1", queued: false });
    expect(queued).toEqual([]);
  });

  it("a busy refusal (a notice opened a turn first) queues the same text", async () => {
    const queued: [string, string][] = [];
    const out = await sendOrQueue("s1", "hello", {}, {
      send: async () => {
        throw busy();
      },
      queue: async (id, t) => void queued.push([id, t]),
    });
    expect(out).toEqual({ sessionId: "s1", queued: true });
    expect(queued).toEqual([["s1", "hello"]]);
  });

  it("queues to the session the refusal names (an attached live one), and reports it", async () => {
    const queued: [string, string][] = [];
    const out = await sendOrQueue("s_stale", "hello", { conversationId: "cv_1" }, {
      send: async () => {
        throw new ApiError("busy", 409, { code: "busy", sessionId: "s_live" });
      },
      queue: async (id, t) => void queued.push([id, t]),
    });
    expect(out).toEqual({ sessionId: "s_live", queued: true });
    expect(queued).toEqual([["s_live", "hello"]]);
  });

  it("a failed queue after it is a QueueFallbackError (the caller gives the text back); other refusals pass through untouched", async () => {
    await expect(
      sendOrQueue("s1", "hello", {}, {
        send: async () => {
          throw busy();
        },
        queue: async () => {
          throw new Error("network down");
        },
      }),
    ).rejects.toBeInstanceOf(QueueFallbackError);
    const queued: string[] = [];
    await expect(
      sendOrQueue("s1", "hello", {}, {
        send: async () => {
          throw missing();
        },
        queue: async (_id, t) => void queued.push(t),
      }),
    ).rejects.toMatchObject({ body: { code: "model-config-missing" } });
    expect(queued).toEqual([]); // only "busy" queues
    expect(isBusyRefusal(missing())).toBe(false);
    expect(isBusyRefusal(new ApiError("busy", 409, {}))).toBe(false); // keyed off code, not text
  });
});
