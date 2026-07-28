/**
 * Tool abstraction. A Tool declares its JSON schema for the model, a capability
 * `kind` (for the mode gate, Phase 3b), whether it `mutates` state (for approval
 * policies), and an `execute` that runs against a sandboxed context.
 */
import type { ToolDef } from "../llm/types.js";
import type { Sandbox } from "./sandbox.js";
import type { TaskRegistry } from "./task-registry.js";

/** Capability class, used by the Ask/Plan/Code mode gate. */
export type ToolKind = "read" | "write" | "command" | "meta";

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface ToolContext {
  sandbox: Sandbox;
  /** Background-task registry (D-34) — long-running commands register here so
   *  they can be listed, killed, and watchdog-watched. */
  tasks?: TaskRegistry;
}

/** A flattened argument field and its value (jq-style name — D-47d). */
export interface PathCandidate {
  field: string;
  value: string;
}

/** Which args of a call to fence, and which the user has never classified. */
export interface ClassifiedPaths {
  paths: PathCandidate[];
  unknown: PathCandidate[];
}

export interface Tool {
  name: string;
  kind: ToolKind;
  /** Does this change state (→ subject to approval policies)? */
  mutates: boolean;
  /** Names of args that are file paths, fence-checked before execution (D-19). */
  pathArgs?: string[];
  /** The function schema advertised to the model. */
  def: ToolDef;
  /**
   * Tools whose args are arbitrary JSON (MCP — D-47d) find their path args this
   * way instead of by `pathArgs`: string leaves are flattened to jq-style field
   * names and looked up in the server's learned lists. Unclassified slashy
   * values come back as `unknown` — fenced anyway, and asked about once.
   */
  classifyPaths?(args: Record<string, unknown>): ClassifiedPaths;
  /** Persist the user's answer to that question, so it is asked only once. */
  rememberPathField?(field: string, isPath: boolean): void;
  /** Pre-approved by the user in config (MCP `alwaysAllow`, D-47b) — skips the
   *  approval prompt, but never the mode gate or the `read-only` policy. */
  autoApprove?: boolean;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** Decision an approval/mode gate returns for a tool call (Phase 3b fills 'prompt'). */
export type GateDecision = { kind: "allow" } | { kind: "deny"; reason: string } | { kind: "prompt" };

export interface ToolGate {
  check(tool: Tool, args: Record<string, unknown>): GateDecision;
}
