/**
 * The shell tool (D-04): run a shell command, capture combined output + exit
 * code, with an output cap. The child is spawned in its own process group and
 * registered as a background **task** so the UI can list it and **kill** it (the
 * Kill button, global Stop, the watchdog and a per-call `timeout` all terminate
 * it, taking down the whole launched tree — e.g. a dev server and its children).
 *
 * There is still **no default time limit** (D-34, Joshua's call). Two things
 * changed at X-33's triage (D-75), both about who can see the machinery:
 *
 *   - **The description now states the watchdog.** It used to end "there is no
 *     timeout", which is true of the default and false about the mechanism: the
 *     watchdog has always asked *the model* whether to kill a long-running
 *     command (D-34). A tool that documents away the escape hatch it owns is why
 *     the field report said the agent cannot time-limit anything. The interval is
 *     passed in so the sentence states the **configured** number, and says
 *     nothing at all when the watchdog is switched off.
 *   - **A per-call `timeout`.** The watchdog's scale is tens of minutes; a gate
 *     script that hangs in its first ten seconds needs a bound the *call* sets.
 *     It kills through the same registry path, so a timed-out task reads as
 *     killed everywhere rather than as a mysterious exit.
 *
 * `cwd` (X-35a) is the third: a subdirectory command no longer needs a
 * `cd <dir> && ` prefix. It is declared in `pathArgs`, so the fence resolves it
 * and an out-of-fence directory reaches the user as an escape (D-19) — the same
 * question any other path argument would raise.
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import type { Tool } from "./types.js";
import type { KillReason } from "./task-registry.js";

const MAX_OUTPUT = 100_000;

export interface ShellToolOptions {
  /** The configured watchdog interval, in minutes, so the description can state
   *  it. `undefined` = the 30-minute default; `0` = switched off, and the
   *  description then promises no check rather than a wrong one. */
  watchdogMinutes?: number;
}

/** How a task ended, phrased so the model can tell a kill from a clean exit. */
function killNote(reason: KillReason, timeoutSec?: number): string {
  switch (reason) {
    case "user":
      return "[killed by the user]";
    case "stop":
      return "[killed by global stop]";
    case "watchdog":
      return "[killed by the watchdog — you decided to terminate this long-running command]";
    case "timeout":
      return `[timed out after ${timeoutSec}s — the 'timeout' you set on this call, not a failure of the command]`;
  }
}

/** The sentence about long-running commands, stated from the live setting. */
function watchdogSentence(minutes: number | undefined): string {
  const m = minutes ?? 30;
  if (m <= 0) {
    return (
      "There is no time limit and nothing will check on it: if you launch something that never " +
      "returns without setting 'timeout', it runs until a person kills it."
    );
  }
  return (
    `There is no default time limit, but a command still running after ~${m} min pauses to ask *you* ` +
    `whether to kill it (you will be shown its output so far and answer kill/keep), so a long build is ` +
    `not lost and a runaway is not permanent.`
  );
}

export function runCommandTool(options: ShellToolOptions = {}): Tool {
  return {
    name: "run_command",
    kind: "command",
    mutates: true,
    // The working directory is fence-checked like any other path argument
    // (D-19). The *command* is not and never was — a shell can reach anywhere
    // its user can, which is what the approval gate is for; this only means an
    // out-of-fence `cwd` asks first instead of silently running there.
    pathArgs: ["cwd"],
    def: {
      type: "function",
      function: {
        name: "run_command",
        description:
          "Run a shell command; returns combined stdout/stderr and the exit code. " +
          watchdogSentence(options.watchdogMinutes) +
          " Set 'timeout' (seconds) to bound a call yourself — you get the output collected so far. " +
          "Set 'cwd' to run in a subdirectory instead of prefixing the command with 'cd'.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
            cwd: {
              type: "string",
              description:
                "Directory to run in, relative to the workspace root (or absolute). Defaults to the workspace root.",
            },
            timeout: {
              type: "number",
              description:
                "Seconds before the command is killed and its partial output returned. Omit for no limit.",
            },
          },
          required: ["command"],
        },
      },
    },
    execute(args, ctx) {
      const command = typeof args.command === "string" ? args.command : undefined;
      if (command === undefined) {
        return Promise.resolve({ content: "run_command requires a string 'command'", isError: true });
      }

      let timeoutSec: number | undefined;
      if (args.timeout !== undefined) {
        const t = typeof args.timeout === "number" ? args.timeout : Number(args.timeout);
        if (!Number.isFinite(t) || t <= 0) {
          return Promise.resolve({
            content: "run_command 'timeout' must be a positive number of seconds",
            isError: true,
          });
        }
        timeoutSec = t;
      }

      // Resolve `cwd` through the fence. The session has already refused or had
      // an escape approved by the time we get here; this catches the rest —
      // unresolvable paths, and anything that is not a directory (spawn would
      // otherwise fail with a bare ENOENT that names no argument).
      let cwd = ctx.sandbox.primary;
      if (args.cwd !== undefined) {
        if (typeof args.cwd !== "string") {
          return Promise.resolve({ content: "run_command 'cwd' must be a string", isError: true });
        }
        const r = ctx.sandbox.resolve(args.cwd);
        if (!r.ok) return Promise.resolve({ content: `cwd: ${r.reason}`, isError: true });
        let stat: fs.Stats;
        try {
          stat = fs.statSync(r.path);
        } catch {
          return Promise.resolve({ content: `cwd: no such directory: ${args.cwd}`, isError: true });
        }
        if (!stat.isDirectory()) {
          return Promise.resolve({ content: `cwd: not a directory: ${args.cwd}`, isError: true });
        }
        cwd = r.path;
      }

      return new Promise((resolve) => {
        // Own process group (detached) so a kill can take the whole tree.
        const child = spawn(command, { cwd, shell: true, detached: true });

        const killGroup = (): void => {
          try {
            if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
          } catch {
            try {
              child.kill("SIGKILL"); // fall back to the child alone
            } catch {
              /* already gone */
            }
          }
        };

        // Register as a killable background task (D-34). The killer signals the
        // whole group; if there's no registry (bare tests), it's a no-op handle.
        const handle = ctx.tasks?.start(command, killGroup);

        // The per-call bound (X-33). Killing *through the registry* is what makes
        // a timeout read as a kill in the task list and in `killReasonOf` below,
        // rather than as an exit nobody can explain. Without a registry there is
        // nothing to record it on, so the group is signalled directly and the
        // note is carried in `timedOut`.
        let timedOut = false;
        const timer =
          timeoutSec === undefined
            ? undefined
            : setTimeout(
                () => {
                  timedOut = true;
                  if (handle && ctx.tasks) ctx.tasks.kill(handle.id, "timeout");
                  else killGroup();
                },
                timeoutSec * 1000,
              );
        timer?.unref?.(); // a pending timeout must not hold the process open

        let out = "";
        let bytes = 0;
        let overflow = false;
        const onData = (d: Buffer) => {
          bytes += d.length;
          if (bytes <= MAX_OUTPUT) out += d.toString();
          else overflow = true;
          handle?.appendOutput(d.toString());
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);

        child.on("close", (code, signal) => {
          if (timer) clearTimeout(timer);
          handle?.finish(code);
          const killReason = handle ? ctx.tasks?.killReasonOf(handle.id) : timedOut ? "timeout" : undefined;
          const tail = overflow ? "\n[output truncated]" : "";
          const status = killReason
            ? killNote(killReason, timeoutSec)
            : signal
              ? `[killed by ${signal}]`
              : `[exit ${code}]`;
          resolve({ content: `${out}${tail}\n${status}`, isError: killReason !== undefined || code !== 0 });
        });
        child.on("error", (e) => {
          if (timer) clearTimeout(timer);
          handle?.finish(null);
          resolve({ content: `spawn failed: ${e.message}`, isError: true });
        });
      });
    },
  };
}
