/**
 * D-86 — a config can name its own OpenRouter routing.
 *
 * `ModelConfig.provider` is hand-edited and passed through on load (D-68), so
 * this file pins the two places it meets a person rather than a request: the
 * shape check that decides whether it is routing at all, and the CLI surfaces
 * that say what it is doing. The request-side behaviour — it replaces the
 * signature pin on every call to the working model — is asserted where those
 * requests are built (`session.test.ts`, `ephemeral-cache-contract.test.ts`,
 * `interruption.test.ts`, `llm-client.test.ts`).
 *
 * Tier-1 (offline — no live spend).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { runConfig } from "../src/config/commands";
import { loadConfig, saveConfig } from "../src/config/store";
import { addModelConfig, configuredRouting, describeRouting } from "../src/config/operations";
import { resolvePaths } from "../src/paths";
import type { JlcodePaths } from "../src/paths";
import type { ModelConfig } from "../src/config/types";

const FLEX = { only: ["openai/flex"], allow_fallbacks: false };

describe("configuredRouting — what counts as routing", () => {
  it("passes a non-empty object through as a copy", () => {
    const config = { provider: FLEX };
    const { routing, problem } = configuredRouting(config);
    expect(routing).toEqual(FLEX);
    expect(routing).not.toBe(FLEX); // a caller mutating the request must not edit the config
    expect(problem).toBeUndefined();
  });

  it("absent is simply absent — not a problem", () => {
    expect(configuredRouting({})).toEqual({});
    expect(configuredRouting(undefined)).toEqual({});
  });

  it.each([
    ["the bare-string typo", "openai/flex"],
    ["an array", ["openai/flex"]],
    ["a number", 3],
    ["an empty object", {}],
  ])("names %s as a problem instead of routing on it", (_label, bad) => {
    const { routing, problem } = configuredRouting({ provider: bad });
    expect(routing).toBeUndefined();
    expect(problem).toBeTruthy();
  });
});

describe("describeRouting — one phrase, one judgement", () => {
  it("shows a valid block, names an ignored one, and is silent for none", () => {
    expect(describeRouting({ provider: FLEX })).toBe(JSON.stringify(FLEX));
    expect(describeRouting({ provider: "openai/flex" })).toMatch(/^ignored — provider must be an object/);
    expect(describeRouting({ provider: {} })).toMatch(/^ignored — /);
    expect(describeRouting({})).toBeUndefined();
  });
});

describe("config CLI surfaces (D-86)", () => {
  let dir: string;
  let paths: JlcodePaths;
  let out: string[];
  let err: string[];
  let restore: () => void;
  const savedEnv = { config: process.env.JLCODE_CONFIG_DIR, data: process.env.JLCODE_DATA_DIR };

  /** One config, bound to this directory, carrying `provider` as given. */
  function seed(provider: unknown): void {
    const { config, added } = addModelConfig(loadConfig(paths), {
      name: "Sol",
      model: "openai/gpt-5.6-sol",
      openRouterKey: "sk",
      defaultMode: "code",
      defaultApproval: "manual",
    });
    const withRouting = config.modelConfigs.map((c) =>
      c.id === added.id ? ({ ...c, provider } as ModelConfig) : c,
    );
    saveConfig({ ...config, modelConfigs: withRouting }, paths);
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-d86-"));
    process.env.JLCODE_CONFIG_DIR = path.join(dir, "config");
    process.env.JLCODE_DATA_DIR = path.join(dir, "data");
    paths = resolvePaths();
    fs.mkdirSync(paths.configDir, { recursive: true });
    fs.mkdirSync(paths.dataDir, { recursive: true });
    fs.writeFileSync(
      paths.modelsCacheFile,
      JSON.stringify({ fetchedAt: new Date().toISOString(), windows: { "openai/gpt-5.6-sol": 400_000 } }),
    );
    out = [];
    err = [];
    const realOut = process.stdout.write.bind(process.stdout);
    const realErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((s: string) => (out.push(String(s)), true)) as typeof process.stdout.write;
    process.stderr.write = ((s: string) => (err.push(String(s)), true)) as typeof process.stderr.write;
    restore = () => {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    };
  });
  afterEach(() => {
    restore();
    process.env.JLCODE_CONFIG_DIR = savedEnv.config;
    process.env.JLCODE_DATA_DIR = savedEnv.data;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function which(): Promise<string> {
    await runConfig(["use", "Sol"]);
    out.length = 0;
    expect(await runConfig(["which", "--offline"])).toBe(0);
    return out.join("");
  }

  it("`config which` states configured routing — it governs every request", async () => {
    seed(FLEX);
    const text = await which();
    expect(text).toContain(`provider routing: ${JSON.stringify(FLEX)}`);
    expect(text).toContain("replaces the automatic pin");
  });

  it("`config which` says a malformed block is being ignored, not that it works", async () => {
    seed("openai/flex");
    const text = await which();
    expect(text).toContain("provider routing: IGNORED");
    expect(text).toContain("the automatic pin applies");
  });

  it("`config which` says nothing when there is no block — the default is noise", async () => {
    seed(undefined);
    expect(await which()).not.toContain("provider routing");
  });

  it("`config set --model` keeps the block in place, and says so", async () => {
    seed(FLEX);
    expect(await runConfig(["set", "Sol", "--model", "anthropic/claude-opus-5", "--offline"])).toBe(0);
    expect(loadConfig(paths).modelConfigs[0]!.provider).toEqual(FLEX);
    const warning = err.join("");
    expect(warning).toContain("provider routing");
    expect(warning).toContain("openai/gpt-5.6-sol");
    expect(warning).toContain("anthropic/claude-opus-5");
  });

  it("`config set --model` does not warn about a block the session ignores", async () => {
    // The warning says the block "still applies"; for a malformed one that is
    // false — the pin applies — and `config which` already says so.
    seed("openai/flex");
    await runConfig(["set", "Sol", "--model", "anthropic/claude-opus-5", "--offline"]);
    expect(err.join("")).not.toContain("provider routing");
  });

  it("`config set` that leaves the model alone does not warn", async () => {
    seed(FLEX);
    await runConfig(["set", "Sol", "--effort", "high", "--offline"]);
    expect(err.join("")).not.toContain("provider routing");
  });
});

describe("config set/add --provider (D-86a)", () => {
  let dir: string;
  let paths: JlcodePaths;
  let out: string[];
  let err: string[];
  let restore: () => void;
  const savedEnv = { config: process.env.JLCODE_CONFIG_DIR, data: process.env.JLCODE_DATA_DIR, key: process.env.JLCODE_ADD_KEY };

  /** One config carrying `provider` as given (absent when undefined). */
  function seed(provider?: unknown): void {
    const { config, added } = addModelConfig(loadConfig(paths), {
      name: "Sol",
      model: "openai/gpt-5.6-sol",
      openRouterKey: "sk",
      defaultMode: "code",
      defaultApproval: "manual",
    });
    const withRouting = config.modelConfigs.map((c) =>
      c.id === added.id && provider !== undefined ? ({ ...c, provider } as ModelConfig) : c,
    );
    saveConfig({ ...config, modelConfigs: withRouting }, paths);
  }
  const stored = () => loadConfig(paths).modelConfigs[0]!;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-d86a-"));
    process.env.JLCODE_CONFIG_DIR = path.join(dir, "config");
    process.env.JLCODE_DATA_DIR = path.join(dir, "data");
    paths = resolvePaths();
    fs.mkdirSync(paths.configDir, { recursive: true });
    fs.mkdirSync(paths.dataDir, { recursive: true });
    fs.writeFileSync(
      paths.modelsCacheFile,
      JSON.stringify({ fetchedAt: new Date().toISOString(), windows: { "openai/gpt-5.6-sol": 400_000 } }),
    );
    out = [];
    err = [];
    const realOut = process.stdout.write.bind(process.stdout);
    const realErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((s: string) => (out.push(String(s)), true)) as typeof process.stdout.write;
    process.stderr.write = ((s: string) => (err.push(String(s)), true)) as typeof process.stderr.write;
    restore = () => {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    };
  });
  afterEach(() => {
    restore();
    process.env.JLCODE_CONFIG_DIR = savedEnv.config;
    process.env.JLCODE_DATA_DIR = savedEnv.data;
    if (savedEnv.key === undefined) delete process.env.JLCODE_ADD_KEY;
    else process.env.JLCODE_ADD_KEY = savedEnv.key;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a slug becomes `only`, with fallbacks off by default — and is read back in full", async () => {
    seed();
    expect(await runConfig(["set", "Sol", "--provider", "openai/flex", "--offline"])).toBe(0);
    expect(stored().provider).toEqual(FLEX);
    expect(out.join("")).toContain(`provider routing: ${JSON.stringify(FLEX)}`);
  });

  it("comma-separates several endpoints", async () => {
    seed();
    await runConfig(["set", "Sol", "--provider", "openai/flex, openai/default", "--offline"]);
    expect(stored().provider).toEqual({ only: ["openai/flex", "openai/default"], allow_fallbacks: false });
  });

  it("keeps hand-edited keys, a hand-set allow_fallbacks included — the flag speaks only for `only`", async () => {
    seed({ only: ["openai/default"], allow_fallbacks: true, data_collection: "deny" });
    await runConfig(["set", "Sol", "--provider", "openai/flex", "--offline"]);
    expect(stored().provider).toEqual({ only: ["openai/flex"], allow_fallbacks: true, data_collection: "deny" });
  });

  it("replaces a malformed hand edit rather than merging into it", async () => {
    seed("openai/flex");
    await runConfig(["set", "Sol", "--provider", "openai/flex", "--offline"]);
    expect(stored().provider).toEqual(FLEX);
  });

  it("`none` removes the block and says the pin applies again", async () => {
    seed(FLEX);
    await runConfig(["set", "Sol", "--provider", "none", "--offline"]);
    expect(stored().provider).toBeUndefined();
    expect(out.join("")).toContain("provider routing: none — the automatic pin applies");
  });

  it.each([
    ["JSON", `{"only":["openai/flex"]}`, /not JSON/],
    ["no value", undefined, /endpoint slugs/],
    ["an empty list", " , ", /endpoint slugs/],
    ["a slug with a space", "openai flex", /endpoint slugs/],
  ])("refuses %s, and writes nothing", async (_label, value, message) => {
    // Seeded with a live block, so "wrote nothing" is distinguishable from
    // "treated it as none" or "saved, then threw".
    seed(FLEX);
    const before = stored();
    const args = ["set", "Sol", "--provider", ...(value === undefined ? [] : [value]), "--offline"];
    await expect(runConfig(args)).rejects.toThrow(message);
    expect(stored()).toEqual(before);
  });

  it("drops duplicate and stray-comma entries", async () => {
    seed();
    await runConfig(["set", "Sol", "--provider", "openai/flex,openai/flex,", "--offline"]);
    expect(stored().provider).toEqual(FLEX);
  });

  it("replaces an empty hand-edited block too", async () => {
    seed({});
    await runConfig(["set", "Sol", "--provider", "openai/flex", "--offline"]);
    expect(stored().provider).toEqual(FLEX);
  });

  it("the stale-routing warning names the flag that fixes it", async () => {
    seed(FLEX);
    await runConfig(["set", "Sol", "--model", "anthropic/claude-opus-5", "--offline"]);
    expect(err.join("")).toContain("change it with --provider, or --provider none");
  });

  it("`config add --provider none` writes no block", async () => {
    process.env.JLCODE_ADD_KEY = "sk";
    await runConfig(["add", "--name", "Sol", "--model", "openai/gpt-5.6-sol", "--provider", "none"]);
    expect("provider" in stored()).toBe(false);
  });

  it("`config add` refuses a bad --provider before asking for the key, and adds nothing", async () => {
    delete process.env.JLCODE_ADD_KEY; // a prompt here would hang the test, not pass it
    await expect(
      runConfig(["add", "--name", "Sol", "--model", "openai/gpt-5.6-sol", "--provider", "{x}"]),
    ).rejects.toThrow(/not JSON/);
    expect(loadConfig(paths).modelConfigs).toHaveLength(0);
  });

  it("setting --model and --provider together is the answer, not a warning", async () => {
    seed(FLEX);
    await runConfig(["set", "Sol", "--model", "anthropic/claude-opus-5", "--provider", "anthropic", "--offline"]);
    expect(stored().provider).toEqual({ only: ["anthropic"], allow_fallbacks: false });
    expect(err.join("")).not.toContain("provider routing");
  });

  it("`config add --provider` writes the same block, and shows it", async () => {
    process.env.JLCODE_ADD_KEY = "sk";
    expect(await runConfig(["add", "--name", "Sol", "--model", "openai/gpt-5.6-sol", "--provider", "openai/flex"])).toBe(0);
    expect(stored().provider).toEqual(FLEX);
    expect(out.join("")).toContain(`provider routing: ${JSON.stringify(FLEX)}`);
  });
});
