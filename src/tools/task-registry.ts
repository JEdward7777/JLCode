/**
 * Task registry (D-34, D-104). Every `run_command` child registers here so it
 * can be surfaced in the UI's task list and **killed** individually — the Kill
 * button, the global Stop, the watchdog and a per-call timeout all terminate
 * through `kill`/`killAll` — and, since D-104, so its output is **on disk**:
 * `processes/<conversation-id>/<process-id>/{combined,stdout,stderr}.log`, for
 * every task, foreground included. The id is what `read_file(process:)` reads.
 *
 * ## How a task ends — one lifecycle (plan review R5/R6)
 *
 * R4 and R5 both found defects in *how a task ends*, so every path goes through
 * the same idempotent steps here; nothing outside the registry closes a log fd
 * or deletes a process directory:
 *
 *     running → childExited → ending → finished → sealed
 *
 *   - **childExited**: the child's `exit` fired (its code and signal recorded —
 *     an OOM kill reads "killed by SIGKILL", not "exited null").
 *   - **ending**: a background task's streams are draining, capped by a short
 *     grace (a `cmd &` daemon can hold the pipe open forever).
 *   - **finished**: status, counts and `task-end` are done; the per-call timeout
 *     is cleared, whichever path got here.
 *   - **sealed**: appends are no-ops, the registry's own `data`/`end` listeners
 *     are detached, the streams `destroy()`ed, and only then the fds closed — a
 *     daemon's late `data` must never `writeSync` to a closed fd (EBADF thrown in
 *     a stream handler crashes the server) or to a reused one.
 *
 * Entry points: `close` ends a task in **any** state for either flag (R6 — a
 * spawn failure emits `error` and `close` and never `exit`); `exit` of a
 * background task starts the drain; the grace timer; the flip to background
 * (D-106); `dispose`. `TaskView.status` stays `"running"` until `finished`
 * (unless a kill marked it first) — `list()` and the watchdog rely on that.
 *
 * The registry only tracks, records and emits; the watchdog (which needs the
 * model) lives in the Session, driven off these events.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { newId } from "../util/id.js";
import type { ProcessDirLease } from "./process-store.js";

export type TaskStatus = "running" | "exited" | "killed";

/** Why a task was terminated — surfaced to the model so a killed task reads
 *  differently from a natural exit (D-34). `timeout` is the per-call bound the
 *  model set on `run_command` itself (X-33); it goes through the same kill path
 *  as the rest so the task list can say why, rather than showing a task that
 *  stopped for no stated reason. `agent` is the agent's own
 *  `delete_file(process:)` (R3 nit) — it already got the outcome as that call's
 *  result, so no notice follows (P10c). */
export type KillReason = "user" | "stop" | "watchdog" | "timeout" | "agent";

/** The three logs every task writes (D-104). `combined` is both streams in
 *  arrival order — what a terminal would show, near enough. */
export type ProcessStream = "combined" | "stdout" | "stderr";
const STREAMS: readonly ProcessStream[] = ["combined", "stdout", "stderr"];

/** The UI-facing view of a task (no output — that lives on disk). */
export interface TaskView {
  id: string;
  command: string;
  startedAt: number; // epoch ms
  status: TaskStatus;
  exitCode?: number | null;
  /** The signal the child died of, recorded at `exit` (R6). */
  signal?: string;
  killReason?: KillReason;
  /** A background task: no watchdog (D-104), listed and announced (P10b/c). */
  background?: boolean;
  /** When the task finished (epoch ms) — for a runtime once it has ended. */
  endedAt?: number;
  /** "failed to start: <why>" — the child never ran (R6/R7). Shown instead of
   *  an exit code by the read footer, the listing and the notice. */
  failedToStart?: string;
}

export type TaskEvent =
  | { type: "task-start"; task: TaskView }
  | { type: "task-update"; task: TaskView }
  | { type: "task-end"; task: TaskView };

/** What `run_command` gets back. Everything else it reads through `get`. */
export interface TaskHandle {
  readonly id: string;
}

export interface StartOptions {
  /** Start as a background task (D-104): no watchdog, listed, ended on `exit`
   *  plus a drain rather than waiting for `close` (R3). */
  background?: boolean;
  /** Called once if a running foreground task is handed to the background
   *  (D-106) — `run_command` resolves its pending call from here, at once,
   *  with the background-launch text; its later `close` must not resolve again. */
  onBackground?: () => void;
  /** The per-call bound (X-33), owned here so it is cleared at `finished`
   *  whichever path got there (R5). */
  timeoutMs?: number;
}

/** Where a task's output is right now, for `read_file(process:)` (R2 must-fix 3). */
export interface ProcessLog {
  view: TaskView;
  file: string;
  /** Complete lines — every `\n` written so far. */
  lines: number;
  /** Bytes after the last `\n`: a line still being written (or, once ended, a
   *  last line with no newline, which then counts normally). */
  partial: boolean;
  /** `finished` — the outcome is settled and no more output will come. */
  ended: boolean;
}

/** Supplies the conversation's process directory, on the first task. */
export type ProcessDirSource = () => ProcessDirLease;

export interface TaskRegistryOptions {
  dir?: ProcessDirSource;
  /** How long a background task's streams may drain after `exit` (R4). */
  graceMs?: number;
}

/** The default grace: long enough for a pipe's last bytes, short enough that a
 *  daemon holding the pipe doesn't hold the task open (R4: about 1–2 s). */
export const DRAIN_GRACE_MS = 1500;

/**
 * A private temp directory (R1 G3): a registry with no store — a test, a bare
 * `new Session` — never writes into the real data dir. Removed whole on release,
 * since nothing else can be in it.
 */
export function tempProcessDir(): ProcessDirLease {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-processes-"));
  return {
    path: dir,
    release: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

/** How a task stands, in the words the read footer uses ("· exited 0"). */
export function describeState(view: TaskView): string {
  if (view.status === "running") return "running";
  if (view.failedToStart) return view.failedToStart;
  if (view.status === "killed") {
    switch (view.killReason) {
      case "user":
        return "killed by the user";
      case "stop":
        return "killed by Stop";
      case "watchdog":
        return "killed by the watchdog";
      case "timeout":
        return "killed by its timeout";
      case "agent":
        return "killed with delete_file";
      default:
        return "killed";
    }
  }
  if (view.signal) return `killed by ${view.signal}`;
  return `exited ${view.exitCode ?? "?"}`;
}

/** A runtime the way a person says it: "4s", "2m 13s", "1h 02m". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** A command as a notice quotes it: one line, capped, so a heredoc doesn't
 *  turn a one-line notice into a page. */
function quoteCommand(command: string, max = 200): string {
  const lines = command.split("\n");
  let one = lines[0]!.trimEnd();
  if (lines.length > 1) one += " …";
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * The completion notice a background process sends its thread when it ends
 * (P10c, D-104): how it ended, its runtime, and the read call. `lines` is its
 * combined output by the read rule (a last unterminated line counts once
 * ended). The browser draws it as a card, reading these words back
 * (`web/src/agents.ts`), so change the two together.
 */
export function processNoticeText(view: TaskView, lines: number): string {
  const runtime = formatDuration((view.endedAt ?? Date.now()) - view.startedAt);
  const id = view.id;
  const output =
    lines === 0
      ? `It wrote no output; its log is still there: read_file(process: "${id}").`
      : `Its output (${lines.toLocaleString("en-US")} line${lines === 1 ? "" : "s"}) stays readable: ` +
        `read_file(process: "${id}") — offset: -20 for the last 20 lines; stream: "stdout" or "stderr" for one stream.`;
  return `[Background process ${id} ended (${describeState(view)}) after ${runtime}: $ ${quoteCommand(view.command)}]\n${output}`;
}

/** One row of `list_dir(processes: true)` (D-104). */
export interface ProcessRow {
  view: TaskView;
  /** `finished` — the outcome is settled. */
  ended: boolean;
  /** Lines per stream, by the read rule (R2 must-fix 3): complete lines while
   *  running, a last unterminated line counted once ended. */
  lines: { stdout: number; stderr: number };
}

/** What `write` did (G10). The tool turns it into words. */
export type WriteOutcome =
  | { kind: "unknown" }
  /** Finished, killed, or its child has exited (R6: no waiting for EPIPE). */
  | { kind: "ended"; view: TaskView }
  /** Running, but its stdin is closed — by `close: true` earlier, or by the
   *  process itself (EPIPE). */
  | { kind: "input-closed"; view: TaskView }
  /** Handed to the pipe. `pending`: the pipe was full and the process has not
   *  read it yet when the wait ran out — it is queued, not lost. */
  | { kind: "written"; view: TaskView; bytes: number; closed: boolean; pending: boolean };

/** How long `write` waits for the pipe to take the bytes before answering
 *  "queued" — a process that isn't reading must not hang the turn. */
export const WRITE_WAIT_MS = 2000;

interface InternalTask {
  view: TaskView;
  child: ChildProcess;
  kill: (reason: KillReason) => void;
  /** This task's own directory, once made. */
  dir?: string;
  fds?: Record<ProcessStream, number>;
  /** Complete lines per stream — the in-memory counters (R1 G4). */
  lines: Record<ProcessStream, number>;
  partial: Record<ProcessStream, boolean>;
  childExited: boolean;
  exit?: { code: number | null; signal: NodeJS.Signals | null };
  streamEnded: { stdout: boolean; stderr: boolean };
  ending: boolean;
  finished: boolean;
  sealed: boolean;
  grace?: ReturnType<typeof setTimeout>;
  timeout?: ReturnType<typeof setTimeout>;
  /** Removes the registry's `data`/`end` listeners — and only those (R6). */
  detach: () => void;
  /** Its stdin raised `error` (EPIPE: the process closed its input), G10. */
  stdinFailed: boolean;
  /** An ended background task has been in one `list_dir(processes: true)`
   *  (D-104): it drops off the next. */
  shown: boolean;
  onBackground?: () => void;
}

/** Write all of `buf` — `writeSync` may write less than asked. */
function writeAll(fd: number, buf: Buffer): void {
  let off = 0;
  while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
}

function countNewlines(buf: Buffer): number {
  let n = 0;
  for (let i = buf.indexOf(0x0a); i !== -1; i = buf.indexOf(0x0a, i + 1)) n++;
  return n;
}

export class TaskRegistry {
  private readonly tasks = new Map<string, InternalTask>();
  private readonly listeners = new Set<(e: TaskEvent) => void>();
  private dirSource: ProcessDirSource | undefined;
  private lease: ProcessDirLease | undefined;
  private disposed = false;
  private readonly graceMs: number;

  constructor(options: TaskRegistryOptions = {}) {
    this.dirSource = options.dir;
    this.graceMs = options.graceMs ?? DRAIN_GRACE_MS;
  }

  /** Give an injected registry its directory (R7) — the Session knows the
   *  conversation; whoever built the registry may not. First binding wins. */
  bindDir(source: ProcessDirSource): void {
    this.dirSource ??= source;
  }

  /** Has `dispose` run? Notices (P10c) check this: a disposed registry emits none (R2). */
  get isDisposed(): boolean {
    return this.disposed;
  }

  onEvent(listener: (e: TaskEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: TaskEvent): void {
    for (const l of this.listeners) l(e);
  }

  /** The conversation directory, leased on the first task (R2: G3's temp dir is
   *  created on the first task too). */
  private baseDir(): string {
    if (!this.lease) this.lease = (this.dirSource ?? tempProcessDir)();
    return this.lease.path;
  }

  /**
   * Register a spawned command. The registry owns the child from here: its
   * `exit`/`close`/`error` listeners, its logs and its timeout (R6). `kill`
   * terminates the whole tree; the registry calls it on kill/killAll/dispose.
   */
  start(
    command: string,
    child: ChildProcess,
    kill: (reason: KillReason) => void,
    options: StartOptions = {},
  ): TaskHandle {
    const id = newId("task");
    const task: InternalTask = {
      view: {
        id,
        command,
        startedAt: Date.now(),
        status: "running",
        ...(options.background ? { background: true } : {}),
      },
      child,
      kill,
      lines: { combined: 0, stdout: 0, stderr: 0 },
      partial: { combined: false, stdout: false, stderr: false },
      childExited: false,
      streamEnded: { stdout: child.stdout === null, stderr: child.stderr === null },
      ending: false,
      finished: false,
      sealed: false,
      detach: () => {},
      stdinFailed: false,
      shown: false,
      ...(options.onBackground ? { onBackground: options.onBackground } : {}),
    };
    this.tasks.set(id, task);
    // An `error` on stdin (EPIPE once the process stops reading, G10) with no
    // listener would be an uncaught exception — a server crash. Recorded, so a
    // later write says the input is closed rather than throwing.
    child.stdin?.on("error", () => {
      task.stdinFailed = true;
    });

    // Lifecycle listeners first, so nothing can slip past them. They stay
    // attached until `close` (R6): seal detaches only the data listeners.
    child.on("exit", (code, signal) => this.onExit(task, code, signal));
    child.on("close", (code, signal) => this.onClose(task, code, signal));
    child.on("error", (e) => this.onError(task, e));

    // The logs. An `openSync` failure (EMFILE, a full disk) is a synchronous
    // throw, not an event (R7): the child is already running, so take its tree
    // down and end the task as never started.
    try {
      if (this.disposed) throw new Error("this conversation's processes were closed");
      const dir = path.join(this.baseDir(), id);
      fs.mkdirSync(dir, { recursive: true });
      task.dir = dir;
      const fds: Partial<Record<ProcessStream, number>> = {};
      try {
        for (const s of STREAMS) fds[s] = fs.openSync(path.join(dir, `${s}.log`), "w");
      } catch (e) {
        for (const fd of Object.values(fds)) fs.closeSync(fd);
        throw e;
      }
      task.fds = fds as Record<ProcessStream, number>;
    } catch (e) {
      task.view.failedToStart = `failed to start: could not open its log (${(e as Error).message})`;
      try {
        kill("stop");
      } catch {
        /* already gone */
      }
      try {
        this.emit({ type: "task-start", task: { ...task.view } });
      } finally {
        this.endTask(task); // a throwing listener must not leave the task open
      }
      return { id };
    }

    const onOut = (d: Buffer): void => this.append(task, "stdout", d);
    const onErr = (d: Buffer): void => this.append(task, "stderr", d);
    const endOut = (): void => this.streamEnd(task, "stdout");
    const endErr = (): void => this.streamEnd(task, "stderr");
    child.stdout?.on("data", onOut);
    child.stdout?.on("end", endOut);
    child.stderr?.on("data", onErr);
    child.stderr?.on("end", endErr);
    task.detach = () => {
      child.stdout?.off("data", onOut);
      child.stdout?.off("end", endOut);
      child.stderr?.off("data", onErr);
      child.stderr?.off("end", endErr);
    };

    if (options.timeoutMs !== undefined) {
      task.timeout = setTimeout(() => this.kill(id, "timeout"), options.timeoutMs);
      task.timeout.unref?.(); // a pending timeout must not hold the process open
    }

    this.emit({ type: "task-start", task: { ...task.view } });
    return { id };
  }

  /** Synchronous, on open fds (R1 G6): no read or result can precede the bytes. */
  private append(task: InternalTask, stream: "stdout" | "stderr", buf: Buffer): void {
    if (task.sealed || !task.fds || buf.length === 0) return;
    try {
      writeAll(task.fds[stream], buf);
      writeAll(task.fds.combined, buf);
    } catch {
      // A full disk mid-run: the output is lost, the process is not. Throwing
      // here would be an exception in a stream handler — a server crash.
      return;
    }
    const n = countNewlines(buf);
    const partial = buf[buf.length - 1] !== 0x0a;
    task.lines[stream] += n;
    task.lines.combined += n;
    task.partial[stream] = partial;
    task.partial.combined = partial;
  }

  private streamEnd(task: InternalTask, stream: "stdout" | "stderr"): void {
    task.streamEnded[stream] = true;
    if (task.ending && task.streamEnded.stdout && task.streamEnded.stderr) this.endTask(task);
  }

  private onExit(task: InternalTask, code: number | null, signal: NodeJS.Signals | null): void {
    if (task.childExited) return;
    task.childExited = true;
    task.exit = { code, signal };
    // Chosen when the event fires, not when the task started (R4 nit): a
    // foreground task flipped to background ends the background way.
    if (task.view.background) this.beginEnd(task);
  }

  /** `close` means every stdio stream is closed and the child is gone or never
   *  started, so it ends the task in any state, for either flag (R6). */
  private onClose(task: InternalTask, code: number | null, signal: NodeJS.Signals | null): void {
    task.exit ??= { code, signal };
    this.endTask(task);
  }

  private onError(task: InternalTask, e: Error): void {
    // Only a child with no pid never started: `ChildProcess.kill` can raise
    // `error` too (R7), and that is not a failed start.
    if (task.child.pid !== undefined) return;
    task.view.failedToStart ??= `failed to start: ${e.message}`;
    // `close` normally follows; ending here as well means a spawn failure can
    // never leave a task "running" if it doesn't.
    this.endTask(task);
  }

  /** Arm a background task's drain (R4): wait for both streams, capped. */
  private beginEnd(task: InternalTask): void {
    if (task.ending || task.finished) return;
    task.ending = true;
    // Streams already ended: no reason to wait (R6 nit).
    if (task.streamEnded.stdout && task.streamEnded.stderr) return this.endTask(task);
    task.grace = setTimeout(() => this.endTask(task), this.graceMs);
    task.grace.unref?.();
  }

  private endTask(task: InternalTask): void {
    // Seal in a finally (review R1): `finish` emits `task-end`, and a listener
    // that throws must not skip closing the fds.
    try {
      this.finish(task);
    } finally {
      this.seal(task);
    }
  }

  private finish(task: InternalTask): void {
    if (task.finished) return;
    task.finished = true;
    if (task.timeout) clearTimeout(task.timeout);
    if (task.grace) clearTimeout(task.grace);
    task.timeout = task.grace = undefined;
    const v = task.view;
    v.endedAt = Date.now();
    if (task.exit) {
      v.exitCode = task.exit.code;
      if (task.exit.signal) v.signal = task.exit.signal;
    }
    if (v.status !== "killed") v.status = "exited";
    // The trailing partial line is a line now (R2 must-fix 3): reads count it.
    this.emit({ type: "task-end", task: { ...v } });
  }

  private seal(task: InternalTask): void {
    if (task.sealed) return;
    task.sealed = true;
    task.detach();
    try {
      task.child.stdout?.destroy();
      task.child.stderr?.destroy();
    } catch {
      /* already closed */
    }
    // Close each fd exactly once, after the listeners are gone (R5); before any
    // directory removal, since Windows refuses to delete an open file.
    const fds = task.fds;
    task.fds = undefined;
    if (fds) {
      for (const s of STREAMS) {
        try {
          fs.closeSync(fds[s]);
        } catch {
          /* best effort */
        }
      }
    }
  }

  /**
   * Request a kill. A running task is marked killed (and says why) and its tree
   * signalled. A task whose child has already exited — a daemon still holding
   * its pipe, or one in its grace — has its group signalled again, but its
   * recorded exit stays the outcome (R6): a clean `exit 0` is not relabelled.
   */
  kill(id: string, reason: KillReason): boolean {
    const task = this.tasks.get(id);
    if (!task || task.finished) return false;
    if (task.childExited) {
      try {
        task.kill(reason);
      } catch {
        /* the group may be gone too */
      }
      return true;
    }
    if (task.view.status === "killed") return false;
    task.view.status = "killed";
    task.view.killReason = reason;
    try {
      this.emit({ type: "task-update", task: { ...task.view } });
    } finally {
      // A throwing listener must not leave the tree running (P10b, folding
      // P10a's R2 nit): the signal goes regardless.
      try {
        task.kill(reason);
      } catch {
        /* the process may already be gone */
      }
    }
    return true;
  }

  /** Kill every task. Each kill is its own attempt: `kill` signals the tree
   *  even past a throwing `task-update` listener, but then rethrows — which
   *  must not leave the rest of the loop unkilled (P10b review nit). The first
   *  error is rethrown once every task has been tried. */
  killAll(reason: KillReason): void {
    this.killEach([...this.tasks.keys()], reason);
  }

  /** Stop's kill (D-104): foreground tasks only — background processes
   *  survive Stop; "Stop and kill processes" and closing the thread end them. */
  killForeground(reason: KillReason): void {
    this.killEach([...this.tasks].filter(([, t]) => !t.view.background).map(([id]) => id), reason);
  }

  private killEach(ids: string[], reason: KillReason): void {
    let first: unknown;
    let failed = false;
    for (const id of ids) {
      try {
        this.kill(id, reason);
      } catch (e) {
        if (!failed) first = e;
        failed = true;
      }
    }
    if (failed) throw first;
  }

  /**
   * Append exactly `content` to a task's stdin, then send EOF if `close` (D-104,
   * G10). An ended task — finished, killed, or one whose child has exited — is
   * refused at once (R6) rather than left to fail later with EPIPE. Resolves
   * when the pipe has taken the bytes, or after `WRITE_WAIT_MS` with
   * `pending: true` if the process isn't reading.
   */
  write(id: string, content: string, close: boolean): Promise<WriteOutcome> {
    const task = this.tasks.get(id);
    if (!task) return Promise.resolve({ kind: "unknown" });
    const c = task.child;
    const view = (): TaskView => ({ ...task.view });
    if (task.finished || task.childExited || task.view.status !== "running" || c.exitCode !== null || c.signalCode !== null) {
      return Promise.resolve({ kind: "ended", view: view() });
    }
    const stdin = c.stdin;
    if (!stdin || task.stdinFailed || stdin.destroyed || stdin.writableEnded) {
      return Promise.resolve({ kind: "input-closed", view: view() });
    }
    const bytes = Buffer.byteLength(content);
    return new Promise((resolve) => {
      let done = false;
      const settle = (o: WriteOutcome): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        stdin.off("error", onError);
        resolve(o);
      };
      const onError = (): void => settle({ kind: "input-closed", view: view() });
      const written = (pending: boolean): WriteOutcome => ({ kind: "written", view: view(), bytes, closed: close, pending });
      stdin.once("error", onError);
      const timer = setTimeout(() => settle(written(true)), WRITE_WAIT_MS);
      timer.unref?.();
      const after = (e?: Error | null): void => (e ? onError() : settle(written(false)));
      try {
        if (close) {
          // `end(chunk, cb)` writes then closes; the callback fires once flushed.
          // The callback carries EPIPE before any `error` listener runs (review
          // R1): pass it on, or a closed input reads as a successful close.
          if (bytes > 0) stdin.end(content, (e?: Error | null) => after(e));
          else stdin.end((e?: Error | null) => after(e));
        } else if (bytes > 0) {
          stdin.write(content, after);
        } else {
          settle(written(false));
        }
      } catch {
        onError();
      }
    });
  }

  /** Has this task's child exited, though the task has not finished yet (a
   *  background task in its drain grace, R4)? Such a task takes no input. */
  childHasExited(id: string): boolean {
    const t = this.tasks.get(id);
    return t !== undefined && !t.finished && (t.childExited || t.child.exitCode !== null || t.child.signalCode !== null);
  }

  /** Resolves with the task's final view once it has finished, or `undefined`
   *  after `ms` — for `delete_file(process:)`, which reports how it ended. */
  whenEnded(id: string, ms: number): Promise<TaskView | undefined> {
    const task = this.tasks.get(id);
    if (!task) return Promise.resolve(undefined);
    if (task.finished) return Promise.resolve({ ...task.view });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve(undefined);
      }, ms);
      timer.unref?.();
      const off = this.onEvent((e) => {
        if (e.type !== "task-end" || e.task.id !== id) return;
        clearTimeout(timer);
        off();
        resolve({ ...e.task });
      });
    });
  }

  /**
   * The rows of `list_dir(processes: true)` (D-104, G8): background tasks only.
   * An ended one appears in exactly one listing — this call marks it shown —
   * and then drops off; it stays readable by id.
   */
  listBackground(): ProcessRow[] {
    const rows: ProcessRow[] = [];
    for (const t of this.tasks.values()) {
      if (!t.view.background || (t.finished && t.shown)) continue;
      if (t.finished) t.shown = true;
      const count = (s: "stdout" | "stderr"): number => t.lines[s] + (t.finished && t.partial[s] ? 1 : 0);
      rows.push({ view: { ...t.view }, ended: t.finished, lines: { stdout: count("stdout"), stderr: count("stderr") } });
    }
    return rows;
  }

  /**
   * Hand a running foreground task over to the background (D-106's flip): the
   * watchdog's "background" answer. Its `onBackground` resolves the pending
   * `run_command` call at once; the process and its files are untouched. A
   * child that has already exited (H-31's `cmd &`) starts the background end at
   * once (R5). Returns false for a task that has finished.
   */
  toBackground(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.finished) return false;
    if (!task.view.background) {
      task.view.background = true;
      const hand = task.onBackground;
      task.onBackground = undefined;
      try {
        this.emit({ type: "task-update", task: { ...task.view } });
      } finally {
        hand?.(); // the call resolves even past a throwing listener
      }
    }
    const c = task.child;
    if (!task.childExited && (c.exitCode !== null || c.signalCode !== null)) {
      task.childExited = true;
      task.exit = { code: c.exitCode, signal: c.signalCode };
    }
    if (task.childExited) this.beginEnd(task);
    return true;
  }

  /**
   * Close the conversation's processes (R1 must-fix 1, R5, R6): called when the
   * thread is closed. Every task is killed — no background filter — then
   * finished and sealed, and every pending grace timer cleared; afterwards a
   * late `close` or `data` touches no fd and no directory. Then the registry's
   * own process directories are removed and the conversation directory let go.
   * Never throws.
   *
   * A task that exited but has not finished (still in its grace) is killed too:
   * that re-signals its group and takes down a lingering daemon. Intended.
   */
  dispose(): void {
    if (this.disposed) return;
    // First, so a notice (P10c) can never be generated by what follows (R2).
    this.disposed = true;
    for (const task of this.tasks.values()) {
      try {
        try {
          if (!task.finished) {
            try {
              this.kill(task.view.id, "stop");
            } finally {
              // A throwing `task-update` listener inside `kill` must not skip
              // this (P10a review R2 nit): unfinished, the timers would stay
              // armed and `task-end` would fire after dispose, from `close`.
              this.finish(task);
            }
          }
        } finally {
          this.seal(task); // even past a throwing `task-update`/`task-end` listener
        }
      } catch {
        /* one bad task must not keep the rest alive */
      }
    }
    for (const task of this.tasks.values()) {
      if (!task.dir) continue;
      try {
        fs.rmSync(task.dir, { recursive: true, force: true });
      } catch {
        /* swallowed (R1): a held file on Windows; the sweep gets it later */
      }
    }
    try {
      this.lease?.release();
    } catch {
      /* best effort */
    }
    this.lease = undefined;
  }

  /** Running tasks (the ones the UI lists / the watchdog watches). */
  list(): TaskView[] {
    return [...this.tasks.values()].filter((t) => t.view.status === "running").map((t) => ({ ...t.view }));
  }

  /** Every task this registry knows, ended ones too — what is readable. */
  all(): TaskView[] {
    return [...this.tasks.values()].map((t) => ({ ...t.view }));
  }

  get(id: string): TaskView | undefined {
    const t = this.tasks.get(id);
    return t ? { ...t.view } : undefined;
  }

  /** Where a task's log is and how far it has got (R2 must-fix 3). `undefined`
   *  for an unknown id, or a task that never got a log. */
  log(id: string, stream: ProcessStream = "combined"): ProcessLog | undefined {
    const t = this.tasks.get(id);
    if (!t || !t.dir) return undefined;
    return {
      view: { ...t.view },
      file: path.join(t.dir, `${stream}.log`),
      lines: t.lines[stream],
      partial: t.partial[stream],
      ended: t.finished,
    };
  }

  /** The last `maxBytes` of the combined output — for the watchdog's kill
   *  decision (D-34), read from disk so memory stays flat (R1 G4). `truncated`
   *  says whether anything came before it. */
  outputTail(id: string, maxBytes = 4000): { text: string; truncated: boolean } {
    const t = this.tasks.get(id);
    if (!t?.dir) return { text: "", truncated: false };
    let fd: number | undefined;
    try {
      fd = fs.openSync(path.join(t.dir, "combined.log"), "r");
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, maxBytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return { text: buf.toString("utf8"), truncated: size > len };
    } catch {
      return { text: "", truncated: false };
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* best effort */
        }
      }
    }
  }

  /** How long the task has been running, in ms — for the watchdog. */
  elapsedMs(id: string): number {
    const t = this.tasks.get(id);
    return t ? Date.now() - t.view.startedAt : 0;
  }

  /** The reason a task was killed, if any (so the tool result can say so). */
  killReasonOf(id: string): KillReason | undefined {
    return this.tasks.get(id)?.view.killReason;
  }
}
