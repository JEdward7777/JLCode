/**
 * `run_command` — the three things X-33/X-35a changed (D-75).
 *
 * The field report said the agent could neither time-limit a command nor run one
 * in a subdirectory, and that nothing told it the watchdog existed. Two of those
 * were missing arguments; the third was a *description* that said "there is no
 * timeout" while the watchdog it never mentioned had always been asking the
 * model whether to kill. So the description is under test here as behaviour, not
 * as prose: it is the only channel the mechanism has to the party that uses it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Sandbox } from "../src/tools/sandbox";
import { TaskRegistry } from "../src/tools/task-registry";
import { runCommandTool, type ShellToolOptions } from "../src/tools/shell-tool";
import type { ToolContext } from "../src/tools/types";
import { runConfig } from "../src/config/commands";
import { addModelConfig, commandWatchdogMinutes } from "../src/config/operations";
import { loadConfig, saveConfig } from "../src/config/store";
import { resolvePaths, type JlcodePaths } from "../src/paths";

let root: string;
let tasks: TaskRegistry;
let ctx: ToolContext;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-shell-"));
  tasks = new TaskRegistry();
  ctx = { sandbox: new Sandbox([root]), tasks };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const run = (args: Record<string, unknown>, over: Partial<ToolContext> = {}) =>
  runCommandTool().execute(args, { ...ctx, ...over });

const description = (o: ShellToolOptions = {}) => runCommandTool(o).def.function.description!;

describe("the per-call timeout (X-33)", () => {
  it("kills a command that outlives it and says so", async () => {
    const res = await run({ command: "sleep 5", timeout: 0.3 });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("timed out after 0.3s");
    // Named as the caller's own bound, so the model doesn't read it as the
    // command failing — the distinction the note exists to make.
    expect(res.content).toContain("not a failure of the command");
  });

  it("returns the output collected before the kill", async () => {
    // The partial output is the valuable half of a timeout: a build that hangs
    // after printing three failures has already said what went wrong.
    const res = await run({ command: "echo started; sleep 5", timeout: 0.3 });
    expect(res.content).toContain("started");
  });

  it("records the kill on the task, so the list can say why", async () => {
    // The task is registered synchronously inside `execute`, so it is listed
    // before the promise settles — which is what lets this assert on the id
    // rather than on whatever happens to be in the registry afterwards.
    const done = run({ command: "sleep 5", timeout: 0.3 });
    const [task] = tasks.list();
    expect(task).toBeDefined();
    await done;
    expect(tasks.get(task!.id)?.status).toBe("killed");
    expect(tasks.get(task!.id)?.killReason).toBe("timeout");
  });

  it("still times out with no task registry at all", async () => {
    // The bare-embedding path: nothing to record the kill on, so the tool has to
    // remember it timed out by itself.
    const res = await run({ command: "sleep 5", timeout: 0.3 }, { tasks: undefined });
    expect(res.content).toContain("timed out after 0.3s");
  });

  it("leaves a fast command alone", async () => {
    const res = await run({ command: "echo quick", timeout: 30 });
    expect(res.content).toContain("quick");
    expect(res.content).toContain("[exit 0]");
    expect(res.isError).toBeFalsy();
  });

  it("refuses a timeout that is not a positive number", async () => {
    for (const timeout of [0, -1, "soon"]) {
      const res = await run({ command: "echo hi", timeout });
      expect(res.isError).toBe(true);
      expect(res.content).toContain("positive number of seconds");
    }
  });
});

describe("cwd (X-35a)", () => {
  it("runs in the named subdirectory instead of the workspace root", async () => {
    fs.mkdirSync(path.join(root, "sub"));
    fs.writeFileSync(path.join(root, "sub", "marker.txt"), "x");
    const res = await run({ command: "ls", cwd: "sub" });
    expect(res.content).toContain("marker.txt");
  });

  it("defaults to the workspace root", async () => {
    fs.writeFileSync(path.join(root, "top.txt"), "x");
    const res = await run({ command: "ls" });
    expect(res.content).toContain("top.txt");
  });

  it("names the argument when the directory is missing or not a directory", async () => {
    fs.writeFileSync(path.join(root, "file.txt"), "x");
    const missing = await run({ command: "ls", cwd: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain("cwd:");
    const notDir = await run({ command: "ls", cwd: "file.txt" });
    expect(notDir.isError).toBe(true);
    expect(notDir.content).toContain("not a directory");
  });

  it("refuses a directory outside the fence", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-outside-"));
    try {
      const res = await run({ command: "ls", cwd: outside });
      expect(res.isError).toBe(true);
      expect(res.content).toContain("outside the workspace");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("declares cwd as a path arg, so the session fences it before we get here", () => {
    // The tool-level check above is the backstop; `pathArgs` is what routes an
    // out-of-fence directory to the user as an escape they can allow (D-19).
    expect(runCommandTool().pathArgs).toContain("cwd");
  });
});

describe("what the description tells the model (X-33)", () => {
  it("states the watchdog and the default interval", () => {
    const d = description();
    expect(d).toContain("30 min");
    expect(d).toMatch(/ask \*?you\*?/i);
    // The sentence it replaced. Its absence is the fix: the tool used to
    // document away the one mechanism watching a runaway.
    expect(d).not.toContain("there is no timeout");
  });

  it("states the configured interval when it isn't the default", () => {
    expect(description({ watchdogMinutes: 5 })).toContain("5 min");
    expect(description({ watchdogMinutes: 5 })).not.toContain("30 min");
  });

  it("promises no check at all when the watchdog is switched off", () => {
    const d = description({ watchdogMinutes: 0 });
    expect(d).toContain("nothing will check on it");
    expect(d).not.toContain("30 min");
  });

  it("advertises both new arguments", () => {
    const props = runCommandTool().def.function.parameters as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(props.properties).sort()).toEqual(["command", "cwd", "timeout"]);
    expect(props.required).toEqual(["command"]); // both stay optional
  });
});

/**
 * The setting's own path to disk (X-33). Read back through `loadConfig`, never
 * from the in-memory patch, because D-68's lesson is precisely that a field the
 * loader drops is written, lost, and silently does nothing.
 */
describe("config set --command-watchdog", () => {
  let dir: string;
  let paths: JlcodePaths;
  let out: string[];
  const savedEnv = { config: process.env.JLCODE_CONFIG_DIR, data: process.env.JLCODE_DATA_DIR };
  let restoreOut: () => void;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-x33-cli-"));
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

  it("stores an interval and reads it back", async () => {
    expect(await runConfig(["set", "Opus", "--command-watchdog", "5", "--offline"])).toBe(0);
    expect(stored().commands?.watchdogMinutes).toBe(5);
    expect(out.join("")).toContain("kill or keep after 5 min");
  });

  it("'off' means no check, and survives the round trip as 0", async () => {
    await runConfig(["set", "Opus", "--command-watchdog", "off", "--offline"]);
    expect(stored().commands?.watchdogMinutes).toBe(0);
    expect(commandWatchdogMinutes(stored())).toBe(0);
    expect(out.join("")).toContain("no watchdog");
  });

  it("'default' clears it back to the built-in interval", async () => {
    await runConfig(["set", "Opus", "--command-watchdog", "off", "--offline"]);
    await runConfig(["set", "Opus", "--command-watchdog", "default", "--offline"]);
    expect(stored().commands?.watchdogMinutes).toBeUndefined();
    expect(commandWatchdogMinutes(stored())).toBe(30);
  });

  it("rejects a value that is neither a number nor off/default", async () => {
    await expect(runConfig(["set", "Opus", "--command-watchdog", "soon", "--offline"])).rejects.toThrow(
      /positive number of minutes/,
    );
  });
});
