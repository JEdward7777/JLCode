/**
 * The mode ∩ approval gate (D-07, D-08). Effective permission is the
 * intersection of what the **mode** allows (capability) and what the **approval
 * policy** allows (confirmation): the mode decides *is this tool allowed at
 * all?*, then for a mutating tool the policy decides *allow / prompt / deny*.
 */
import type { ApprovalPolicy, Mode } from "../config/types.js";
import { onProcess, type GateDecision, type Tool, type ToolGate } from "./types.js";

/** Commands Plan mode may run (to commit its plan) — SPEC §5. */
const PLAN_GIT_ALLOW = ["git add", "git commit", "git status", "git diff", "git log"];

type Allowed = { ok: true } | { ok: false; reason: string };

function modeAllows(mode: Mode, tool: Tool, args: Record<string, unknown>): Allowed {
  if (tool.kind === "read" || tool.kind === "meta") return { ok: true };
  if (mode === "code") return { ok: true };
  if (mode === "ask") return { ok: false, reason: `Ask mode is read-only; ${tool.name} is not allowed` };

  // Plan mode: markdown writes + a fixed git-commit allowlist only.
  if (tool.kind === "write") {
    if (tool.name === "write_file" && typeof args.path === "string" && args.path.endsWith(".md")) {
      return { ok: true };
    }
    return { ok: false, reason: `Plan mode allows only markdown writes; ${tool.name} is not allowed` };
  }
  if (tool.kind === "command") {
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (PLAN_GIT_ALLOW.some((prefix) => cmd.startsWith(prefix))) return { ok: true };
    return { ok: false, reason: "Plan mode allows only git commit/status/diff/log commands" };
  }
  return { ok: false, reason: `not allowed in Plan mode: ${tool.name}` };
}

export class ModeApprovalGate implements ToolGate {
  constructor(
    private readonly mode: Mode,
    private readonly policy: ApprovalPolicy,
    private readonly allowlist: string[] = [],
  ) {}

  private allowlisted(command: string): boolean {
    const cmd = command.trim();
    return this.allowlist.some((prefix) => cmd.startsWith(prefix));
  }

  /**
   * A call on a process has its own rule, checked first (D-105d, R1 must-fix 3,
   * G9). Nothing here reads `args.path` or `args.command`: the call ignores
   * them, so they must not steer the gate — `path: "x.md"` would pass Plan
   * mode's markdown rule and `command: "git status"` its git allowlist (and
   * auto-safe's), for what is really stdin to a shell.
   */
  private processRule(tool: Tool): GateDecision {
    if (tool.processGate === "kill") return { kind: "allow" };
    // "stdin": gated as running a command, minus every allowlist.
    if (this.mode === "ask") {
      return { kind: "deny", reason: `Ask mode is read-only; writing to a process's stdin (${tool.name}) is not allowed` };
    }
    if (this.mode === "plan") {
      return { kind: "deny", reason: `Plan mode can't write to a process's stdin (${tool.name}) — it is gated as running a command` };
    }
    switch (this.policy) {
      case "read-only":
        return { kind: "deny", reason: "read-only approval policy blocks all side effects" };
      case "full-auto":
        return { kind: "allow" };
      case "manual":
      case "auto-safe":
        return { kind: "prompt" };
    }
  }

  check(tool: Tool, args: Record<string, unknown>): GateDecision {
    if (tool.processGate !== undefined && onProcess(tool, args)) return this.processRule(tool);
    const allowed = modeAllows(this.mode, tool, args);
    if (!allowed.ok) return { kind: "deny", reason: allowed.reason };

    // Read/meta tools need no approval.
    if (!tool.mutates) return { kind: "allow" };

    switch (this.policy) {
      case "read-only":
        return { kind: "deny", reason: "read-only approval policy blocks all side effects" };
      case "full-auto":
        return { kind: "allow" };
      case "manual":
        // A tool the user pre-approved in config (MCP `alwaysAllow`, D-47b).
        return tool.autoApprove ? { kind: "allow" } : { kind: "prompt" };
      case "auto-safe":
        if (tool.autoApprove) return { kind: "allow" };
        if (tool.kind === "command" && typeof args.command === "string" && this.allowlisted(args.command)) {
          return { kind: "allow" };
        }
        return { kind: "prompt" };
    }
  }
}
