/**
 * Bridging an MCP server's tools into JLCode's native `Tool` shape (D-47b/d), so
 * everything downstream — the mode∩approval gate, the workspace fence, approval
 * pauses, the debug journal — treats them exactly like a native tool.
 *
 * Classification is deliberately pessimistic: an MCP tool is a mutating
 * `command` unless the server says `annotations.readOnlyHint`. A server's
 * `alwaysAllow` list marks a tool pre-approved (it still can't beat the mode
 * gate or the `read-only` policy).
 */
import type { Tool, ToolKind, ToolResult } from "../tools/types.js";
import type { FieldLists } from "./path-fields.js";
import { classifyArgs } from "./path-fields.js";

/** The subset of MCP's `tools/list` entry we consume. */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

export interface McpToolBinding {
  server: string;
  info: McpToolInfo;
  /** Forward the call to the server. */
  call(toolName: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** Live view of the server's learned path-field lists (they change as the user answers). */
  lists(): FieldLists;
  /** Persist an answer to the *is this a path?* question (D-47d). */
  remember(field: string, isPath: boolean): void;
  alwaysAllow?: string[];
}

/** Model-facing tool names must be `[A-Za-z0-9_-]{1,64}`. */
function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** `<server>__<tool>` — namespaced so two servers (or a native tool) can't collide. */
export function bridgedToolName(server: string, tool: string): string {
  const full = `${sanitize(server)}__${sanitize(tool)}`;
  return full.length <= 64 ? full : full.slice(0, 64);
}

/** Render MCP content blocks as the plain text a tool result carries. */
export function renderMcpContent(result: {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}): string {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const parts: string[] = [];
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b.type === "image" || b.type === "audio") {
      const bytes = typeof b.data === "string" ? Math.floor((b.data.length * 3) / 4) : 0;
      parts.push(`[${String(b.type)} ${String(b.mimeType ?? "unknown")}, ~${bytes} bytes — not inlined]`);
    } else if (b.type === "resource" && typeof b.resource === "object" && b.resource !== null) {
      const r = b.resource as Record<string, unknown>;
      parts.push(typeof r.text === "string" ? `${String(r.uri ?? "resource")}:\n${r.text}` : `[resource ${String(r.uri ?? "")}]`);
    } else {
      parts.push(JSON.stringify(block));
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent));
  }
  return parts.join("\n");
}

/** Wrap one discovered MCP tool as a `Tool`. */
export function bridgeTool(binding: McpToolBinding): Tool {
  const readOnly = binding.info.annotations?.readOnlyHint === true;
  const kind: ToolKind = readOnly ? "read" : "command";
  const name = bridgedToolName(binding.server, binding.info.name);
  const description = binding.info.description ?? `${binding.info.name} (MCP server "${binding.server}")`;
  return {
    name,
    kind,
    mutates: !readOnly,
    autoApprove: binding.alwaysAllow?.includes(binding.info.name) === true,
    def: {
      type: "function",
      function: {
        name,
        description: `[mcp:${binding.server}] ${description}`,
        parameters: binding.info.inputSchema ?? { type: "object", properties: {} },
      },
    },
    classifyPaths: (args) => classifyArgs(args, binding.lists()),
    rememberPathField: (field, isPath) => binding.remember(field, isPath),
    execute: (args) => binding.call(binding.info.name, args),
  };
}
