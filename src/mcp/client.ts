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
import type { Tool, ToolResult } from "../tools/types.js";
import type { LoadedSettings, McpServerConfig, ResolvedServer, SettingsScope } from "./config.js";
import { loadSettings, serverEnv, settingsFiles, updateServerEntry } from "./config.js";
import type { McpToolInfo } from "./bridge.js";
import { bridgeTool, renderMcpContent } from "./bridge.js";
import { rememberField } from "./path-fields.js";
import { getVersion } from "../version.js";

const DEFAULT_TIMEOUT_SEC = 60;
const CONNECT_TIMEOUT_MS = 30_000;

export type McpServerState = "connected" | "disabled" | "failed";

export interface McpServerStatus {
  name: string;
  scope: SettingsScope;
  state: McpServerState;
  /** Tool names as the model sees them (`<server>__<tool>`). */
  tools: string[];
  error?: string;
}

interface Connection {
  server: ResolvedServer;
  client?: Client;
  transport?: StdioClientTransport;
  status: McpServerStatus;
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
      this.connections.push({ server, status: { name: server.name, scope: server.scope, state: "disabled", tools: [] } });
      return;
    }
    const status: McpServerStatus = { name: server.name, scope: server.scope, state: "failed", tools: [] };
    const connection: Connection = { server, status };
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
      call: (toolName, args) => this.call(connection, toolName, args),
    });
  }

  /** Persist a path-field answer into the file that owns this server (D-47d). */
  private remember(server: ResolvedServer, field: string, isPath: boolean): void {
    const updated = rememberField(server.config, field, isPath);
    server.config.pathFields = updated.pathFields; // live, so the next call sees it
    server.config.notPathFields = updated.notPathFields;
    const file = server.scope === "workspace" ? this.files.workspace : this.files.global;
    try {
      updateServerEntry(file, server.name, (entry) => ({ ...entry, ...updated }));
    } catch (e) {
      this.options.onWriteError?.(e as Error);
    }
  }

  private async call(connection: Connection, toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    const { client, server } = connection;
    if (!client) return { content: `MCP server "${server.name}" is not connected`, isError: true };
    const timeout = (server.config.timeout ?? DEFAULT_TIMEOUT_SEC) * 1000;
    try {
      const result = await client.callTool({ name: toolName, arguments: args }, undefined, { timeout });
      const content = renderMcpContent(result as { content?: unknown; structuredContent?: unknown });
      return result.isError === true
        ? { content: content || "the MCP tool reported an error", isError: true }
        : { content };
    } catch (e) {
      return { content: `MCP call failed (${server.name}/${toolName}): ${(e as Error).message}`, isError: true };
    }
  }

  /** The bridged tools, ready to hand to a `ToolRegistry`. */
  tools(): Tool[] {
    return [...this.bridged];
  }

  statuses(): McpServerStatus[] {
    return this.connections.map((c) => ({ ...c.status, tools: [...c.status.tools] }));
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

/** Convenience for the CLI: settings paths without starting anything. */
export function mcpSettingsFiles(workspace: string, env: Record<string, string | undefined> = process.env) {
  return settingsFiles(workspace, env);
}
