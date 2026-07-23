import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { resolvePaths } from "../src/paths";
import { loadConfig, saveConfig, defaultConfig } from "../src/config/store";
import { addModelConfig } from "../src/config/operations";

let dir: string;
let paths: ReturnType<typeof resolvePaths>;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "jlcode-cfg-"));
  paths = resolvePaths({ JLCODE_CONFIG_DIR: path.join(dir, "cfg"), JLCODE_DATA_DIR: path.join(dir, "data") });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("config store", () => {
  it("returns a default config when the file is missing", () => {
    const c = loadConfig(paths);
    expect(c.version).toBe(1);
    expect(c.modelConfigs).toEqual([]);
    expect(c.folderBindings).toEqual({});
  });

  it("round-trips a saved config", () => {
    const { config } = addModelConfig(defaultConfig(), {
      name: "Client A — Opus",
      model: "anthropic/opus",
      openRouterKey: "sk-secret",
      defaultMode: "plan",
      defaultApproval: "auto-safe",
    });
    saveConfig(config, paths);
    const loaded = loadConfig(paths);
    expect(loaded.modelConfigs).toHaveLength(1);
    expect(loaded.modelConfigs[0]!.name).toBe("Client A — Opus");
    expect(loaded.modelConfigs[0]!.defaultMode).toBe("plan");
    expect(loaded.modelConfigs[0]!.openRouterKey).toBe("sk-secret");
  });

  it.skipIf(process.platform === "win32")("writes the config file with 0600 perms", () => {
    saveConfig(defaultConfig(), paths);
    const mode = statSync(paths.configFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("normalizes a malformed file: drops invalid entries, coerces types", () => {
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(
      paths.configFile,
      JSON.stringify({
        modelConfigs: [{ name: "no id" }, { id: "cfg_x", name: "ok", model: "m" }],
        folderBindings: { "/x": 5, "/y": "cfg_x" },
      }),
    );
    const c = loadConfig(paths);
    expect(c.modelConfigs.map((m) => m.id)).toEqual(["cfg_x"]);
    expect(c.modelConfigs[0]!.defaultMode).toBe("code"); // coerced default
    expect(c.folderBindings).toEqual({ "/y": "cfg_x" }); // non-string dropped
  });
});
