/**
 * X-15 — JLCode reads the workspace's own agent-instruction file.
 *
 * Joshua, twice: *"have JLCode auto read any AGENTS.md file … so that you can
 * wire up a harness which auto integrates."* Until this, the system prompt was
 * `BASE_SYSTEM` plus a per-*config* addendum and nothing was ever read from the
 * workspace — so the harness pattern JLCode is built around worked for Claude
 * Code and not for JLCode, in JLCode's own repo.
 *
 * Two of these assertions are the whole design and are worth naming:
 *
 *  - **Read once, never per turn.** The system message is the stable prompt-cache
 *    prefix (D-26). A file re-read into a re-rendered system message every turn
 *    invalidates the entire cached prefix every turn — the exact defect D-58
 *    fixed at a measured 12.3x. Asserted directly, by *changing the file on disk
 *    mid-session* and demanding the system message not move a byte.
 *  - **At the `serve` wiring level.** H-06 and D-60 both hid for a month behind
 *    unit tests that built their own `Session` and injected what production
 *    forgot to pass. So the wiring assertions here run through
 *    `createSessionFactory` — the function `runServe` actually hands the server.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  INSTRUCTION_FILENAMES,
  MAX_INSTRUCTION_BYTES,
  describeWorkspaceInstructions,
  readWorkspaceInstructions,
  renderProjectInstructions,
  summarizeProjectInstructions,
} from "../src/workspace/instructions";
import { createSessionFactory } from "../src/server/session-factory";
import { ModelCatalog } from "../src/llm/models";
import { Session } from "../src/session/session";
import { scriptedDriver } from "../src/session/fake";
import { projectInstructionsEnabled, addModelConfig, updateModelConfig } from "../src/config/operations";
import { runConfig } from "../src/config/commands";
import { loadConfig, saveConfig } from "../src/config/store";
import { resolvePaths } from "../src/paths";
import type { JlcodePaths } from "../src/paths";
import type { ModelConfig } from "../src/config/types";
import type { ChatRequest, LlmDriver, StreamEvent } from "../src/llm/types";

/** A temp workspace. `.git` at its root is not decoration: it is where the
 *  upward walk stops (X-15b), so without it a test would readdir `/tmp` and `/`
 *  and could, in principle, find a stray file that isn't ours. */
function workspace(prefix = "jlcode-x15-"): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  fs.mkdirSync(path.join(dir, ".git"));
  return dir;
}

const write = (dir: string, name: string, body: string): void => {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), body);
};

// ---------------------------------------------------------------------------

describe("finding the workspace's instruction file (X-15a/b)", () => {
  let dir: string;
  beforeEach(() => {
    dir = workspace();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("reads AGENTS.md from the launch directory — the ask, verbatim", () => {
    write(dir, "AGENTS.md", "# House rules\nUse python3.\n");
    const found = readWorkspaceInstructions(dir, { home: dir });
    expect(found?.name).toBe("AGENTS.md");
    expect(found?.text).toContain("Use python3.");
    expect(found?.dir).toBe(dir);
    expect(found?.truncated).toBe(false);
  });

  it("prefers AGENTS.md over CLAUDE.md, and reads exactly one file", () => {
    write(dir, "AGENTS.md", "from agents\n");
    write(dir, "CLAUDE.md", "from claude\n");
    const found = readWorkspaceInstructions(dir, { home: dir });
    expect(found?.name).toBe("AGENTS.md");
    // First hit *wins* — it does not concatenate. A repo carrying both usually
    // carries the same rules twice, and concatenating bills for them twice on
    // every turn of the session.
    expect(found?.text).not.toContain("from claude");
  });

  it("falls back through the precedence list — including this repo's own CLAUDE.md", () => {
    const order: string[] = [];
    for (const name of INSTRUCTION_FILENAMES) {
      write(dir, name, `rules from ${name}\n`);
      order.push(name);
    }
    // Remove them one at a time, highest precedence first; each removal must
    // hand over to exactly the next name in the list.
    for (const name of order) {
      expect(readWorkspaceInstructions(dir, { home: dir })?.name).toBe(name);
      fs.rmSync(path.join(dir, name));
    }
    expect(readWorkspaceInstructions(dir, { home: dir })).toBeUndefined();
  });

  it("matches case-insensitively, so a repo behaves the same on Linux and macOS", () => {
    write(dir, "agents.md", "lowercase\n");
    expect(readWorkspaceInstructions(dir, { home: dir })?.text).toBe("lowercase");
  });

  it("treats an empty file as no instructions and keeps looking", () => {
    write(dir, "AGENTS.md", "   \n\n");
    write(dir, "CLAUDE.md", "the real rules\n");
    // `touch AGENTS.md` must neither inject an empty heading nor shadow the
    // file next to it that actually says something.
    expect(readWorkspaceInstructions(dir, { home: dir })?.name).toBe("CLAUDE.md");
  });

  it("walks up to the repo root when launched in a subdirectory", () => {
    write(dir, "AGENTS.md", "repo-wide rules\n");
    const sub = path.join(dir, "packages", "web");
    fs.mkdirSync(sub, { recursive: true });
    const found = readWorkspaceInstructions(sub, { home: dir });
    expect(found?.text).toBe("repo-wide rules");
    expect(found?.dir).toBe(dir);
  });

  it("prefers the nearest file when a subdirectory has one of its own", () => {
    write(dir, "AGENTS.md", "repo-wide rules\n");
    const sub = path.join(dir, "packages", "web");
    write(sub, "AGENTS.md", "just this package\n");
    expect(readWorkspaceInstructions(sub, { home: dir })?.text).toBe("just this package");
  });

  it("stops at the repo root — a file above it is never read", () => {
    // `dir` holds the `.git`; its parent is outside the project entirely.
    const outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-x15-outer-")));
    const repo = path.join(outer, "repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    write(outer, "AGENTS.md", "someone else's rules\n");
    try {
      expect(readWorkspaceInstructions(repo, { home: outer })).toBeUndefined();
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  });

  it("stops at $HOME for a workspace that is not a repo at all", () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-x15-home-")));
    const work = path.join(home, "scratch");
    fs.mkdirSync(work);
    write(home, "AGENTS.md", "home rules\n");
    try {
      // Reached because $HOME is walked *inclusively*: it is the last stop, not
      // a directory that is skipped.
      expect(readWorkspaceInstructions(work, { home })?.text).toBe("home rules");
      // …but nothing above it is.
      expect(readWorkspaceInstructions(home, { home })?.text).toBe("home rules");
      const parent = path.dirname(home);
      write(parent, ".cursorrules", "way up there\n");
      try {
        expect(readWorkspaceInstructions(work, { home, filenames: [".cursorrules"] })).toBeUndefined();
      } finally {
        fs.rmSync(path.join(parent, ".cursorrules"), { force: true });
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns nothing — and does not throw — when there is no file and no directory", () => {
    expect(readWorkspaceInstructions(dir, { home: dir })).toBeUndefined();
    expect(readWorkspaceInstructions(path.join(dir, "nope", "nope"), { home: dir })).toBeUndefined();
  });

  it("finds JLCode's own CLAUDE.md from JLCode's own tree", () => {
    // The point of the whole row: *this* repo's harness now auto-integrates.
    // Located from this file rather than from cwd, so it holds wherever vitest
    // is invoked from.
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const found = readWorkspaceInstructions(repoRoot);
    expect(found?.name).toBe("CLAUDE.md");
    expect(found?.text).toContain("JLCode");
  });
});

// ---------------------------------------------------------------------------

describe("the size cap (X-15e)", () => {
  let dir: string;
  beforeEach(() => {
    dir = workspace();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("truncates an over-cap file at a line boundary and says so", () => {
    const line = "x".repeat(99) + "\n";
    write(dir, "AGENTS.md", line.repeat(50)); // 5,000 bytes
    const found = readWorkspaceInstructions(dir, { home: dir, maxBytes: 1000 })!;
    expect(found.truncated).toBe(true);
    expect(found.bytes).toBe(5000);
    expect(found.injectedBytes).toBeLessThanOrEqual(1000);
    // Cut on a newline, so the model never reads half a rule.
    expect(found.text.split("\n").every((l) => l === "x".repeat(99))).toBe(true);
    const block = renderProjectInstructions(found);
    expect(block).toContain("Truncated");
    expect(block).toContain("5,000 bytes");
  });

  it("leaves a file under the cap completely alone", () => {
    write(dir, "AGENTS.md", "short\n");
    const found = readWorkspaceInstructions(dir, { home: dir })!;
    expect(found.truncated).toBe(false);
    expect(found.bytes).toBe(6);
    expect(renderProjectInstructions(found)).not.toContain("Truncated");
  });

  it("caps at 32 KiB by default", () => {
    expect(MAX_INSTRUCTION_BYTES).toBe(32 * 1024);
    write(dir, "AGENTS.md", ("y".repeat(80) + "\n").repeat(1000)); // ~81 KB
    const found = readWorkspaceInstructions(dir, { home: dir })!;
    expect(found.truncated).toBe(true);
    expect(found.injectedBytes).toBeLessThanOrEqual(MAX_INSTRUCTION_BYTES);
  });
});

// ---------------------------------------------------------------------------

describe("the injected block (X-15c/g)", () => {
  it("names the file, its directory, and that it was read once", () => {
    const block = renderProjectInstructions({
      path: "/work/repo/AGENTS.md",
      name: "AGENTS.md",
      dir: "/work/repo",
      text: "Use python3.",
      bytes: 12,
      injectedBytes: 12,
      truncated: false,
    });
    expect(block).toContain("# Project instructions (AGENTS.md)");
    expect(block).toContain("/work/repo/AGENTS.md");
    expect(block).toContain("Use python3.");
    // X-15g, stated to the model rather than only in the log: the agent can edit
    // this file with its own tools, and must not assume the edit took effect.
    expect(block).toContain("read once");
    expect(block).toContain("next session");
  });

  it("describes what was loaded for a human surface", () => {
    const found = {
      path: "/work/repo/AGENTS.md",
      name: "AGENTS.md",
      dir: "/work/repo",
      text: "x",
      bytes: 2100,
      injectedBytes: 2100,
      truncated: false,
    };
    expect(describeWorkspaceInstructions(found, "/work/repo")).toBe("AGENTS.md (2.1 KB)");
    // Found above the launch dir → shown as the path you'd type to open it.
    expect(describeWorkspaceInstructions(found, "/work/repo/packages/web")).toContain("AGENTS.md");
    expect(describeWorkspaceInstructions(found, "/work/repo/packages/web")).toContain("..");
    expect(describeWorkspaceInstructions(undefined)).toContain("none");
    expect(describeWorkspaceInstructions(undefined)).toContain("AGENTS.md");
    expect(describeWorkspaceInstructions({ ...found, truncated: true, bytes: 91204 })).toContain("truncated");
  });
});

// ---------------------------------------------------------------------------

const modelConfig = (over: Partial<ModelConfig> = {}): ModelConfig => ({
  id: "cfg_x15",
  name: "Test",
  openRouterKey: "sk",
  model: "anthropic/claude-opus-5",
  defaultMode: "code",
  defaultApproval: "manual",
  createdAt: "",
  updatedAt: "",
  ...over,
});

const reply = (text: string): StreamEvent[] => [
  { type: "text", delta: text },
  { type: "finish", reason: "stop" },
  { type: "usage", usage: { promptTokens: 10, completionTokens: 5 } },
];

/** A driver that keeps every request it was handed. `tool_choice:"none"` marks
 *  the ephemeral title/compaction asks (D-29/X-09), which are not turns. */
function recordingDriver(): { driver: LlmDriver; turns: ChatRequest[] } {
  const turns: ChatRequest[] = [];
  const driver = scriptedDriver((req) => {
    if (req.tool_choice !== "none") turns.push(structuredClone(req));
    return reply("ok");
  });
  return { driver, turns };
}

const systemOf = (req: ChatRequest): string => {
  const first = req.messages[0]!;
  expect(first.role).toBe("system");
  return first.content as string;
};

describe("system-prompt composition order (X-15c)", () => {
  it("puts the workspace's instructions after the base and before the config addendum", () => {
    const { driver, turns } = recordingDriver();
    const session = new Session({
      config: modelConfig({ systemPromptAddendum: "CLIENT-ADDENDUM" }),
      driver,
      projectInstructions: "PROJECT-BLOCK",
    });
    const system = systemOf(session.buildRequest());
    expect(system).toContain("You are JLCode");
    // The per-config addendum sits **last** on purpose (X-15c): it is the more
    // specific of the two, so where a project and a client disagree, the client
    // config — the thing the operator chose most recently — is what wins.
    expect(system.indexOf("You are JLCode")).toBeLessThan(system.indexOf("PROJECT-BLOCK"));
    expect(system.indexOf("PROJECT-BLOCK")).toBeLessThan(system.indexOf("CLIENT-ADDENDUM"));
    expect(turns).toHaveLength(0);
  });

  it("changes nothing at all when the workspace ships no instructions", () => {
    const session = new Session({ config: modelConfig(), driver: recordingDriver().driver });
    expect(systemOf(session.buildRequest())).toBe("You are JLCode, a helpful coding agent.");
  });
});

// ---------------------------------------------------------------------------

describe("serve's session factory — the level H-06 lived at (X-15)", () => {
  let root: string;
  let work: string;
  let paths: JlcodePaths;
  let catalog: ModelCatalog;

  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-x15-serve-")));
    work = path.join(root, "work");
    fs.mkdirSync(path.join(work, ".git"), { recursive: true });
    paths = resolvePaths({ JLCODE_CONFIG_DIR: path.join(root, "config"), JLCODE_DATA_DIR: path.join(root, "data") });
    fs.mkdirSync(paths.configDir, { recursive: true });
    catalog = new ModelCatalog({
      file: paths.modelsCacheFile,
      fetch: (async () =>
        new Response(JSON.stringify({ data: [{ id: "anthropic/claude-opus-5", context_length: 1_000_000 }] }), {
          status: 200,
        })) as unknown as typeof fetch,
    });
    await catalog.refresh();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const factory = (driver: LlmDriver) =>
    createSessionFactory({ paths, cwd: work, makeDriver: () => driver, mcpTools: () => [], catalog });

  it("a session `serve` builds carries the workspace's AGENTS.md", () => {
    write(work, "AGENTS.md", "# House rules\nAlways use python3, never python.\n");
    const { driver } = recordingDriver();
    const session = factory(driver)(modelConfig());
    const system = systemOf(session.buildRequest());
    expect(system).toContain("Always use python3, never python.");
    expect(system).toContain("# Project instructions (AGENTS.md)");
  });

  it("…and the config addendum still lands last, through the real factory", () => {
    write(work, "AGENTS.md", "PROJECT-RULE\n");
    const session = factory(recordingDriver().driver)(modelConfig({ systemPromptAddendum: "CLIENT-RULE" }));
    const system = systemOf(session.buildRequest());
    expect(system.indexOf("PROJECT-RULE")).toBeLessThan(system.indexOf("CLIENT-RULE"));
  });

  it("reads nothing when the workspace ships nothing", () => {
    const session = factory(recordingDriver().driver)(modelConfig());
    expect(systemOf(session.buildRequest())).toBe("You are JLCode, a helpful coding agent.");
  });

  it("honors the opt-out (environment.projectInstructions=false)", () => {
    write(work, "AGENTS.md", "PROJECT-RULE\n");
    const config = modelConfig({ environment: { projectInstructions: false } });
    expect(projectInstructionsEnabled(config)).toBe(false);
    expect(systemOf(factory(recordingDriver().driver)(config).buildRequest())).not.toContain("PROJECT-RULE");
    // …and the default is on, with no config written at all.
    expect(projectInstructionsEnabled(modelConfig())).toBe(true);
  });

  it("picks up an edit on the *next* session, without a server restart", () => {
    write(work, "AGENTS.md", "FIRST\n");
    const build = factory(recordingDriver().driver);
    expect(systemOf(build(modelConfig()).buildRequest())).toContain("FIRST");
    write(work, "AGENTS.md", "SECOND\n");
    const next = systemOf(build(modelConfig()).buildRequest());
    expect(next).toContain("SECOND");
    expect(next).not.toContain("FIRST");
  });

  it("does not re-read the file per turn — the cached prefix survives, and so does a self-edit (X-15d/g)", async () => {
    write(work, "AGENTS.md", "ORIGINAL RULES\n");
    const { driver, turns } = recordingDriver();
    const session = factory(driver)(modelConfig());

    await session.send("first");
    // The agent rewrites its own instructions mid-session — it can, the file is
    // inside the fence it may write to (X-15g). Read-once is the mitigation.
    write(work, "AGENTS.md", "REWRITTEN BY THE AGENT\n");
    await session.send("second");

    expect(turns.length).toBeGreaterThanOrEqual(2);
    const [one, two] = [turns[0]!, turns[1]!];
    expect(systemOf(one)).toContain("ORIGINAL RULES");
    // The running session never sees the rewrite…
    expect(systemOf(two)).not.toContain("REWRITTEN BY THE AGENT");
    // …because the system message is byte-identical turn to turn. That is the
    // whole cache argument: turn N's prefix stays a prefix of turn N+1's, so the
    // provider's cached block (D-26) is still valid. A file re-read into a
    // re-rendered system message would break this every single turn — D-58, 12.3x.
    expect(systemOf(two)).toBe(systemOf(one));
    expect(JSON.stringify(two.messages.slice(0, one.messages.length))).toBe(JSON.stringify(one.messages));
    // Every ephemeral ask this session makes shares the same prefix too.
    for (const req of turns) expect(systemOf(req)).toBe(systemOf(one));
  });
});

// ---------------------------------------------------------------------------

describe("the config surface (X-15e/f)", () => {
  let dir: string;
  let paths: JlcodePaths;
  let out: string[];
  const savedEnv = { config: process.env.JLCODE_CONFIG_DIR, data: process.env.JLCODE_DATA_DIR };
  let restoreOut: () => void;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-x15-cli-"));
    process.env.JLCODE_CONFIG_DIR = path.join(dir, "config");
    process.env.JLCODE_DATA_DIR = path.join(dir, "data");
    paths = resolvePaths();
    fs.mkdirSync(paths.configDir, { recursive: true });
    fs.mkdirSync(paths.dataDir, { recursive: true });
    fs.writeFileSync(
      paths.modelsCacheFile,
      JSON.stringify({ fetchedAt: new Date().toISOString(), windows: { "anthropic/claude-opus-5": 1_000_000 } }),
    );
    const { config } = addModelConfig(loadConfig(paths), {
      name: "Opus",
      model: "anthropic/claude-opus-5",
      openRouterKey: "sk",
      defaultMode: "code",
      defaultApproval: "manual",
      compaction: { auto: true },
    });
    saveConfig(config, paths);
    out = [];
    const realOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => (out.push(String(s)), true)) as typeof process.stdout.write;
    restoreOut = () => {
      process.stdout.write = realOut;
    };
  });
  afterEach(() => {
    restoreOut();
    process.env.JLCODE_CONFIG_DIR = savedEnv.config;
    process.env.JLCODE_DATA_DIR = savedEnv.data;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const stored = () => loadConfig(paths).modelConfigs[0]!;

  it("turns the read off and back on, round-tripping through disk (the D-68 lesson)", async () => {
    expect(projectInstructionsEnabled(stored())).toBe(true);
    expect(stored().environment).toBeUndefined();
    expect(await runConfig(["set", "Opus", "--project-instructions", "off", "--offline"])).toBe(0);
    // Read back from `config.json`, not from the in-memory patch: a field the
    // loader drops is written, lost, and silently does nothing (D-68).
    expect(stored().environment?.projectInstructions).toBe(false);
    expect(projectInstructionsEnabled(stored())).toBe(false);
    expect(out.join("")).toContain("project instructions: off");
    await runConfig(["set", "Opus", "--project-instructions", "on", "--offline"]);
    expect(projectInstructionsEnabled(stored())).toBe(true);
  });

  it("rejects anything that isn't on/off", async () => {
    await expect(runConfig(["set", "Opus", "--project-instructions", "maybe", "--offline"])).rejects.toThrow(
      /must be "on" or "off"/,
    );
  });

  it("does not disturb the per-turn stamps it shares the environment group with", async () => {
    await runConfig(["set", "Opus", "--turn-timestamps", "off", "--offline"]);
    await runConfig(["set", "Opus", "--project-instructions", "off", "--offline"]);
    expect(stored().environment).toEqual({ turnTimestamps: false, projectInstructions: false });
    await runConfig(["set", "Opus", "--project-instructions", "on", "--offline"]);
    expect(stored().environment).toEqual({ turnTimestamps: false, projectInstructions: true });
    // …and neither disturbs the compaction settings beside them.
    await runConfig(["set", "Opus", "--compaction-threshold", "171500", "--offline"]);
    expect(stored().compaction?.thresholdTokens).toBe(171_500);
    expect(stored().environment?.turnTimestamps).toBe(false);
  });

  it("`config which` states what this workspace will load", async () => {
    await runConfig(["use", "Opus"]);
    out.length = 0;
    expect(await runConfig(["which", "--offline"])).toBe(0);
    expect(out.join("")).toContain("project instructions:");
  });

  it("the summary line every surface prints answers all three cases", () => {
    const work = workspace("jlcode-x15-summary-");
    try {
      expect(summarizeProjectInstructions(false, work)).toContain("off");
      expect(summarizeProjectInstructions(true, work)).toContain("none");
      write(work, "AGENTS.md", "rules\n");
      const on = summarizeProjectInstructions(true, work);
      expect(on).toContain("AGENTS.md");
      expect(on).toContain("6 B");
      // A truncated file must say so on the console, not only in the prompt —
      // the whole point of the cap is that a runaway file is not a silent cost.
      write(work, "AGENTS.md", ("z".repeat(80) + "\n").repeat(1000));
      expect(summarizeProjectInstructions(true, work)).toContain("truncated");
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  it("survives a clone, like every other setting", () => {
    const off = updateModelConfig(loadConfig(paths), "Opus", { projectInstructions: false });
    expect(off.updated.environment?.projectInstructions).toBe(false);
  });
});
