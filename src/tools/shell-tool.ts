/**
 * The shell tool (D-04): run a command in the workspace root, capture combined
 * output + exit code, with an output cap. There is **no timeout** (D-34,
 * Joshua's call) — a command runs until it exits or is killed. The child is
 * spawned in its own process group and registered as a background **task** so
 * the UI can list it and **kill** it (the Kill button, global Stop, and the
 * 30-minute watchdog all terminate it, taking down the whole launched tree —
 * e.g. a dev server and its children).
 */
import { spawn } from "node:child_process";
import type { Tool } from "./types.js";
import type { KillReason } from "./task-registry.js";

const MAX_OUTPUT = 100_000;

/** How a task ended, phrased so the model can tell a kill from a clean exit. */
function killNote(reason: KillReason): string {
  switch (reason) {
    case "user":
      return "[killed by the user]";
    case "stop":
      return "[killed by global stop]";
    case "watchdog":
      return "[killed by the watchdog — you decided to terminate this long-running command]";
  }
}

export function runCommandTool(): Tool {
  return {
    name: "run_command",
    kind: "command",
    mutates: true,
    def: {
      type: "function",
      function: {
        name: "run_command",
        description:
          "Run a shell command in the workspace root; returns combined stdout/stderr and the exit code. Runs until it exits or is killed (there is no timeout), so avoid launching processes that never return unless you intend to.",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    },
    execute(args, ctx) {
      const command = typeof args.command === "string" ? args.command : undefined;
      if (command === undefined) {
        return Promise.resolve({ content: "run_command requires a string 'command'", isError: true });
      }
      return new Promise((resolve) => {
        // Own process group (detached) so a kill can take the whole tree.
        const child = spawn(command, { cwd: ctx.sandbox.primary, shell: true, detached: true });

        // Register as a killable background task (D-34). The killer signals the
        // whole group; if there's no registry (bare tests), it's a no-op handle.
        const handle = ctx.tasks?.start(command, () => {
          try {
            if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
          } catch {
            try {
              child.kill("SIGKILL"); // fall back to the child alone
            } catch {
              /* already gone */
            }
          }
        });

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
          handle?.finish(code);
          const killReason = handle ? ctx.tasks?.killReasonOf(handle.id) : undefined;
          const tail = overflow ? "\n[output truncated]" : "";
          const status = killReason
            ? killNote(killReason)
            : signal
              ? `[killed by ${signal}]`
              : `[exit ${code}]`;
          resolve({ content: `${out}${tail}\n${status}`, isError: killReason !== undefined || code !== 0 });
        });
        child.on("error", (e) => {
          handle?.finish(null);
          resolve({ content: `spawn failed: ${e.message}`, isError: true });
        });
      });
    },
  };
}
