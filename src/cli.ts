#!/usr/bin/env node
/**
 * JLCode CLI entry point (D-22, npx-compatible). Phase 0 wired the dirs +
 * logger; Phase 1 adds the config store and folder-aware model selection.
 * The agent loop and HTTP server arrive in later phases.
 */
import { ensurePaths, resolvePaths } from "./paths.js";
import { createLogger } from "./logger.js";
import { getVersion } from "./version.js";
import { runConfig } from "./config/commands.js";
import { loadConfig } from "./config/store.js";
import { resolveForCwd } from "./config/operations.js";
import { runChat } from "./session/chat-command.js";
import { runServe } from "./server/serve-command.js";

const HELP = `jlcode ${getVersion()} — a from-scratch coding agent

Usage:
  jlcode [command]

Commands:
  info, paths     Resolve and create the config/data dirs, then print them
  config …        Manage model configurations (list/which/use/clone/add/remove)
  chat            Start a terminal conversation with the selected config
  serve           Start the dev HTTP endpoint (curl /chat, retains threads)
  version         Print the version
  help            Show this help

Environment:
  JLCODE_CONFIG_DIR   override the config store location
  JLCODE_DATA_DIR     override the data store location
  JLCODE_LOG_LEVEL    error | warn | info | debug   (default: info)
`;

function printInfo(): void {
  const paths = ensurePaths();
  const logger = createLogger({ dir: paths.logsDir });
  logger.debug("cli.info invoked", { version: getVersion() });
  const selected = resolveForCwd(loadConfig(paths), process.cwd());
  const rows: Array<[string, string]> = [
    ["version", getVersion()],
    ["config dir", paths.configDir],
    ["config file", paths.configFile],
    ["data dir", paths.dataDir],
    ["conversations", paths.conversationsDir],
    ["logs", paths.logsDir],
    ["cwd config", selected ? `${selected.name} (${selected.model})` : "(none — jlcode config use <name>)"],
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [key, value] of rows) {
    process.stdout.write(`${key.padEnd(width)}  ${value}\n`);
  }
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  switch (command) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(HELP);
      return 0;
    case "version":
    case "-v":
    case "--version":
      process.stdout.write(`${getVersion()}\n`);
      return 0;
    case "info":
    case "paths":
      printInfo();
      return 0;
    case "config":
      return runConfig(argv.slice(1));
    case "chat":
      return runChat(argv.slice(1));
    case "serve":
      return runServe(argv.slice(1));
    default: {
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      return 2;
    }
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    try {
      createLogger({ dir: resolvePaths().logsDir }).error("cli crashed", { err });
    } catch {
      // ignore secondary failure
    }
    process.stderr.write(`jlcode: ${(err as Error).message}\n`);
    process.exit(1);
  });
