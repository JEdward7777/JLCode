/**
 * Read/write the config store. The file is precious and holds secrets, so
 * writes are atomic (temp → rename) and the file is chmod 600 (D-13, SPEC §12).
 * There is no schema library (minimize deps, D-25) — the loader defensively
 * normalizes an unknown JSON blob into a well-formed Config.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import path from "node:path";
import type { JlcodePaths } from "../paths.js";
import { resolvePaths } from "../paths.js";
import { CONFIG_VERSION, type Config, type ModelConfig } from "./types.js";

export function defaultConfig(): Config {
  return { version: CONFIG_VERSION, modelConfigs: [], folderBindings: {}, autoSafeAllowlist: [] };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Coerce an unknown entry into a ModelConfig, dropping ones missing essentials. */
function normalizeModelConfig(raw: unknown): ModelConfig | undefined {
  const r = asRecord(raw);
  if (typeof r.id !== "string" || typeof r.name !== "string") return undefined;
  const now = new Date().toISOString();
  return {
    id: r.id,
    name: r.name,
    openRouterKey: typeof r.openRouterKey === "string" ? r.openRouterKey : "",
    model: typeof r.model === "string" ? r.model : "",
    reasoningEffort: r.reasoningEffort as ModelConfig["reasoningEffort"],
    sampling: r.sampling as ModelConfig["sampling"],
    systemPromptAddendum:
      typeof r.systemPromptAddendum === "string" ? r.systemPromptAddendum : undefined,
    defaultMode: (r.defaultMode as ModelConfig["defaultMode"]) ?? "code",
    defaultApproval: (r.defaultApproval as ModelConfig["defaultApproval"]) ?? "manual",
    compaction: r.compaction as ModelConfig["compaction"],
    createdAt: typeof r.createdAt === "string" ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : now,
  };
}

function normalize(raw: unknown): Config {
  const r = asRecord(raw);
  const modelConfigs = Array.isArray(r.modelConfigs)
    ? r.modelConfigs.map(normalizeModelConfig).filter((c): c is ModelConfig => c !== undefined)
    : [];
  const bindings = asRecord(r.folderBindings);
  const folderBindings: Record<string, string> = {};
  for (const [dir, id] of Object.entries(bindings)) {
    if (typeof id === "string") folderBindings[dir] = id;
  }
  return {
    version: typeof r.version === "number" ? r.version : CONFIG_VERSION,
    modelConfigs,
    folderBindings,
    autoSafeAllowlist: Array.isArray(r.autoSafeAllowlist)
      ? r.autoSafeAllowlist.filter((c): c is string => typeof c === "string")
      : [],
    prefs: r.prefs as Config["prefs"],
  };
}

/** Load the config, returning a fresh default if the file does not exist. */
export function loadConfig(paths: JlcodePaths = resolvePaths()): Config {
  let text: string;
  try {
    text = readFileSync(paths.configFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig();
    throw err;
  }
  return normalize(JSON.parse(text));
}

/** Persist the config atomically with restrictive permissions. */
export function saveConfig(config: Config, paths: JlcodePaths = resolvePaths()): void {
  mkdirSync(paths.configDir, { recursive: true });
  const tmp = path.join(paths.configDir, `.config.json.${process.pid}.tmp`);
  const text = JSON.stringify(config, null, 2) + "\n";
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, paths.configFile);
  try {
    chmodSync(paths.configFile, 0o600);
  } catch {
    // best effort (e.g. Windows) — permissions are advisory there
  }
}
