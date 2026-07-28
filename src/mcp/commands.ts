/**
 * `jlcode mcp …` subcommands: inspect the configured servers and import
 * KiloCode's `mcp_settings.json` (D-47a). Starting servers is the session's job;
 * `mcp list --probe` does it once, on demand, so a broken entry can be found
 * without launching a conversation.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs, flagString } from "../util/args.js";
import { loadSettings, kilocodeSettingsCandidates, readSettingsFile, settingsFiles } from "./config.js";
import { McpManager } from "./client.js";

const MCP_HELP = `jlcode mcp — MCP servers (KiloCode mcp_settings.json format)

  mcp list [--probe]        list configured servers (--probe starts them + lists tools)
  mcp import [--from <f>]   copy KiloCode's mcp_settings.json into JLCode's config
                            (--force overwrites servers of the same name)
  mcp path                  print the settings files JLCode reads

Global file: <config dir>/mcp_settings.json
Per-workspace override: <workspace>/.jlcode/mcp_settings.json (replaces a global entry)
`;

export async function runMcp(args: string[]): Promise<number> {
  const sub = args[0];
  const { positionals, flags } = parseArgs(args.slice(1));
  const cwd = process.cwd();

  switch (sub) {
    case undefined:
    case "help":
      process.stdout.write(MCP_HELP);
      return 0;

    case "path": {
      const files = settingsFiles(cwd);
      for (const [label, file] of [
        ["global", files.global],
        ["workspace", files.workspace],
      ] as const) {
        process.stdout.write(`${label.padEnd(10)} ${file}${fs.existsSync(file) ? "" : "  (not present)"}\n`);
      }
      return 0;
    }

    case "list": {
      const loaded = loadSettings(cwd);
      for (const problem of loaded.problems) process.stderr.write(`warning: ${problem}\n`);
      if (loaded.servers.length === 0) {
        process.stdout.write("No MCP servers configured. Try: jlcode mcp import\n");
        return 0;
      }
      if (flags.probe) {
        const manager = await McpManager.start({ workspace: cwd });
        for (const status of manager.statuses()) {
          const detail = status.state === "failed" ? `  ${status.error ?? ""}` : `  ${status.tools.length} tools`;
          process.stdout.write(`${status.state.padEnd(10)} ${status.name} (${status.scope})${detail}\n`);
          for (const tool of status.toolInfo) {
            // "presumed" = the strict class is JLCode's guess, settled at the
            // next pause the tool causes (D-48).
            const marks = [tool.kind, ...(tool.presumed ? ["presumed"] : []), ...(tool.alwaysAllow ? ["alwaysAllow"] : [])];
            process.stdout.write(`             ${tool.name}  [${marks.join(", ")}]\n`);
          }
        }
        await manager.close();
        return 0;
      }
      for (const server of loaded.servers) {
        const state = server.config.disabled ? "disabled" : "enabled";
        const cmd = [server.config.command, ...(server.config.args ?? [])].join(" ");
        process.stdout.write(`${state.padEnd(10)} ${server.name} (${server.scope})  ${cmd}\n`);
      }
      return 0;
    }

    case "import": {
      const from = flagString(flags, "from") ?? positionals[0] ?? kilocodeSettingsCandidates()[0];
      if (!from) {
        process.stderr.write("No KiloCode mcp_settings.json found. Pass one with --from <file>.\n");
        return 1;
      }
      const source = readSettingsFile(from);
      for (const problem of source.problems) process.stderr.write(`warning: ${problem}\n`);
      const names = Object.keys(source.settings.mcpServers);
      if (names.length === 0) {
        process.stderr.write(`No usable servers in ${from}.\n`);
        return 1;
      }
      const target = settingsFiles(cwd).global;
      const existing = readSettingsFile(target).settings.mcpServers;
      const merged = { ...existing };
      const added: string[] = [];
      const skipped: string[] = [];
      for (const [name, config] of Object.entries(source.settings.mcpServers)) {
        if (existing[name] && !flags.force) {
          skipped.push(name);
          continue;
        }
        merged[name] = config;
        added.push(name);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify({ mcpServers: merged }, null, 2) + "\n", "utf8");
      process.stdout.write(`Imported from ${from}\n`);
      if (added.length > 0) process.stdout.write(`  added: ${added.join(", ")}\n`);
      if (skipped.length > 0) process.stdout.write(`  kept existing (use --force to overwrite): ${skipped.join(", ")}\n`);
      process.stdout.write(`  → ${target}\n`);
      return 0;
    }

    default:
      process.stderr.write(`Unknown mcp subcommand: ${sub}\n\n${MCP_HELP}`);
      return 2;
  }
}
