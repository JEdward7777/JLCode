/**
 * Phase 10, slice P10a (D-104, D-105; plan reviews R1–R7): process output on
 * disk, its owner and sweep, the one task-end lifecycle, and reading a log
 * through `read_file(process:)` — plus negative offsets for every `read_file`,
 * the foreground truncation note, the fence's read-only process directory, and
 * the per-platform kill.
 *
 * Real children throughout where the lifecycle is the point: the defects R4–R6
 * found (a daemon holding the pipe, a spawn that never `exit`s, a grace that
 * outlives dispose) only exist with real pipes. Commands are POSIX `sh`; the
 * Windows branch of the kill is covered by the platform-mocked unit tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Sandbox } from "../src/tools/sandbox";
import { TaskRegistry, describeState, type TaskView } from "../src/tools/task-registry";
import { ProcessStore, HEARTBEAT_FILE } from "../src/tools/process-store";
import { runCommandTool, MAX_OUTPUT } from "../src/tools/shell-tool";
import { fileTools } from "../src/tools/file-tools";
import { killTree, shellSpawnOptions } from "../src/tools/kill-tree";
import { ToolRegistry } from "../src/tools/registry";
import { Session } from "../src/session/session";
import { AgentCoordinator } from "../src/session/agents";
import type { ToolContext } from "../src/tools/types";
import type { LlmDriver, StreamEvent } from "../src/llm/types";
import type { ModelConfig } from "../src/config/types";
import type { ApprovalRequest } from "../src/session/types";

const posix = process.platform !== "win32";

let root: string; // the workspace
let data: string; // stands in for the data dir
let store: ProcessStore;
let tasks: TaskRegistry;
let ctx: ToolContext;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-p10a-ws-"));
  data = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-p10a-data-"));
  store = new ProcessStore(path.join(data, "processes"));
  tasks = new TaskRegistry({ dir: () => store.lease("cv_test"), graceMs: 200 });
  ctx = { sandbox: new Sandbox([root]), tasks };
});
afterEach(() => {
  tasks.dispose();
  store.stop();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(data, { recursive: true, force: true });
});

const run = (args: Record<string, unknown>) => runCommandTool().execute(args, ctx);
const read = (args: Record<string, unknown>) => fileTools()[0]!.execute(args, ctx);

async function until(pred: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Start a real child straight on the registry, as `run_command` does. */
function startRaw(command: string, opts: { background?: boolean; timeoutMs?: number } = {}): {
  id: string;
  child: ChildProcess;
} {
  const child = spawn(command, shellSpawnOptions(root));
  const { id } = tasks.start(command, child, () => killTree(child), opts);
  return { id, child };
}
const view = (id: string): TaskView => tasks.get(id)!;
const ended = (id: string) => view(id).status !== "running";
const procDir = (id: string) => path.join(store.dirFor("cv_test"), id);

describe("output on disk, for every task (D-104)", () => {
  it.skipIf(!posix)("a foreground command writes combined, stdout and stderr logs under processes/<conv>/<id>/", async () => {
    const res = await run({ command: "echo out1; echo err1 1>&2; echo out2" });
    expect(res.content).toContain("[exit 0]");
    const [t] = tasks.all();
    const dir = procDir(t!.id);
    expect(fs.readFileSync(path.join(dir, "stdout.log"), "utf8")).toBe("out1\nout2\n");
    expect(fs.readFileSync(path.join(dir, "stderr.log"), "utf8")).toBe("err1\n");
    expect(fs.readFileSync(path.join(dir, "combined.log"), "utf8").split("\n").sort()).toEqual(["", "err1", "out1", "out2"]);
    // The heartbeat sits beside the process directories, one per conversation.
    expect(fs.existsSync(path.join(store.dirFor("cv_test"), HEARTBEAT_FILE))).toBe(true);
  });

  it.skipIf(!posix)("an untruncated foreground result is byte-identical to before (G7)", async () => {
    const res = await run({ command: "printf 'a\\nb'" });
    expect(res.content).toBe("a\nb\n[exit 0]");
  });

  it("a registry with no store writes to a private temp dir, made on the first task and removed on dispose (G3)", async () => {
    const bare = new TaskRegistry();
    const res = await runCommandTool().execute({ command: "echo hi" }, { sandbox: new Sandbox([root]), tasks: bare });
    expect(res.content).toContain("hi");
    const log = bare.log(bare.all()[0]!.id)!;
    expect(log.file.startsWith(os.tmpdir())).toBe(true);
    expect(fs.readFileSync(log.file, "utf8")).toBe("hi\n");
    bare.dispose();
    // (Asserted on this registry's own dir: a global tmp count races the test
    // files running beside this one.)
    expect(fs.existsSync(path.dirname(path.dirname(log.file)))).toBe(false);
  });
});

describe("the ProcessStore: heartbeat and sweep (R1 G2)", () => {
  it("writes a heartbeat at lease, touches it on its interval, and removes it (and the empty dir) on release", async () => {
    const s = new ProcessStore(path.join(data, "hb"), { heartbeatMs: 20 });
    const lease = s.lease("cv_a");
    const hb = path.join(lease.path, HEARTBEAT_FILE);
    const first = fs.readFileSync(hb, "utf8");
    await until(() => fs.readFileSync(hb, "utf8") !== first, 2000);
    // Two holders: the directory stays until the last lets go.
    const second = s.lease("cv_a");
    lease.release();
    expect(fs.existsSync(hb)).toBe(true);
    second.release();
    expect(fs.existsSync(lease.path)).toBe(false);
    s.stop();
  });

  it("the sweep removes a stale owner's process dirs, keeps a live owner's, and touches nothing else", () => {
    const base = path.join(data, "sweep");
    const now = Date.now();
    const s = new ProcessStore(base, { now: () => now });
    const make = (conv: string, beatAgeMs: number | undefined, dirAgeMs = 0) => {
      const dir = path.join(base, conv);
      fs.mkdirSync(path.join(dir, "task_1"), { recursive: true });
      fs.writeFileSync(path.join(dir, "task_1", "combined.log"), "x");
      if (beatAgeMs !== undefined) {
        const hb = path.join(dir, HEARTBEAT_FILE);
        fs.writeFileSync(hb, "");
        const t = new Date(now - beatAgeMs);
        fs.utimesSync(hb, t, t);
      }
      const d = new Date(now - dirAgeMs);
      fs.utimesSync(dir, d, d);
      return dir;
    };
    // Two owners: one whose server died 11 minutes ago, one beating now.
    const stale = make("cv_stale", 11 * 60_000);
    const live = make("cv_live", 30_000);
    // No heartbeat at all: live while the directory itself is fresh.
    const fresh = make("cv_nobeat_fresh", undefined, 60_000);
    const old = make("cv_nobeat_old", undefined, 20 * 60_000);
    // A stale owner's directory that holds something that isn't a process dir.
    const foreign = make("cv_stale_foreign", 11 * 60_000);
    fs.writeFileSync(path.join(foreign, "notes.txt"), "not ours");
    fs.utimesSync(foreign, new Date(now - 20 * 60_000), new Date(now - 20 * 60_000));
    // A stray file in processes/ itself.
    fs.writeFileSync(path.join(base, "README"), "leave me");

    const swept = s.sweep();
    expect(swept.sort()).toEqual([foreign, old, stale].sort());
    expect(fs.existsSync(stale)).toBe(false); // emptied → removed
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(path.join(live, "task_1", "combined.log"))).toBe(true);
    expect(fs.existsSync(path.join(fresh, "task_1"))).toBe(true);
    expect(fs.existsSync(path.join(foreign, "task_1"))).toBe(false);
    expect(fs.readFileSync(path.join(foreign, "notes.txt"), "utf8")).toBe("not ours");
    expect(fs.readFileSync(path.join(base, "README"), "utf8")).toBe("leave me");
  });

  it("the sweep looks again just before deleting: a peer that beats in between keeps its output (review R1)", () => {
    const base = path.join(data, "race");
    const s = new ProcessStore(base);
    const dir = path.join(base, "cv_waking");
    fs.mkdirSync(path.join(dir, "task_1"), { recursive: true });
    const hb = path.join(dir, HEARTBEAT_FILE);
    fs.writeFileSync(hb, "");
    const old = new Date(Date.now() - 11 * 60_000);
    fs.utimesSync(hb, old, old);
    // The peer's heartbeat lands between the sweep's first look and its delete.
    const realReaddir = fs.readdirSync;
    vi.spyOn(fs, "readdirSync").mockImplementation(((p: fs.PathLike, o?: unknown) => {
      const out = (realReaddir as (...a: unknown[]) => unknown)(p, o);
      if (p === dir) fs.writeFileSync(hb, String(Date.now()));
      return out;
    }) as typeof fs.readdirSync);
    expect(s.sweep()).toEqual([]);
    expect(fs.existsSync(path.join(dir, "task_1"))).toBe(true);
  });

  it("the sweep never touches a directory this store owns, and a missing base is fine", () => {
    const base = path.join(data, "owned");
    const later = Date.now() + 60 * 60_000; // an hour on: everything looks stale
    const s = new ProcessStore(base, { now: () => later });
    expect(s.sweep()).toEqual([]);
    const lease = s.lease("cv_mine");
    expect(s.sweep()).toEqual([]);
    expect(fs.existsSync(lease.path)).toBe(true);
    lease.release();
    s.stop();
  });
});

describe("the task-end lifecycle (R5/R6)", () => {
  /** A child with real streams and no process: events fire when the test says. */
  function fakeChild(): ChildProcess {
    return Object.assign(new EventEmitter(), {
      pid: 4242,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: () => true,
    }) as unknown as ChildProcess;
  }

  it("a task-end listener that throws doesn't skip seal: every fd is still closed once (review R1)", () => {
    const closeSpy = vi.spyOn(fs, "closeSync");
    const openSpy = vi.spyOn(fs, "openSync");
    tasks.onEvent((e) => {
      if (e.type === "task-end") throw new Error("listener blew up");
    });
    const child = fakeChild();
    const { id } = tasks.start("fake", child, () => {});
    const fds = openSpy.mock.results.map((r) => r.value as number);
    expect(fds).toHaveLength(3);
    expect(() => child.emit("close", 0, null)).toThrow("listener blew up");
    expect(view(id).status).toBe("exited");
    for (const fd of fds) expect(closeSpy.mock.calls.filter((c) => c[0] === fd)).toHaveLength(1);
    // Sealed: a late write is a no-op, not a write to a closed (or reused) fd.
    expect(() => child.stdout!.emit("data", Buffer.from("late\n"))).not.toThrow();
  });

  it("dispose seals past a throwing listener too, and still removes the output (review R1)", () => {
    const closeSpy = vi.spyOn(fs, "closeSync");
    const openSpy = vi.spyOn(fs, "openSync");
    tasks.onEvent(() => {
      throw new Error("listener blew up");
    });
    const child = fakeChild();
    let id = "";
    expect(() => (id = tasks.start("fake", child, () => {}).id)).toThrow(); // task-start throws, after registering
    const fds = openSpy.mock.results.map((r) => r.value as number);
    expect(() => tasks.dispose()).not.toThrow();
    for (const fd of fds) expect(closeSpy.mock.calls.filter((c) => c[0] === fd)).toHaveLength(1);
    expect(fs.existsSync(store.dirFor("cv_test"))).toBe(false);
    expect(id).toBe("");
  });

  it.skipIf(!posix)("close always ends a task: a spawn that fails (cwd gone after the fence check) ends 'failed to start', every fd closed once", async () => {
    const gone = path.join(root, "gone");
    fs.mkdirSync(gone);
    const closeSpy = vi.spyOn(fs, "closeSync");
    const openSpy = vi.spyOn(fs, "openSync");
    // The fence and the stat pass; the directory vanishes before spawn.
    const realStat = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation(((p: fs.PathLike, o?: fs.StatSyncOptions) => {
      const st = realStat(p, o as never);
      if (p === gone) fs.rmSync(gone, { recursive: true, force: true });
      return st;
    }) as typeof fs.statSync);
    const res = await run({ command: "echo never", cwd: "gone" });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/spawn failed|failed to start/);
    const [t] = tasks.all();
    await until(() => ended(t!.id));
    expect(t).toBeDefined();
    expect(view(t!.id).failedToStart).toMatch(/^failed to start: /);
    expect(describeState(view(t!.id))).toMatch(/^failed to start: /);
    expect(tasks.list()).toHaveLength(0);
    const logFds = openSpy.mock.results
      .filter((r, i) => String(openSpy.mock.calls[i]![0]).startsWith(procDir(t!.id)))
      .map((r) => r.value as number);
    expect(logFds).toHaveLength(3);
    for (const fd of logFds) expect(closeSpy.mock.calls.filter((c) => c[0] === fd)).toHaveLength(1);
  });

  it.skipIf(!posix)("a log that can't be opened (EMFILE) is a failed start: the child is killed, nothing leaks", async () => {
    const realOpen = fs.openSync;
    let n = 0;
    const closeSpy = vi.spyOn(fs, "closeSync");
    vi.spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p).endsWith(".log") && ++n === 2) throw Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
      return (realOpen as (...a: unknown[]) => number)(p, ...rest);
    }) as typeof fs.openSync);
    const res = await run({ command: "sleep 30" });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/failed to start: could not open its log \(EMFILE/);
    const [t] = tasks.all();
    expect(view(t!.id).status).toBe("exited");
    expect(closeSpy).toHaveBeenCalledTimes(1); // the one fd that did open
  });

  it.skipIf(!posix)("records the signal at exit: an OOM-style SIGKILL reads 'killed by SIGKILL', not 'exited null'", async () => {
    const res = await run({ command: "kill -9 $$" });
    expect(res.content).toContain("[killed by SIGKILL]");
    const [t] = tasks.all();
    expect(view(t!.id).signal).toBe("SIGKILL");
    expect(describeState(view(t!.id))).toBe("killed by SIGKILL");
  });

  it.skipIf(!posix)("a background task ends on exit after its drain: the last line lands, a daemon's late line never does, nothing throws (R4)", async () => {
    const { id } = startRaw("echo last; (sleep 1; echo late) &", { background: true });
    await until(() => ended(id));
    expect(view(id).status).toBe("exited");
    expect(view(id).exitCode).toBe(0);
    const file = tasks.log(id)!.file;
    expect(fs.readFileSync(file, "utf8")).toBe("last\n");
    await pause(1300); // the daemon has now printed "late" into a sealed sink
    expect(fs.readFileSync(file, "utf8")).toBe("last\n");
  });

  it.skipIf(!posix)("dispose during the grace: nothing throws, each fd is closed exactly once, the grace firing later touches nothing (R5)", async () => {
    const closeSpy = vi.spyOn(fs, "closeSync");
    const openSpy = vi.spyOn(fs, "openSync");
    // Event-driven (review R1): the grace is far too long to expire on its own,
    // and the test fires its callback by hand after dispose.
    const set = vi.spyOn(globalThis, "setTimeout");
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const slow = new TaskRegistry({ dir: () => store.lease("cv_grace"), graceMs: 876_543 });
    const child = spawn("echo up; sleep 30 &", shellSpawnOptions(root));
    const { id } = slow.start("x", child, () => killTree(child), { background: true });
    const fds = openSpy.mock.results.map((r) => r.value as number);
    expect(fds).toHaveLength(3);
    // Exited, and the daemon holds the pipe → in its grace.
    await until(() => set.mock.calls.some((c) => c[1] === 876_543));
    const at = set.mock.calls.findIndex((c) => c[1] === 876_543);
    const graceFire = set.mock.calls[at]![0] as () => void;
    expect(slow.get(id)!.status).toBe("running");
    expect(() => slow.dispose()).not.toThrow();
    expect(slow.get(id)!.status).not.toBe("running");
    expect(clear).toHaveBeenCalledWith(set.mock.results[at]!.value);
    expect(() => graceFire()).not.toThrow(); // a grace arriving after dispose touches nothing
    for (const fd of fds) expect(closeSpy.mock.calls.filter((c) => c[0] === fd)).toHaveLength(1);
    expect(fs.existsSync(store.dirFor("cv_grace"))).toBe(false);
  });

  it.skipIf(!posix)("a flip to background on a child that already exited ends the task at once, exit 0 (R5, H-31's cmd &)", async () => {
    const { id, child } = startRaw("echo x; sleep 30 &");
    await until(() => child.exitCode !== null);
    await pause(50);
    expect(view(id).status).toBe("running"); // foreground: waiting on close, which the daemon blocks
    expect(tasks.toBackground(id)).toBe(true);
    await until(() => ended(id));
    expect(view(id)).toMatchObject({ status: "exited", exitCode: 0, background: true });
    // The finished task's daemon is not dispose's to kill (R5 re-signals only
    // tasks still in their grace), so the test reaps its own.
    killTree(child);
  });

  it.skipIf(!posix)("a kill after the child exited re-signals the group but keeps the recorded exit (R6)", async () => {
    const { id, child } = startRaw("echo x; sleep 30 &");
    await until(() => child.exitCode !== null);
    expect(tasks.kill(id, "user")).toBe(true); // takes the daemon down → close fires
    await until(() => ended(id));
    expect(view(id).status).toBe("exited");
    expect(view(id).exitCode).toBe(0);
    expect(view(id).killReason).toBeUndefined();
  });

  it.skipIf(!posix)("the per-call timeout is cleared at finished, whichever path got there", async () => {
    // Event-driven (review R1): catch the timer itself rather than racing it.
    const set = vi.spyOn(globalThis, "setTimeout");
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const { id } = startRaw("echo quick", { timeoutMs: 987_654 });
    const at = set.mock.calls.findIndex((c) => c[1] === 987_654);
    expect(at).toBeGreaterThanOrEqual(0);
    const timer = set.mock.results[at]!.value;
    await until(() => ended(id));
    expect(clear).toHaveBeenCalledWith(timer);
    expect(view(id).status).toBe("exited");
    expect(view(id).killReason).toBeUndefined();
  });

  it.skipIf(!posix)("dispose kills a running foreground command (reason stop), which still resolves its call, and deletes the output", async () => {
    const pending = run({ command: "echo started; sleep 30" });
    await until(() => tasks.all().length === 1 && tasks.log(tasks.all()[0]!.id)!.lines === 1);
    const id = tasks.all()[0]!.id;
    tasks.dispose();
    const res = await pending;
    expect(res.content).toContain("started");
    expect(res.content).toContain("[killed by global stop]");
    expect(view(id).killReason).toBe("stop");
    expect(fs.existsSync(procDir(id))).toBe(false);
    expect(fs.existsSync(store.dirFor("cv_test"))).toBe(false); // heartbeat gone, empty dir removed
    // A disposed registry starts nothing new.
    const after = await run({ command: "echo late" });
    expect(after.isError).toBe(true);
    expect(after.content).toMatch(/failed to start/);
  });
});

describe("read_file(process:) (D-104, R2 must-fix 3, R3)", () => {
  it.skipIf(!posix)("reads combined by default, each stream on request, with the state in the footer", async () => {
    await run({ command: "echo out1; sleep 0.05; echo err1 1>&2; sleep 0.05; echo out2" });
    const id = tasks.all()[0]!.id;
    const all = await read({ process: id });
    expect(all.content).toBe("out1\nerr1\nout2\n[lines 1–3 of 3 · exited 0]");
    expect((await read({ process: id, stream: "stdout" })).content).toBe("out1\nout2\n[lines 1–2 of 2 · exited 0]");
    expect((await read({ process: id, stream: "stderr" })).content).toBe("err1\n[lines 1–1 of 1 · exited 0]");
    // `path` is ignored when `process` is set.
    expect((await read({ process: id, path: "nonsense.txt" })).content).toContain("out1");
    expect((await read({ process: id, stream: "both" })).isError).toBe(true);
  });

  it.skipIf(!posix)("offset, limit and negative offsets work as on files; 0 and past-the-end are errors", async () => {
    await run({ command: "seq 1 10" });
    const id = tasks.all()[0]!.id;
    expect((await read({ process: id, offset: 3, limit: 2 })).content).toBe(
      "3\n4\n[lines 3–4 of 10 · exited 0 — continue with offset 5]",
    );
    expect((await read({ process: id, offset: -2 })).content).toBe("9\n10\n[lines 9–10 of 10 · exited 0]");
    expect((await read({ process: id, offset: "-3", limit: 1 })).content).toBe(
      "8\n[lines 8–8 of 10 · exited 0 — continue with offset 9]",
    );
    expect((await read({ process: id, offset: -99, limit: 1 })).content).toContain("[lines 1–1 of 10"); // clamps
    expect((await read({ process: id, offset: 0 })).isError).toBe(true);
    const past = await read({ process: id, offset: 11 });
    expect(past.isError).toBe(true);
    expect(past.content).toContain("past the end");
  });

  it.skipIf(!posix)("a running process: complete lines only, the partial line shown and marked, a tail cursor can poll", async () => {
    const pending = run({ command: "printf 'a\\nb\\npart'; sleep 30" });
    await until(() => {
      const t = tasks.all()[0];
      return !!t && tasks.log(t.id)!.lines === 2 && tasks.log(t.id)!.partial;
    });
    const id = tasks.all()[0]!.id;
    expect((await read({ process: id })).content).toBe(
      "a\nb\npart\n[lines 1–2 of 2 so far, then line 3 (still being written) · running — continue with offset 3]",
    );
    // The window doesn't reach line N: no partial line, and it doesn't count toward limit.
    expect((await read({ process: id, limit: 1 })).content).toBe(
      "a\n[lines 1–1 of 2 so far · running — continue with offset 2]",
    );
    expect((await read({ process: id, offset: 2, limit: 1 })).content).toBe(
      "b\npart\n[lines 2–2 of 2 so far, then line 3 (still being written) · running — continue with offset 3]",
    );
    // -1 counts complete lines.
    expect((await read({ process: id, offset: -1 })).content).toMatch(/^b\npart\n\[lines 2–2 of 2 so far/);
    // N+1 is legal while running: the poll.
    expect((await read({ process: id, offset: 3 })).content).toBe(
      "part\n[no new complete lines yet; line 3 (above) is still being written · running — continue with offset 3]",
    );
    expect((await read({ process: id, offset: 4 })).isError).toBe(true);
    tasks.kill(id, "user");
    await pending;
    // Ended: the partial line counts normally.
    expect((await read({ process: id })).content).toBe("a\nb\npart\n[lines 1–3 of 3 · killed by the user]");
  });

  it.skipIf(!posix)("a prompt with no newline (N = 0) is all partial; no output at all says so", async () => {
    const pending = run({ command: "printf 'Name: '; sleep 30" });
    await until(() => tasks.all().length === 1 && tasks.log(tasks.all()[0]!.id)!.partial);
    const id = tasks.all()[0]!.id;
    expect((await read({ process: id })).content).toBe(
      "Name: \n[no new complete lines yet; line 1 (above) is still being written · running — continue with offset 1]",
    );
    tasks.kill(id, "user");
    await pending;
    await run({ command: "true" });
    const silent = tasks.all()[1]!.id;
    expect((await read({ process: silent })).content).toBe("[no output · exited 0]");
  });

  it.skipIf(!posix)("streams a large log rather than reading it whole, and counts with thousands separators", async () => {
    await run({ command: "seq 1 200000" });
    const id = tasks.all()[0]!.id;
    const readSpy = vi.spyOn(fs, "readFileSync");
    expect((await read({ process: id, offset: -3 })).content).toBe(
      "199998\n199999\n200000\n[lines 199,998–200,000 of 200,000 · exited 0]",
    );
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("an unknown (or pre-restart) id is an error naming what is readable (G14)", async () => {
    const none = await read({ process: "task_nope" });
    expect(none.isError).toBe(true);
    expect(none.content).toContain('No process "task_nope"');
    expect(none.content).toContain("no processes");
    await run({ command: "echo hi" });
    const id = tasks.all()[0]!.id;
    const other = await read({ process: "task_old" });
    expect(other.content).toContain(id);
    expect(other.content).toContain("echo hi");
  });

  it("is advertised: process and stream, and path no longer required (R2 nit)", () => {
    const def = fileTools()[0]!.def.function;
    const params = def.parameters as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(params.properties)).toEqual(expect.arrayContaining(["path", "offset", "limit", "process", "stream"]));
    expect(params.required ?? []).not.toContain("path");
    expect(def.description).toMatch(/negative 'offset'/i);
    expect(def.description).toMatch(/'process'/);
  });
});

describe("the foreground truncation note names the process (D-104, G7)", () => {
  it.skipIf(!posix)("points at the first line not shown in full, and that call reads it", async () => {
    // ~190 KB of numbered lines: the byte cap lands mid-line somewhere.
    const res = await run({ command: "seq 1 30000 | sed 's/$/ abcdefghij/'" });
    const id = tasks.all()[0]!.id;
    const m = /\[output truncated at 100,000 bytes — the full output is process (\S+); read the rest with read_file\(process: "(\S+)", offset: (\d+)\)\]/.exec(
      res.content,
    );
    expect(m).not.toBeNull();
    expect(m![1]).toBe(id);
    expect(m![2]).toBe(id);
    const offset = Number(m![3]);
    const shown = res.content.slice(0, res.content.indexOf("\n[output truncated"));
    expect(Buffer.byteLength(shown)).toBeLessThanOrEqual(MAX_OUTPUT);
    const lastShown = shown.slice(shown.lastIndexOf("\n") + 1); // possibly a cut line
    const rest = await read({ process: id, offset, limit: 1 });
    const line = rest.content.split("\n")[0]!;
    expect(line).toBe(`${offset} abcdefghij`);
    // Either the cut was mid-line (the shown fragment starts that line) or on a
    // boundary (nothing of it was shown).
    expect(lastShown === "" || line.startsWith(lastShown)).toBe(true);
    expect(res.content.endsWith("[exit 0]")).toBe(true);
  });
});

describe("negative offset for ordinary files (D-104, G5)", () => {
  const write = (name: string, text: string) => fs.writeFileSync(path.join(root, name), text);

  it("-N starts N lines from the end; limit still counts forward; past the start clamps to line 1", async () => {
    write("f.txt", "l1\nl2\nl3\nl4\nl5\n");
    expect((await read({ path: "f.txt", offset: -2 })).content).toBe("l4\nl5\n[lines 4-5 of 5]");
    expect((await read({ path: "f.txt", offset: -1 })).content).toBe("l5\n[lines 5-5 of 5]"); // last *real* line
    expect((await read({ path: "f.txt", offset: -4, limit: 2 })).content).toBe(
      "l2\nl3\n[lines 2-3 of 5 — continue with offset 4]",
    );
    expect((await read({ path: "f.txt", offset: "-3" })).content).toBe("l3\nl4\nl5\n[lines 3-5 of 5]");
    expect((await read({ path: "f.txt", offset: -99, limit: 1 })).content).toBe(
      "l1\n[lines 1-1 of 5 — continue with offset 2]",
    );
  });

  it("offset 0 is the one refused offset; a windowed read of an empty file says it is empty", async () => {
    write("f.txt", "x\n");
    const zero = await read({ path: "f.txt", offset: 0 });
    expect(zero.isError).toBe(true);
    expect(zero.content).toMatch(/0 is neither/);
    write("e.txt", "");
    expect((await read({ path: "e.txt", offset: -1 })).content).toBe("[e.txt is empty — 0 lines]");
  });
});

describe("the fence: read-only access to the conversation's own process dir (R1 G1)", () => {
  it("a read-only root admits reads, not writes, survives restoreRoots, and may not exist when added", () => {
    const sb = new Sandbox([root]);
    const ro = path.join(data, "processes", "cv_1");
    sb.addReadOnlyRoot(ro); // doesn't exist yet
    fs.mkdirSync(path.join(ro, "task_1"), { recursive: true });
    const log = path.join(ro, "task_1", "combined.log");
    fs.writeFileSync(log, "x");
    expect(sb.resolve(log, "read").ok).toBe(true);
    const w = sb.resolve(log, "write");
    expect(w.ok).toBe(false);
    expect(!w.ok && w.kind).toBe("escape");
    expect(sb.resolve(log).ok).toBe(false); // unsaid = write, the strict side
    sb.restoreRoots([...sb.roots]);
    expect(sb.resolve(log, "read").ok).toBe(true);
    // Another conversation's directory stays fenced for reads too.
    expect(sb.resolve(path.join(data, "processes", "cv_2", "x.log"), "read").ok).toBe(false);
  });

  describe("through a Session (fenceEscapes, the approval card, approve)", () => {
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

    /** Each model turn's tool call comes from `next` (null = answer and stop). */
    function scripted(next: (turn: number) => { name: string; args: unknown } | null): LlmDriver {
      let turn = 0;
      return {
        async *streamChat(): AsyncGenerator<StreamEvent> {
          const call = next(++turn);
          if (call) {
            yield { type: "tool_call", index: 0, id: `call_${turn}`, name: call.name, argsDelta: JSON.stringify(call.args) };
            yield { type: "finish", reason: "tool_calls" };
          } else {
            yield { type: "text", delta: "Done." };
            yield { type: "finish", reason: "stop" };
          }
        },
      };
    }

    function makeSession(next: (turn: number, s: Session) => { name: string; args: unknown } | null) {
      const sandbox = new Sandbox([root]);
      let session: Session | undefined;
      session = new Session({
        config,
        driver: scripted((t) => next(t, session!)),
        tools: new ToolRegistry([...fileTools(), runCommandTool()]),
        sandbox,
        processes: store,
      });
      const approvals: ApprovalRequest[] = [];
      session.onEvent((e) => {
        if (e.type === "awaiting-approval") approvals.push(e.request);
      });
      return { session, sandbox, approvals };
    }
    const toolResults = (s: Session) =>
      s.conversation.entries.filter((e) => e.type === "tool").map((e) => (e as { content: string }).content);
    const logPath = (s: Session) => {
      const dir = store.dirFor(s.conversation.id);
      const task = fs.readdirSync(dir).find((n) => n.startsWith("task_"))!;
      return path.join(dir, task, "combined.log");
    };

    it("reads its own logs by path with no prompt; a write there asks, with no root to remember", async () => {
      const { session, sandbox, approvals } = makeSession((turn, s) =>
        turn === 1
          ? { name: "run_command", args: { command: "echo from-the-log" } }
          : turn === 2
            ? { name: "read_file", args: { path: logPath(s) } }
            : turn === 3
              ? { name: "list_dir", args: { path: path.dirname(logPath(s)) } }
              : turn === 4
                ? { name: "write_file", args: { path: logPath(s), content: "tampered" } }
                : null,
      );
      await session.send("go");
      expect(approvals).toHaveLength(1); // only the write
      const results = toolResults(session);
      expect(results[1]).toBe("from-the-log\n");
      expect(results[2]).toContain("combined.log");
      const card = approvals[0]!;
      expect(card.tool).toBe("write_file");
      expect(card.outOfFence?.paths[0]).toContain(path.join("processes", session.conversation.id));
      expect(card.outOfFence?.suggestedRoot).toBeUndefined();
      // Even asked to remember, the fence does not widen: it is allowed once.
      const rootsBefore = [...sandbox.roots];
      await session.approve({ approve: true, addRoot: true });
      expect(sandbox.roots).toEqual(rootsBefore);
      expect(fs.readFileSync(logPath(session), "utf8")).toBe("tampered");
      session.disposeProcesses();
    });

    it("read_file with process set doesn't fence the path it ignores: no prompt (review R1, as G9)", async () => {
      const { session, approvals } = makeSession((turn) =>
        turn === 1 ? { name: "read_file", args: { process: "task_nope", path: "/somewhere/outside/x.txt" } } : null,
      );
      await session.send("go");
      expect(approvals).toHaveLength(0);
      expect(toolResults(session)[0]).toContain('No process "task_nope"');
    });

    it("another conversation's process dir stays fenced for reads", async () => {
      const otherLog = path.join(store.dirFor("cv_other"), "task_x", "combined.log");
      fs.mkdirSync(path.dirname(otherLog), { recursive: true });
      fs.writeFileSync(otherLog, "secret");
      const { session, approvals } = makeSession((turn) =>
        turn === 1 ? { name: "read_file", args: { path: otherLog } } : null,
      );
      await session.send("go");
      expect(approvals).toHaveLength(1);
      expect(approvals[0]!.outOfFence?.suggestedRoot).toBeUndefined();
      await session.approve({ approve: false });
    });
  });
});

describe("closing a thread disposes its processes (R1 must-fix 1)", () => {
  it.skipIf(!posix)("AgentCoordinator.close on a session outside any tree kills its command and deletes its output", async () => {
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
    let turn = 0;
    const driver: LlmDriver = {
      async *streamChat(): AsyncGenerator<StreamEvent> {
        if (++turn === 1) {
          yield { type: "tool_call", index: 0, id: "c1", name: "run_command", argsDelta: JSON.stringify({ command: "sleep 30" }) };
          yield { type: "finish", reason: "tool_calls" };
        } else {
          yield { type: "text", delta: "ok" };
          yield { type: "finish", reason: "stop" };
        }
      },
    };
    const session = new Session({
      config,
      driver,
      tools: new ToolRegistry([runCommandTool()]),
      sandbox: new Sandbox([root]),
      processes: store,
    });
    const agents = new AgentCoordinator({
      listConfigs: () => [config],
      startAgent: () => {
        throw new Error("unused");
      },
      agentRecords: () => [],
      loadConversation: () => undefined,
    });
    const turnDone = session.send("go");
    await until(() => session.taskList.length === 1);
    const dir = store.dirFor(session.conversation.id);
    expect(fs.existsSync(dir)).toBe(true);
    const dispose = vi.spyOn(session, "disposeProcesses");
    agents.close(session);
    expect(dispose).toHaveBeenCalledTimes(1);
    await turnDone;
    expect(session.taskList).toHaveLength(0);
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe("the per-platform kill (D-105a) — Windows untestable here, so mocked", () => {
  const child = (pid: number | undefined) => ({ pid, kill: vi.fn() });

  it("POSIX signals the whole process group synchronously, never tree-kill", () => {
    const c = child(1234);
    const processKill = vi.fn();
    const treeKill = vi.fn();
    killTree(c, "linux", { processKill, treeKill });
    expect(processKill).toHaveBeenCalledWith(-1234, "SIGKILL");
    expect(treeKill).not.toHaveBeenCalled();
    expect(c.kill).not.toHaveBeenCalled();
  });

  it("POSIX falls back to the child alone when the group kill throws", () => {
    const c = child(1234);
    killTree(c, "darwin", {
      processKill: () => {
        throw new Error("ESRCH");
      },
    });
    expect(c.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("win32 goes through tree-kill (taskkill /T /F), and falls back on its error", () => {
    const c = child(42);
    const processKill = vi.fn();
    const treeKill = vi.fn((_pid: number, _sig: string, cb: (e?: Error) => void) => cb());
    killTree(c, "win32", { processKill, treeKill });
    expect(treeKill).toHaveBeenCalledWith(42, "SIGKILL", expect.any(Function));
    expect(processKill).not.toHaveBeenCalled();
    expect(c.kill).not.toHaveBeenCalled();
    const failing = vi.fn((_pid: number, _sig: string, cb: (e?: Error) => void) => cb(new Error("taskkill failed")));
    killTree(c, "win32", { treeKill: failing });
    expect(c.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("a child that never started (no pid) is killed alone on every platform", () => {
    for (const platform of ["linux", "win32"] as const) {
      const c = child(undefined);
      const treeKill = vi.fn();
      const processKill = vi.fn();
      killTree(c, platform, { treeKill, processKill });
      expect(c.kill).toHaveBeenCalled();
      expect(treeKill).not.toHaveBeenCalled();
      expect(processKill).not.toHaveBeenCalled();
    }
  });

  it("spawns hidden everywhere, and as a group leader only on POSIX", () => {
    expect(shellSpawnOptions("/w", "linux")).toEqual({ cwd: "/w", shell: true, detached: true, windowsHide: true });
    expect(shellSpawnOptions("C:\\w", "win32")).toEqual({ cwd: "C:\\w", shell: true, detached: false, windowsHide: true });
  });
});
