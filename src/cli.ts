#!/usr/bin/env node
/**
 * JLCode CLI entry point (D-22, npx-compatible). Phase 0 is a scaffold: it
 * resolves its OS-level dirs, wires the diagnostic logger, and reports status.
 * Real commands (config selection, the agent loop, the HTTP server) arrive in
 * later phases.
 */
import { ensurePaths, resolvePaths } from "./paths.js";
import { createLogger } from "./logger.js";
import { getVersion } from "./version.js";

const HELP = `jlcode ${getVersion()} — a from-scratch coding agent

Usage:
  jlcode [command]

Commands:
  info, paths     Resolve and create the config/data dirs, then print them
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
  const rows: Array<[string, string]> = [
    ["version", getVersion()],
    ["config dir", paths.configDir],
    ["config file", paths.configFile],
    ["data dir", paths.dataDir],
    ["conversations", paths.conversationsDir],
    ["logs", paths.logsDir],
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [key, value] of rows) {
    process.stdout.write(`${key.padEnd(width)}  ${value}\n`);
  }
}

function main(argv: string[]): number {
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
    default: {
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      return 2;
    }
  }
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  // Last-resort: record to the diagnostic log if we can, then surface.
  try {
    const paths = resolvePaths();
    createLogger({ dir: paths.logsDir }).error("cli crashed", { err });
  } catch {
    // ignore secondary failure
  }
  process.stderr.write(`jlcode: fatal: ${(err as Error).message}\n`);
  process.exit(1);
}
