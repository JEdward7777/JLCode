/**
 * P7a Tier-0: MCP settings loading/merging, the spawn environment, write-back of
 * learned path fields, and the pure path-field classifier (D-47a/d).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadSettings,
  readSettingsFile,
  serverEnv,
  settingsFiles,
  updateServerEntry,
} from "../src/mcp/config";
import {
  classifyArgs,
  classifyField,
  flattenStringArgs,
  looksLikePath,
  rememberField,
} from "../src/mcp/path-fields";

let dir: string;
let workspace: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-mcp-"));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-ws-"));
  env = { JLCODE_CONFIG_DIR: dir, JLCODE_DATA_DIR: dir };
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

function writeGlobal(settings: unknown): void {
  fs.writeFileSync(path.join(dir, "mcp_settings.json"), JSON.stringify(settings), "utf8");
}
function writeWorkspace(settings: unknown): void {
  fs.mkdirSync(path.join(workspace, ".jlcode"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".jlcode", "mcp_settings.json"), JSON.stringify(settings), "utf8");
}

describe("mcp settings", () => {
  it("reads KiloCode's shape verbatim, missing files are empty not fatal", () => {
    writeGlobal({
      mcpServers: {
        file_utils: { command: "uvx", args: ["--from", "git+https://x/y", "file-utils"], alwaysAllow: ["read_file_range"] },
      },
    });
    const loaded = loadSettings(workspace, env);
    expect(loaded.problems).toEqual([]);
    expect(loaded.servers).toHaveLength(1);
    expect(loaded.servers[0]!.name).toBe("file_utils");
    expect(loaded.servers[0]!.scope).toBe("global");
    expect(loaded.servers[0]!.config.alwaysAllow).toEqual(["read_file_range"]);
  });

  it("a workspace entry replaces the global one of the same name; others merge", () => {
    writeGlobal({ mcpServers: { a: { command: "one" }, b: { command: "two" } } });
    writeWorkspace({ mcpServers: { a: { command: "override" } } });
    const loaded = loadSettings(workspace, env);
    const byName = Object.fromEntries(loaded.servers.map((s) => [s.name, s]));
    expect(byName.a!.config.command).toBe("override");
    expect(byName.a!.scope).toBe("workspace");
    expect(byName.b!.config.command).toBe("two");
    expect(byName.b!.scope).toBe("global");
  });

  it("reports bad entries as problems and keeps the good ones", () => {
    writeGlobal({
      mcpServers: {
        good: { command: "ok" },
        remote: { url: "https://example.com/mcp" },
        broken: { args: ["no-command"] },
      },
    });
    const loaded = loadSettings(workspace, env);
    expect(loaded.servers.map((s) => s.name)).toEqual(["good"]);
    expect(loaded.problems.join(" ")).toMatch(/remote \(url\) servers are not supported/);
    expect(loaded.problems.join(" ")).toMatch(/missing a string "command"/);
  });

  it("invalid JSON is a problem, not a crash", () => {
    fs.writeFileSync(path.join(dir, "mcp_settings.json"), "{ nope", "utf8");
    const loaded = loadSettings(workspace, env);
    expect(loaded.servers).toEqual([]);
    expect(loaded.problems[0]).toMatch(/not valid JSON/);
  });

  it("env passes through as a name list or explicit object", () => {
    expect(serverEnv({ command: "x", env: ["PATH", "MISSING"] }, { PATH: "/bin" })).toEqual({ PATH: "/bin" });
    expect(serverEnv({ command: "x", env: { A: "1" } }, {})).toEqual({ A: "1" });
    expect(serverEnv({ command: "x" }, {})).toBeUndefined();
  });

  it("write-back updates one server and leaves the rest of the file alone", () => {
    writeGlobal({ mcpServers: { a: { command: "one", alwaysAllow: ["t"] }, b: { command: "two" } }, other: 42 });
    const file = settingsFiles(workspace, env).global;
    updateServerEntry(file, "a", (entry) => ({ ...entry, pathFields: ["path"] }));
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(raw.other).toBe(42);
    const servers = raw.mcpServers as Record<string, Record<string, unknown>>;
    expect(servers.a!.pathFields).toEqual(["path"]);
    expect(servers.a!.alwaysAllow).toEqual(["t"]); // untouched
    expect(servers.b!.command).toBe("two");
    expect(readSettingsFile(file).problems).toEqual([]);
  });

  it("write-back creates the file (and its dir) when absent", () => {
    const file = settingsFiles(workspace, env).workspace;
    updateServerEntry(file, "fresh", (entry) => ({ ...entry, command: "c", notPathFields: ["text"] }));
    const servers = (JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers;
    expect(servers.fresh).toMatchObject({ command: "c", notPathFields: ["text"] });
  });
});

describe("path-field classification (D-47d)", () => {
  it("flattens string leaves to jq-style names, collapsing array indices", () => {
    const flat = flattenStringArgs({
      path: "a/b",
      count: 3,
      opts: { root: "/tmp" },
      edits: [{ file: "x.txt" }, { file: "y.txt" }],
    });
    expect(flat).toEqual([
      { field: "path", value: "a/b" },
      { field: "opts.root", value: "/tmp" },
      { field: "edits[].file", value: "x.txt" },
      { field: "edits[].file", value: "y.txt" },
    ]);
  });

  it("only slashy values are path-shaped", () => {
    expect(looksLikePath("src/a.ts")).toBe(true);
    expect(looksLikePath("C:\\tmp\\a")).toBe(true);
    expect(looksLikePath("hello world")).toBe(false);
  });

  it("known lists win over the slash heuristic, in both directions", () => {
    const lists = { pathFields: ["target"], notPathFields: ["text"] };
    expect(classifyField("target", "notes", lists)).toBe("path"); // no slash, still a path
    expect(classifyField("text", "a/b/c", lists)).toBe("not-path"); // slashy, but known prose
    expect(classifyField("other", "a/b", lists)).toBe("unknown");
    expect(classifyField("other", "plain", lists)).toBe("not-path");
  });

  it("unclassified slashy args are fenced anyway and asked about once", () => {
    const { paths, unknown } = classifyArgs(
      { text: "no slashes", edits: [{ file: "a/1.txt" }, { file: "a/2.txt" }], known: "k/v" },
      { pathFields: ["known"] },
    );
    expect(paths.map((p) => p.value)).toEqual(["a/1.txt", "a/2.txt", "k/v"]);
    expect(unknown.map((u) => u.field)).toEqual(["edits[].file"]); // one question, not two
  });

  it("an answer moves the field between lists and never duplicates it", () => {
    let lists = rememberField({ notPathFields: ["f"] }, "f", true);
    expect(lists).toEqual({ pathFields: ["f"], notPathFields: [] });
    lists = rememberField(lists, "f", false);
    expect(lists).toEqual({ pathFields: [], notPathFields: ["f"] });
    expect(classifyArgs({ f: "a/b" }, lists).unknown).toEqual([]);
  });
});
