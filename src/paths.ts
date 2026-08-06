/**
 * Resolution of JLCode's OS-level config and data locations (SPEC §7, D-13).
 *
 * Two stores, both outside the project, both overridable by env so Docker (and
 * tests) can point them anywhere:
 *   - config store  ($JLCODE_CONFIG_DIR, default XDG config / platform equivalent)
 *   - data store    ($JLCODE_DATA_DIR,   default XDG data   / platform equivalent)
 *
 * Resolution reads the given environment at call time (defaulting to
 * `process.env`) so callers and tests can override without touching globals.
 */
import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";

export interface JlcodePaths {
  /** Config store dir — holds config.json (model configs, bindings, prefs). */
  readonly configDir: string;
  /** The single hand-editable settings file. */
  readonly configFile: string;
  /** Data store dir — conversations + logs. */
  readonly dataDir: string;
  /** One append-only JSONL log per conversation lives here (D-37). */
  readonly conversationsDir: string;
  /** Rotating diagnostic log + debug journals (D-11, D-15). */
  readonly logsDir: string;
  /** Cached OpenRouter model catalog — context windows per model id (D-44c). */
  readonly modelsCacheFile: string;
}

type Env = Record<string, string | undefined>;

function homeConfigBase(env: Env): string {
  if (process.platform === "win32") {
    return env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  }
  // POSIX + macOS: XDG-style. Many CLIs use ~/.config on macOS too; keep it simple.
  return env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
}

function homeDataBase(env: Env): string {
  if (process.platform === "win32") {
    return env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  }
  return env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
}

/** Resolve all JLCode paths from the environment (pure — creates nothing). */
export function resolvePaths(env: Env = process.env): JlcodePaths {
  const configDir = env.JLCODE_CONFIG_DIR ?? path.join(homeConfigBase(env), "jlcode");
  const dataDir = env.JLCODE_DATA_DIR ?? path.join(homeDataBase(env), "jlcode");
  return {
    configDir,
    configFile: path.join(configDir, "config.json"),
    dataDir,
    conversationsDir: path.join(dataDir, "conversations"),
    logsDir: path.join(dataDir, "logs"),
    modelsCacheFile: path.join(dataDir, "models.json"),
  };
}

/** Resolve paths and create the directories (idempotent). */
export function ensurePaths(env: Env = process.env): JlcodePaths {
  const paths = resolvePaths(env);
  for (const dir of [paths.configDir, paths.dataDir, paths.conversationsDir, paths.logsDir]) {
    mkdirSync(dir, { recursive: true });
  }
  return paths;
}
