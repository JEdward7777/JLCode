/**
 * The shell tool (D-04): run a command in the workspace root, capture combined
 * output + exit code, with a timeout and an output cap. Long-running/background
 * tasks with a kill affordance (D-34) come later; this is the synchronous form.
 */
import { spawn } from "node:child_process";
import type { Tool } from "./types.js";

const MAX_OUTPUT = 100_000;
const TIMEOUT_MS = 30_000;

export function runCommandTool(): Tool {
  return {
    name: "run_command",
    kind: "command",
    mutates: true,
    def: {
      type: "function",
      function: {
        name: "run_command",
        description: "Run a shell command in the workspace root; returns combined stdout/stderr and the exit code.",
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
        const child = spawn(command, { cwd: ctx.sandbox.primary, shell: true });
        let out = "";
        let bytes = 0;
        let overflow = false;
        const onData = (d: Buffer) => {
          bytes += d.length;
          if (bytes <= MAX_OUTPUT) out += d.toString();
          else overflow = true;
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);

        const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          const tail = overflow ? "\n[output truncated]" : "";
          const status = signal ? `[killed by ${signal}]` : `[exit ${code}]`;
          resolve({ content: `${out}${tail}\n${status}`, isError: code !== 0 });
        });
        child.on("error", (e) => {
          clearTimeout(timer);
          resolve({ content: `spawn failed: ${e.message}`, isError: true });
        });
      });
    },
  };
}
