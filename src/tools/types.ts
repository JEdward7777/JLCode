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

/**
 * What a tool can show at an approval pause beyond its raw args (D-53). A diff
 * preview is computed from the *pending* call, so a batch that cannot apply
 * reports its reason on the card rather than after the user approves it.
 */
export interface ToolPreview {
  kind: "diff";
  files: {
    path: string;
    /** Unified-diff body (`@@` hunks), already trimmed for display. */
    patch: string;
    added: number;
    removed: number;
    sites: number;
    /** Why this file couldn't be planned — shown instead of a diff. */
    error?: string;
  }[];
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
  /**
   * MCP tools (D-48) are presumed to write until the server's `readOnlyHint` or
   * the user says otherwise. `true` means *presumed* — the strict class is a
   * guess, so a pause that is happening anyway may ask about it. `kind`/`mutates`
   * are live on such a tool: answering flips them for the next call.
   */
  writeUnknown?(): boolean;
  /** Persist the user's answer to *does this tool write?*, asked only once. */
  rememberWrite?(writes: boolean): void;
  /** Pre-approved by the user in config (MCP `alwaysAllow`, D-47b) — skips the
   *  approval prompt, but never the mode gate or the `read-only` policy. */
  autoApprove?: boolean;
  /** Optional richer rendering of a pending call for the approval card (D-53).
   *  Must be side-effect free — it runs while the call is still unapproved. */
  preview?(args: Record<string, unknown>, ctx: ToolContext): ToolPreview | undefined;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** Decision an approval/mode gate returns for a tool call (Phase 3b fills 'prompt'). */
export type GateDecision = { kind: "allow" } | { kind: "deny"; reason: string } | { kind: "prompt" };

export interface ToolGate {
  check(tool: Tool, args: Record<string, unknown>): GateDecision;
}
