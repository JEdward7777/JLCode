/**
 * Background-task registry (D-34). A `run_command` child registers here so it
 * can be surfaced in the UI's task list and **killed** individually — the Kill
 * button, the global Stop, and the 30-minute watchdog all terminate through
 * `kill`/`killAll`. Children are spawned in their own process group, so killing
 * a task takes down the whole launched tree (a dev server and its children).
 *
 * The registry only tracks and emits; the watchdog (which needs the model)
 * lives in the Session, driven off these events.
 */
import { newId } from "../util/id.js";

export type TaskStatus = "running" | "exited" | "killed";

/** Why a task was terminated — surfaced to the model so a killed task reads
 *  differently from a natural exit (D-34). `timeout` is the per-call bound the
 *  model set on `run_command` itself (X-33); it goes through the same kill path
 *  as the rest so the task list can say why, rather than showing a task that
 *  stopped for no stated reason. */
export type KillReason = "user" | "stop" | "watchdog" | "timeout";

/** The UI-facing view of a task (no full output — that rides separately). */
export interface TaskView {
  id: string;
  command: string;
  startedAt: number; // epoch ms
  status: TaskStatus;
  exitCode?: number | null;
  killReason?: KillReason;
}

export type TaskEvent =
  | { type: "task-start"; task: TaskView }
  | { type: "task-update"; task: TaskView }
  | { type: "task-end"; task: TaskView };

/** What `run_command` gets back to feed output in and report completion. */
export interface TaskHandle {
  readonly id: string;
  appendOutput(chunk: string): void;
  /** Report the child closed. If it was killed first, status stays "killed". */
  finish(exitCode: number | null): void;
}

interface InternalTask {
  view: TaskView;
  output: string;
  kill: (reason: KillReason) => void;
  done: boolean;
}

export class TaskRegistry {
  private readonly tasks = new Map<string, InternalTask>();
  private readonly listeners = new Set<(e: TaskEvent) => void>();

  onEvent(listener: (e: TaskEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: TaskEvent): void {
    for (const l of this.listeners) l(e);
  }

  /** Register a starting command. `kill` terminates the underlying process
   *  group; the registry calls it on kill/killAll. */
  start(command: string, kill: (reason: KillReason) => void): TaskHandle {
    const id = newId("task");
    const task: InternalTask = {
      view: { id, command, startedAt: Date.now(), status: "running" },
      output: "",
      kill,
      done: false,
    };
    this.tasks.set(id, task);
    this.emit({ type: "task-start", task: { ...task.view } });
    return {
      id,
      appendOutput: (chunk) => {
        task.output += chunk;
      },
      finish: (exitCode) => {
        if (task.done) return;
        task.done = true;
        if (task.view.status !== "killed") {
          task.view.status = "exited";
          task.view.exitCode = exitCode;
        }
        this.emit({ type: "task-end", task: { ...task.view } });
      },
    };
  }

  /** Request a kill; marks the task and invokes its process-group killer. The
   *  task reaches "killed" here (the child's later close is idempotent). */
  kill(id: string, reason: KillReason): boolean {
    const task = this.tasks.get(id);
    if (!task || task.done || task.view.status === "killed") return false;
    task.view.status = "killed";
    task.view.killReason = reason;
    this.emit({ type: "task-update", task: { ...task.view } });
    try {
      task.kill(reason);
    } catch {
      /* the process may already be gone */
    }
    return true;
  }

  killAll(reason: KillReason): void {
    for (const id of this.tasks.keys()) this.kill(id, reason);
  }

  /** Running tasks (the ones the UI lists / the watchdog watches). */
  list(): TaskView[] {
    return [...this.tasks.values()].filter((t) => t.view.status === "running").map((t) => ({ ...t.view }));
  }

  get(id: string): TaskView | undefined {
    const t = this.tasks.get(id);
    return t ? { ...t.view } : undefined;
  }

  /** Captured output so far — for the watchdog's kill decision (D-34). */
  output(id: string): string {
    return this.tasks.get(id)?.output ?? "";
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
