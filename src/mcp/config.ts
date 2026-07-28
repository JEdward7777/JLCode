/**
 * MCP server settings (D-47a) — KiloCode's `mcp_settings.json` shape, verbatim,
 * so existing snippets port over by copy/paste (X-01).
 *
 * Two layers, merged by server name: the **global** file in JLCode's config store
 * and an optional **per-workspace** `.jlcode/mcp_settings.json`. A workspace entry
 * *replaces* the global one of the same name (whole-entry, not field-merge — one
 * place to look when a server misbehaves).
 *
 * JLCode adds two fields of its own to each entry — `pathFields` /
 * `notPathFields` (D-47d) — which is why JLCode owns the file rather than reading
 * KiloCode's in place: the learned answers get written back here.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths } from "../paths.js";

/** One server entry. KiloCode's keys + JLCode's two learned lists. */
export interface McpServerConfig {
  /** Executable to spawn (stdio transport — D-47c). */
  command: string;
  args?: string[];
  /**
   * Environment for the child. An **object** sets explicit values; an **array**
   * of names passes those through from JLCode's own environment (Joshua's real
   * KiloCode config uses `"env": ["PATH"]`, so both spellings are accepted).
   */
  env?: Record<string, string> | string[];
  disabled?: boolean;
  /** MCP tool names the user pre-approved on this server (D-47b). */
  alwaysAllow?: string[];
  /** Per-call timeout in **seconds** (KiloCode's unit). */
  timeout?: number;
  /** Flattened arg fields known to be filesystem paths → fenced (D-47d). */
  pathFields?: string[];
  /** Flattened arg fields known *not* to be paths → never fenced (D-47d). */
  notPathFields?: string[];
}

export interface McpSettings {
  mcpServers: Record<string, McpServerConfig>;
}

/** Where a merged server entry came from — the file its learned fields go back to. */
export type SettingsScope = "global" | "workspace";

export interface ResolvedServer {
  name: string;
  config: McpServerConfig;
  scope: SettingsScope;
}

export interface SettingsFiles {
  global: string;
  workspace: string;
}

/** The two candidate settings files for a workspace. */
export function settingsFiles(workspace: string, env: Record<string, string | undefined> = process.env): SettingsFiles {
  return {
    global: path.join(resolvePaths(env).configDir, "mcp_settings.json"),
    workspace: path.join(workspace, ".jlcode", "mcp_settings.json"),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate one entry; returns the reason it was rejected, or undefined if fine. */
function entryProblem(name: string, raw: unknown): string | undefined {
  if (!isRecord(raw)) return `server "${name}": entry must be an object`;
  if (typeof raw.command !== "string" || raw.command.trim() === "") {
    // `url` entries are remote transports — not in v1 (D-47c), and worth saying so.
    if (typeof raw.url === "string") return `server "${name}": remote (url) servers are not supported yet — stdio only`;
    return `server "${name}": missing a string "command"`;
  }
  if (raw.args !== undefined && !(Array.isArray(raw.args) && raw.args.every((a) => typeof a === "string"))) {
    return `server "${name}": "args" must be an array of strings`;
  }
  if (raw.env !== undefined && !isRecord(raw.env) && !(Array.isArray(raw.env) && raw.env.every((e) => typeof e === "string"))) {
    return `server "${name}": "env" must be an object or an array of variable names`;
  }
  return undefined;
}

export interface LoadedSettings {
  servers: ResolvedServer[];
  /** Non-fatal complaints (bad entry, unreadable file) — surfaced, never thrown. */
  problems: string[];
  files: SettingsFiles;
}

/** Read + parse one settings file. Missing file = empty, not an error. */
export function readSettingsFile(file: string): { settings: McpSettings; problems: string[] } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { settings: { mcpServers: {} }, problems: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { settings: { mcpServers: {} }, problems: [`${file}: not valid JSON (${(e as Error).message})`] };
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    return { settings: { mcpServers: {} }, problems: [`${file}: expected an object with an "mcpServers" map`] };
  }
  const servers: Record<string, McpServerConfig> = {};
  const problems: string[] = [];
  for (const [name, raw] of Object.entries(parsed.mcpServers)) {
    const problem = entryProblem(name, raw);
    if (problem) {
      problems.push(`${file}: ${problem}`);
      continue;
    }
    servers[name] = raw as McpServerConfig;
  }
  return { settings: { mcpServers: servers }, problems };
}

/** Load global + workspace settings and merge them by server name. */
export function loadSettings(workspace: string, env: Record<string, string | undefined> = process.env): LoadedSettings {
  const files = settingsFiles(workspace, env);
  const global = readSettingsFile(files.global);
  const workspaceFile = readSettingsFile(files.workspace);
  const merged = new Map<string, ResolvedServer>();
  for (const [name, config] of Object.entries(global.settings.mcpServers)) {
    merged.set(name, { name, config, scope: "global" });
  }
  for (const [name, config] of Object.entries(workspaceFile.settings.mcpServers)) {
    merged.set(name, { name, config, scope: "workspace" }); // workspace replaces global
  }
  return {
    servers: [...merged.values()],
    problems: [...global.problems, ...workspaceFile.problems],
    files,
  };
}

/** The spawn environment for a server entry (D-47c). */
export function serverEnv(
  config: McpServerConfig,
  parentEnv: Record<string, string | undefined> = process.env,
): Record<string, string> | undefined {
  if (config.env === undefined) return undefined;
  if (Array.isArray(config.env)) {
    const out: Record<string, string> = {};
    for (const name of config.env) {
      const value = parentEnv[name];
      if (value !== undefined) out[name] = value;
    }
    return out;
  }
  return config.env;
}

/**
 * Update one server entry in the file that owns it, preserving everything else
 * in that file (it is hand-editable — D-47a). Used to persist a learned path
 * field, so it must not reformat away the user's other servers.
 */
export function updateServerEntry(
  file: string,
  name: string,
  mutate: (entry: McpServerConfig) => McpServerConfig,
): void {
  const { settings } = readSettingsFile(file);
  const current = settings.mcpServers[name] ?? ({ command: "" } as McpServerConfig);
  const next = mutate({ ...current });
  // Re-read the raw file so unknown keys and other servers survive untouched.
  let raw: Record<string, unknown> = { mcpServers: {} };
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (isRecord(parsed)) raw = parsed;
  } catch {
    /* missing or unparseable → start from an empty shell */
  }
  const servers = isRecord(raw.mcpServers) ? raw.mcpServers : {};
  raw.mcpServers = { ...servers, [name]: { ...(isRecord(servers[name]) ? servers[name] : {}), ...next } };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + "\n", "utf8");
}

/** Candidate locations of KiloCode's own `mcp_settings.json`, for `mcp import`. */
export function kilocodeSettingsCandidates(home: string = os.homedir()): string[] {
  const editors = ["VSCodium", "Code", "Code - OSS", "Cursor"];
  const bases =
    process.platform === "win32"
      ? [path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"))]
      : process.platform === "darwin"
        ? [path.join(home, "Library", "Application Support"), path.join(home, ".config")]
        : [path.join(home, ".config")];
  const out: string[] = [];
  for (const base of bases) {
    for (const editor of editors) {
      const settingsDir = path.join(base, editor, "User", "globalStorage");
      let entries: string[];
      try {
        entries = fs.readdirSync(settingsDir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.startsWith("kilocode")) continue;
        const file = path.join(settingsDir, entry, "settings", "mcp_settings.json");
        if (fs.existsSync(file)) out.push(file);
      }
    }
  }
  return out;
}
