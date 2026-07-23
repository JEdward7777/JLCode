import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { resolvePaths } from "../src/paths";

describe("resolvePaths", () => {
  it("honors JLCODE_CONFIG_DIR / JLCODE_DATA_DIR overrides", () => {
    const p = resolvePaths({ JLCODE_CONFIG_DIR: "/x/cfg", JLCODE_DATA_DIR: "/x/data" });
    expect(p.configDir).toBe("/x/cfg");
    expect(p.configFile).toBe(path.join("/x/cfg", "config.json"));
    expect(p.dataDir).toBe("/x/data");
    expect(p.conversationsDir).toBe(path.join("/x/data", "conversations"));
    expect(p.logsDir).toBe(path.join("/x/data", "logs"));
  });

  it.skipIf(process.platform === "win32")("uses XDG base dirs when set (POSIX)", () => {
    const p = resolvePaths({ XDG_CONFIG_HOME: "/xdg/cfg", XDG_DATA_HOME: "/xdg/data" });
    expect(p.configDir).toBe(path.join("/xdg/cfg", "jlcode"));
    expect(p.dataDir).toBe(path.join("/xdg/data", "jlcode"));
  });

  it.skipIf(process.platform === "win32")("falls back to ~/.config and ~/.local/share (POSIX)", () => {
    const p = resolvePaths({});
    expect(p.configDir).toBe(path.join(os.homedir(), ".config", "jlcode"));
    expect(p.dataDir).toBe(path.join(os.homedir(), ".local", "share", "jlcode"));
  });

  it("keeps conversations and logs under the data dir", () => {
    const p = resolvePaths({ JLCODE_DATA_DIR: "/d" });
    expect(p.conversationsDir.startsWith("/d")).toBe(true);
    expect(p.logsDir.startsWith("/d")).toBe(true);
  });
});
