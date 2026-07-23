/**
 * Tool abstraction. A Tool declares its JSON schema for the model, a capability
 * `kind` (for the mode gate, Phase 3b), whether it `mutates` state (for approval
 * policies), and an `execute` that runs against a sandboxed context.
 */
import type { ToolDef } from "../llm/types.js";
import type { Sandbox } from "./sandbox.js";

/** Capability class, used by the Ask/Plan/Code mode gate. */
export type ToolKind = "read" | "write" | "command" | "meta";

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface ToolContext {
  sandbox: Sandbox;
}

export interface Tool {
  name: string;
  kind: ToolKind;
  /** Does this change state (→ subject to approval policies)? */
  mutates: boolean;
  /** The function schema advertised to the model. */
  def: ToolDef;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** Decision an approval/mode gate returns for a tool call (Phase 3b fills 'prompt'). */
export type GateDecision = { kind: "allow" } | { kind: "deny"; reason: string } | { kind: "prompt" };

export interface ToolGate {
  check(tool: Tool, args: Record<string, unknown>): GateDecision;
}
