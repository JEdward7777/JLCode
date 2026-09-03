/**
 * Bridging an MCP server's tools into JLCode's native `Tool` shape (D-47b/d), so
 * everything downstream — the mode∩approval gate, the workspace fence, approval
 * pauses, the debug journal — treats them exactly like a native tool.
 *
 * Classification is deliberately pessimistic: an MCP tool is a mutating
 * `command` unless the server says `annotations.readOnlyHint` **or the user has
 * told us otherwise** (D-48 — a learned `readTools` entry). A server's
 * `alwaysAllow` list marks a tool pre-approved (it still can't beat the mode
 * gate or the `read-only` policy).
 *
 * `kind` and `mutates` are **getters**: the user can answer *does this tool
 * write?* mid-session, and the very next gate check must see the new answer.
 */
import type { Tool, ToolKind, ToolContext, ToolResult } from "../tools/types.js";
import type { Attachment } from "../conversation/types.js";
import { IMAGE_MIMES, MAX_IMAGE_BYTES, base64Bytes, classifySample, humanBytes } from "../tools/media.js";
import type { FieldLists } from "./path-fields.js";
import { classifyArgs } from "./path-fields.js";
import type { ToolClassLists } from "./tool-class.js";
import { classifyTool } from "./tool-class.js";

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
  /** Forward the call to the server. `ctx` carries the *session's* answer to
   *  "can this model see?" — bridged tools are built once per instance and
   *  outlive any one session's model, so unlike `read_file` they cannot bake it
   *  in at construction (P8e). */
  call(toolName: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
  /** Live view of the server's learned lists (they change as the user answers). */
  lists(): FieldLists & ToolClassLists;
  /** Persist an answer to the *is this a path?* question (D-47d). */
  remember(field: string, isPath: boolean): void;
  /** Persist an answer to the *does this tool write?* question (D-48). */
  rememberWrite(writes: boolean): void;
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

/** What an MCP result renders to: the text the `tool` message carries, and the
 *  bytes that cannot ride inside it (P8e). The wire rejects image content in a
 *  `role:"tool"` message (D-78a), so images leave here as attachments and
 *  `buildWireMessages` flushes them into the `user` message that follows. */
export interface RenderedMcpContent {
  content: string;
  attachments: Attachment[];
}

export interface McpRenderOptions {
  /** May this session hand the model a picture? When false an image is named
   *  and dropped with the reason in the text — the same honest refusal
   *  `read_file` gives, rather than a 400 from the provider mid-turn (D-78c). */
  acceptsImages?: boolean;
  /** What to call an image in the wire's label and in the browser — the tool
   *  that produced it, e.g. `shots/screenshot`. */
  label?: string;
}

/**
 * One `image` block: kept as an attachment, or dropped with the reason said out
 * loud. Never silently discarded — that was the P8e defect, `renderMcpContent`
 * writing "not inlined" over a picture the model had asked for.
 *
 * The server's `mimeType` is a *claim*, exactly like a filename is (D-78b), so
 * the bytes decide. Only the head is decoded: enough for a signature, never the
 * whole blob just to learn it is not a PNG.
 */
async function takeImage(
  b: Record<string, unknown>,
  options: McpRenderOptions,
  attachments: Attachment[],
): Promise<string> {
  const claimed = typeof b.mimeType === "string" ? b.mimeType : "unknown";
  if (typeof b.data !== "string" || b.data === "") return `[image ${claimed} — dropped: the server sent no data]`;
  const bytes = base64Bytes(b.data);
  const size = humanBytes(bytes);
  if (options.acceptsImages !== true) {
    return `[image ${claimed}, ${size} — dropped: this conversation's model does not accept images]`;
  }
  if (bytes > MAX_IMAGE_BYTES) {
    const cap = humanBytes(MAX_IMAGE_BYTES);
    return `[image ${claimed}, ${size} — dropped: over the ${cap} an image may be to go to the model]`;
  }
  // 16384 base64 chars is 12 KB of bytes — comfortably past `SAMPLE_BYTES`, and
  // a multiple of 4, so the decode never lands mid-group.
  const kind = await classifySample(Buffer.from(b.data.slice(0, 16384), "base64"));
  if (kind.kind !== "image") {
    const actually = kind.kind === "binary" ? (kind.mime ?? "an unrecognised binary") : "text";
    const accepted = [...IMAGE_MIMES].join(", ");
    return `[image claimed as ${claimed}, ${size} — dropped: the bytes are ${actually}, not one of ${accepted}]`;
  }
  const name = `${options.label ?? "mcp"} image ${attachments.length + 1}`;
  attachments.push({ mime: kind.mime, data: b.data, name });
  return `[image (${kind.mime}, ${size}) — attached to the message after this result, as "${name}"]`;
}

/** Render MCP content blocks as the text a tool result carries, plus whatever
 *  could not be text (P8e). */
export async function renderMcpContent(
  result: {
    content?: unknown;
    structuredContent?: unknown;
    isError?: boolean;
  },
  options: McpRenderOptions = {},
): Promise<RenderedMcpContent> {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const parts: string[] = [];
  const attachments: Attachment[] = [];
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b.type === "image") {
      parts.push(await takeImage(b, options, attachments));
    } else if (b.type === "audio") {
      // No audio path exists yet — the wire builder only knows `image_url` — so
      // this still says what arrived rather than pretending it was handled.
      const bytes = typeof b.data === "string" ? Math.floor((b.data.length * 3) / 4) : 0;
      parts.push(`[audio ${String(b.mimeType ?? "unknown")}, ~${bytes} bytes — not inlined]`);
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
  return { content: parts.join("\n"), attachments };
}

/** Wrap one discovered MCP tool as a `Tool`. */
export function bridgeTool(binding: McpToolBinding): Tool {
  const hint = binding.info.annotations?.readOnlyHint;
  const verdict = () => classifyTool(binding.info.name, binding.lists(), hint);
  const name = bridgedToolName(binding.server, binding.info.name);
  const description = binding.info.description ?? `${binding.info.name} (MCP server "${binding.server}")`;
  return {
    name,
    // Live (D-48): `unknown` is treated exactly like `write` until answered.
    get kind(): ToolKind {
      return verdict() === "read" ? "read" : "command";
    },
    get mutates(): boolean {
      return verdict() !== "read";
    },
    writeUnknown: () => verdict() === "unknown",
    rememberWrite: (writes) => binding.rememberWrite(writes),
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
    execute: (args, ctx) => binding.call(binding.info.name, args, ctx),
  };
}
