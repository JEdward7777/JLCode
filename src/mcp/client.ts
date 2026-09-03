/**
 * The MCP client manager (D-47c) — one stdio child per enabled server, tools
 * discovered at startup and bridged into the native `Tool` set.
 *
 * A server that fails to start, fails to initialize, or times out is **reported,
 * not fatal**: the session runs with the tools it does have, and the failure
 * shows up in `statuses()`. That matters because these are third-party processes
 * on the user's machine — one broken entry must not cost them their agent.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool, ToolContext, ToolResult } from "../tools/types.js";
import type { LoadedSettings, McpServerConfig, ResolvedServer, SettingsScope } from "./config.js";
import { loadSettings, serverEnv, settingsFiles, updateServerEntry } from "./config.js";
import type { McpToolInfo } from "./bridge.js";
import { bridgeTool, renderMcpContent } from "./bridge.js";
import { rememberField } from "./path-fields.js";
import { rememberTool } from "./tool-class.js";
import { getVersion } from "../version.js";

const DEFAULT_TIMEOUT_SEC = 60;
const CONNECT_TIMEOUT_MS = 30_000;

export type McpServerState = "connected" | "disabled" | "failed";

/** One discovered tool, as the status surface shows it (P7b). */
export interface McpToolStatus {
  /** Name the model sees (`<server>__<tool>`). */
  name: string;
  /** Name on the server itself. */
  mcpName: string;
  description?: string;
  /** Gate class right now — `command` while presumed to write (D-47b/D-48). */
  kind: string;
  /** True while the class is a guess the user hasn't confirmed (D-48). */
  presumed: boolean;
  /** Pre-approved via the server's `alwaysAllow` (D-47b). */
  alwaysAllow: boolean;
}

export interface McpServerStatus {
  name: string;
  scope: SettingsScope;
  state: McpServerState;
  /** Tool names as the model sees them (`<server>__<tool>`). */
  tools: string[];
  /** The same tools with their gate class, for the browser panel (P7b). */
  toolInfo: McpToolStatus[];
  /** What the user has taught JLCode about this server (D-47d/D-48). */
  learned: { pathFields: string[]; notPathFields: string[]; writeTools: string[]; readTools: string[] };
  error?: string;
}

interface Connection {
  server: ResolvedServer;
  client?: Client;
  transport?: StdioClientTransport;
  status: McpServerStatus;
  /** Discovered tools, kept so the status surface can report their live class. */
  tools: { tool: Tool; info: McpToolInfo }[];
}

export interface McpManagerOptions {
  /** Workspace root — locates `.jlcode/mcp_settings.json` and is the child's cwd. */
  workspace: string;
  env?: Record<string, string | undefined>;
  /** Injected for tests; defaults to reading the real settings files. */
  settings?: LoadedSettings;
  /** Called when a settings write fails (non-fatal — the answer just isn't sticky). */
  onWriteError?: (error: Error) => void;
}

export class McpManager {
  private readonly connections: Connection[] = [];
  private readonly bridged: Tool[] = [];
  /** Non-fatal config complaints, surfaced with the statuses. */
  readonly problems: string[];
  private readonly files: { global: string; workspace: string };
  private readonly options: McpManagerOptions;

  private constructor(options: McpManagerOptions, settings: LoadedSettings) {
    this.options = options;
    this.problems = [...settings.problems];
    this.files = settings.files;
  }

  /** Load settings, start every enabled server, and discover its tools. */
  static async start(options: McpManagerOptions): Promise<McpManager> {
    const settings = options.settings ?? loadSettings(options.workspace, options.env ?? process.env);
    const manager = new McpManager(options, settings);
    await Promise.all(settings.servers.map((server) => manager.connect(server)));
    return manager;
  }

  private async connect(server: ResolvedServer): Promise<void> {
    if (server.config.disabled) {
      this.connections.push({ server, status: this.blankStatus(server, "disabled"), tools: [] });
      return;
    }
    const status = this.blankStatus(server, "failed");
    const connection: Connection = { server, status, tools: [] };
    this.connections.push(connection);
    try {
      const transport = new StdioClientTransport({
        command: server.config.command,
        args: server.config.args ?? [],
        ...(serverEnv(server.config, this.options.env ?? process.env) ? { env: serverEnv(server.config, this.options.env ?? process.env)! } : {}),
        cwd: this.options.workspace,
        stderr: "ignore",
      });
      const client = new Client({ name: "jlcode", version: getVersion() });
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
      connection.client = client;
      connection.transport = transport;
      const listed = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
      status.state = "connected";
      for (const info of listed.tools as McpToolInfo[]) {
        const tool = this.bridge(connection, info);
        this.bridged.push(tool);
        status.tools.push(tool.name);
        connection.tools.push({ tool, info });
      }
    } catch (e) {
      status.error = (e as Error).message;
      // Best-effort cleanup so a half-started child doesn't outlive us.
      await connection.client?.close().catch(() => {});
      await connection.transport?.close().catch(() => {});
    }
  }

  private bridge(connection: Connection, info: McpToolInfo): Tool {
    const { server } = connection;
    return bridgeTool({
      server: server.name,
      info,
      ...(server.config.alwaysAllow ? { alwaysAllow: server.config.alwaysAllow } : {}),
      lists: () => server.config,
      remember: (field, isPath) => this.remember(server, field, isPath),
      rememberWrite: (writes) => this.rememberWrite(server, info.name, writes),
      call: (toolName, args, ctx) => this.call(connection, toolName, args, ctx),
    });
  }

  /** Persist a path-field answer into the file that owns this server (D-47d). */
  private remember(server: ResolvedServer, field: string, isPath: boolean): void {
    const updated = rememberField(server.config, field, isPath);
    server.config.pathFields = updated.pathFields; // live, so the next call sees it
    server.config.notPathFields = updated.notPathFields;
    this.persist(server, updated);
  }

  /** Persist a *does this tool write?* answer, same file, same way (D-48). */
  private rememberWrite(server: ResolvedServer, tool: string, writes: boolean): void {
    const updated = rememberTool(server.config, tool, writes);
    server.config.writeTools = updated.writeTools; // live: the bridged tool's
    server.config.readTools = updated.readTools; //   kind/mutates read these
    this.persist(server, updated);
  }

  private persist(server: ResolvedServer, updated: Partial<McpServerConfig>): void {
    const file = server.scope === "workspace" ? this.files.workspace : this.files.global;
    try {
      updateServerEntry(file, server.name, (entry) => ({ ...entry, ...updated }));
    } catch (e) {
      this.options.onWriteError?.(e as Error);
    }
  }

  private async call(
    connection: Connection,
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const { client, server } = connection;
    if (!client) return { content: `MCP server "${server.name}" is not connected`, isError: true };
    const timeout = (server.config.timeout ?? DEFAULT_TIMEOUT_SEC) * 1000;
    try {
      const result = await client.callTool({ name: toolName, arguments: args }, undefined, { timeout });
      // The session's answer to "can this model see?" (P8e) — a bridged tool is
      // built once for the instance, so this cannot be baked in the way
      // `read_file`'s is; it arrives with the call.
      const { content, attachments } = await renderMcpContent(result as { content?: unknown; structuredContent?: unknown }, {
        acceptsImages: ctx.acceptsImages === true,
        label: `${server.name}/${toolName}`,
      });
      const carried = attachments.length > 0 ? { attachments } : {};
      return result.isError === true
        ? { content: content || "the MCP tool reported an error", isError: true, ...carried }
        : { content, ...carried };
    } catch (e) {
      return { content: `MCP call failed (${server.name}/${toolName}): ${(e as Error).message}`, isError: true };
    }
  }

  /** The bridged tools, ready to hand to a `ToolRegistry`. */
  tools(): Tool[] {
    return [...this.bridged];
  }

  private blankStatus(server: ResolvedServer, state: McpServerState): McpServerStatus {
    return { name: server.name, scope: server.scope, state, tools: [], toolInfo: [], learned: learnedOf(server.config) };
  }

  /** Live status — classes and learned lists are re-read, since answers land mid-session. */
  statuses(): McpServerStatus[] {
    return this.connections.map((c) => ({
      ...c.status,
      tools: [...c.status.tools],
      learned: learnedOf(c.server.config),
      toolInfo: c.tools.map(({ tool, info }) => ({
        name: tool.name,
        mcpName: info.name,
        ...(info.description ? { description: info.description } : {}),
        kind: tool.kind,
        presumed: tool.writeUnknown?.() === true,
        alwaysAllow: tool.autoApprove === true,
      })),
    }));
  }

  /** The server config as currently held (including learned fields) — for tests/UI. */
  serverConfig(name: string): McpServerConfig | undefined {
    return this.connections.find((c) => c.server.name === name)?.server.config;
  }

  async close(): Promise<void> {
    await Promise.all(
      this.connections.map(async (c) => {
        await c.client?.close().catch(() => {});
        await c.transport?.close().catch(() => {});
      }),
    );
  }
}

function learnedOf(config: McpServerConfig): McpServerStatus["learned"] {
  return {
    pathFields: [...(config.pathFields ?? [])],
    notPathFields: [...(config.notPathFields ?? [])],
    writeTools: [...(config.writeTools ?? [])],
    readTools: [...(config.readTools ?? [])],
  };
}

/** Convenience for the CLI: settings paths without starting anything. */
export function mcpSettingsFiles(workspace: string, env: Record<string, string | undefined> = process.env) {
  return settingsFiles(workspace, env);
}
