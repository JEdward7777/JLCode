/**
 * X-40 / D-82 — `jlcode config model`: switch a folder's model, keep its key.
 *
 * The friction, in Joshua's words: *"I have to run at least two different
 * commands and also go into the text file to copy the key over."* Everything
 * asserted here is a property of the fix rather than of its wording:
 *
 *  - **find-or-create by (key, model)** — switching back and forth converges on
 *    two rows instead of growing one per switch, which is what keeps a
 *    convenience command from turning `config.json` into a junk drawer;
 *  - **three outcomes, named distinctly** — "nothing happened" and "a new config
 *    now holds your key" must not read the same;
 *  - **carried vs re-derived** — the four fields that describe the *old* model
 *    can only ever be silently wrong on the new one (D-78c exists because a wrong
 *    modality is invisible until it breaks), so they are re-derived; everything
 *    about *how you work* carries;
 *  - **the walk-up** — a project has a model, not the subdirectory you happened
 *    to be standing in;
 *  - **a refusal that names the flag** — the non-interactive half of "every
 *    ambiguity is a numbered picker". These tests run with no TTY, so they drive
 *    the real picker code and read its refusal, rather than a branch around it.
 *
 * Tier 0: no network, no model. The catalog is a fixture file on disk, so slug
 * resolution, the re-derived price and the two catalog warnings are all exercised
 * against a real `ModelCatalog` rather than a stub.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { runConfig } from "../src/config/commands";
import { runConfigModel } from "../src/config/model-command";
import { loadConfig, saveConfig, defaultConfig } from "../src/config/store";
import { addModelConfig, nearestBinding, setBinding } from "../src/config/operations";
import { resolvePaths, type JlcodePaths } from "../src/paths";
import type { Config, ModelConfig } from "../src/config/types";

/** A catalog fixture in the shape the cache file actually holds — two Anthropic
 *  models that share a `claude` substring (so `config model claude` is genuinely
 *  ambiguous) and one cheap OpenAI model that declares **no reasoning support**
 *  and a low output cap, which is what the two warnings are asserted on. */
const CATALOG = {
  fetchedAt: "2099-01-01T00:00:00.000Z",
  windows: {
    "anthropic/claude-opus-5": 1_000_000,
    "anthropic/claude-sonnet-5": 200_000,
    "openai/gpt-4o-mini": 128_000,
  },
  modalities: {
    "anthropic/claude-opus-5": ["text", "image"],
    "anthropic/claude-sonnet-5": ["text", "image"],
    "openai/gpt-4o-mini": ["text"],
  },
  prices: {
    "anthropic/claude-opus-5": { promptPerMTok: 5, completionPerMTok: 25 },
    "anthropic/claude-sonnet-5": { promptPerMTok: 3, completionPerMTok: 15 },
    "openai/gpt-4o-mini": { promptPerMTok: 0.15, completionPerMTok: 0.6 },
  },
  limits: {
    "anthropic/claude-opus-5": { maxCompletionTokens: 64_000, supportedParameters: ["reasoning", "max_tokens"] },
    "anthropic/claude-sonnet-5": { maxCompletionTokens: 64_000, supportedParameters: ["reasoning", "max_tokens"] },
    "openai/gpt-4o-mini": { maxCompletionTokens: 16_384, supportedParameters: ["max_tokens", "temperature"] },
  },
};

let dir: string;
let paths: JlcodePaths;
let project: string;
let out: string[];
let err: string[];
let restore: () => void;
const saved = { config: process.env.JLCODE_CONFIG_DIR, data: process.env.JLCODE_DATA_DIR };

/** The starting point every case shares: an Opus config with a handful of
 *  deliberately non-default settings, bound to `project`. */
function seed(overrides: Partial<ModelConfig> = {}): ModelConfig {
  let store = defaultConfig();
  const { config: next, added } = addModelConfig(store, {
    name: "JLCode — opus",
    model: "anthropic/claude-opus-5",
    openRouterKey: "sk-client-a",
    reasoningEffort: "high",
    defaultMode: "plan",
    defaultApproval: "auto-safe",
    systemPromptAddendum: "use python3, never python",
    sampling: { maxTokens: 32_000, temperature: 0.3 },
    commands: { watchdogMinutes: 45, toolRounds: 80 },
    environment: { turnTimestamps: false },
    autoRetitle: true,
    // The model-specific four, all set to values that describe *Opus*.
    pricing: { promptPerMTok: 5, completionPerMTok: 25 },
    acceptsImages: true,
    compaction: { auto: true, model: "openai/gpt-4o-mini", contextLength: 1_000_000, thresholdTokens: 900_000 },
    ...overrides,
  });
  store = setBinding(next, project, added.id);
  saveConfig(store, paths);
  return added;
}

const store = (): Config => loadConfig(paths);
const byId = (id: string): ModelConfig | undefined => store().modelConfigs.find((c) => c.id === id);
const bound = (d = project): string | undefined => store().folderBindings[d];
const boundConfig = (d = project): ModelConfig | undefined => {
  const id = bound(d);
  return id === undefined ? undefined : byId(id);
};

/** Run the command the way `jlcode config model` does, with an explicit cwd —
 *  the only thing `runConfig` adds is `process.cwd()`, and a test that chdir'd
 *  the whole process to assert a walk-up would be testing vitest, not this. */
const model = (args: string[], cwd = project): Promise<number> => runConfigModel(args, { paths, cwd });

/** The refusal text a non-interactive run throws (there is no TTY here). */
async function refusal(args: string[], cwd = project): Promise<string> {
  try {
    await model(args, cwd);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a refusal, got success");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-x40-"));
  process.env.JLCODE_CONFIG_DIR = path.join(dir, "config");
  process.env.JLCODE_DATA_DIR = path.join(dir, "data");
  paths = resolvePaths();
  fs.mkdirSync(path.dirname(paths.modelsCacheFile), { recursive: true });
  fs.writeFileSync(paths.modelsCacheFile, JSON.stringify(CATALOG), "utf8");
  project = path.join(dir, "work", "JLCode");
  fs.mkdirSync(path.join(project, "src", "deep"), { recursive: true });

  out = [];
  err = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  restore = () => {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  };
});

afterEach(() => {
  restore();
  process.env.JLCODE_CONFIG_DIR = saved.config;
  process.env.JLCODE_DATA_DIR = saved.data;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("find-or-create is keyed on (key, model)", () => {
  it("returns the same config for one (key, model) — switching back and forth converges", async () => {
    const opus = seed();

    expect(await model(["anthropic/claude-sonnet-5", "--offline"])).toBe(0);
    const sonnetId = bound()!;
    expect(sonnetId).not.toBe(opus.id);
    expect(store().modelConfigs).toHaveLength(2);

    // Back to Opus: the *original* row, not a third one.
    await model(["anthropic/claude-opus-5", "--offline"]);
    expect(bound()).toBe(opus.id);
    expect(store().modelConfigs).toHaveLength(2);

    // …and forward again: the same Sonnet row we made the first time.
    await model(["anthropic/claude-sonnet-5", "--offline"]);
    expect(bound()).toBe(sonnetId);
    expect(store().modelConfigs).toHaveLength(2);
  });

  it("carries the key rather than asking for one — the whole point of the command", async () => {
    seed();
    await model(["anthropic/claude-sonnet-5", "--offline"]);
    expect(boundConfig()!.openRouterKey).toBe("sk-client-a");
    // …and it is never printed, on any path (SPEC §12).
    expect(out.join("") + err.join("")).not.toContain("sk-client-a");
  });

  it("derives the name from the folder and the model, minus the vendor", async () => {
    seed();
    await model(["anthropic/claude-sonnet-5", "--offline"]);
    expect(boundConfig()!.name).toBe("JLCode — claude-sonnet-5");
  });
});

describe("the three outcomes are distinguishable", () => {
  it("names created / switched back / already there as different things", async () => {
    seed();

    await model(["anthropic/claude-sonnet-5", "--offline"]);
    const created = out.join("");
    out = [];

    await model(["anthropic/claude-opus-5", "--offline"]);
    const switched = out.join("");
    out = [];

    await model(["anthropic/claude-opus-5", "--offline"]);
    const unchanged = out.join("");

    expect(created).toMatch(/^Created\b/);
    expect(created).toContain("a new config now holds your key");
    expect(switched).toMatch(/^Switched back to\b/);
    expect(switched).toContain("nothing was created");
    expect(unchanged).toMatch(/^Already on anthropic\/claude-opus-5/);
    expect(unchanged).toContain("nothing changed");
    // The three must not be confusable with each other — that is the requirement.
    expect(new Set([created.split("\n")[0], switched.split("\n")[0], unchanged.split("\n")[0]]).size).toBe(3);
  });

  it("writes nothing when it is already there", async () => {
    const opus = seed();
    const before = fs.readFileSync(paths.configFile, "utf8");
    await model(["anthropic/claude-opus-5", "--offline"]);
    expect(fs.readFileSync(paths.configFile, "utf8")).toBe(before);
    expect(bound()).toBe(opus.id);
  });
});

describe("what carries over and what is re-derived", () => {
  it("carries every setting that describes how you work", async () => {
    seed();
    await model(["anthropic/claude-sonnet-5", "--offline"]);
    const next = boundConfig()!;
    expect(next.reasoningEffort).toBe("high");
    expect(next.defaultMode).toBe("plan");
    expect(next.defaultApproval).toBe("auto-safe");
    expect(next.systemPromptAddendum).toBe("use python3, never python");
    expect(next.sampling).toEqual({ maxTokens: 32_000, temperature: 0.3 });
    expect(next.commands).toEqual({ watchdogMinutes: 45, toolRounds: 80 });
    expect(next.environment).toEqual({ turnTimestamps: false });
    expect(next.autoRetitle).toBe(true);
    // The compaction settings that are *not* about the old model come too.
    expect(next.compaction?.auto).toBe(true);
    expect(next.compaction?.model).toBe("openai/gpt-4o-mini");
  });

  it("re-derives the four fields that describe the outgoing model", async () => {
    seed();
    await model(["anthropic/claude-sonnet-5", "--offline"]);
    const next = boundConfig()!;
    // A carried window override would leave compaction measuring Sonnet against
    // Opus's million tokens — H-06 with a new face.
    expect(next.compaction?.contextLength).toBeUndefined();
    expect(next.compaction?.thresholdTokens).toBeUndefined();
    // A wrong modality is invisible until a turn breaks on it (D-78c).
    expect(next.acceptsImages).toBeUndefined();
    // The price is Sonnet's, from the catalog — never Opus's, carried.
    expect(next.pricing).toEqual({ promptPerMTok: 3, completionPerMTok: 15 });
  });

  it("prints the carried settings and the re-derived window, so nothing is inherited invisibly", async () => {
    seed();
    await model(["anthropic/claude-sonnet-5", "--offline"]);
    const printed = out.join("");
    expect(printed).toMatch(/carried\s+.*effort:high/);
    expect(printed).toContain("approval:auto-safe");
    expect(printed).toContain("watchdog:45min");
    expect(printed).toMatch(/window\s+200,000 tokens/);
    // And what it costs now, against what it cost before.
    expect(printed).toContain("$3.00 in / $15.00 out per Mtok");
    expect(printed).toContain("(was $5.00 in / $25.00 out per Mtok)");
  });

  it("warns about settings the new model invalidates, and clamps neither", async () => {
    seed();
    await model(["openai/gpt-4o-mini", "--offline"]);
    const warnings = err.join("");
    expect(warnings).toContain("no reasoning support for openai/gpt-4o-mini");
    expect(warnings).toContain("output cap of 16,384");
    // Warned about *by name* — and still exactly what the user set.
    const next = boundConfig()!;
    expect(next.reasoningEffort).toBe("high");
    expect(next.sampling?.maxTokens).toBe(32_000);
  });
});

describe("slug resolution", () => {
  it("takes an exact id, and a unique substring", async () => {
    seed();
    await model(["sonnet", "--offline"]);
    expect(boundConfig()!.model).toBe("anthropic/claude-sonnet-5");
  });

  it("accepts a model the catalog has never heard of, with a warning", async () => {
    seed();
    expect(await model(["vendor/brand-new-model", "--offline"])).toBe(0);
    expect(boundConfig()!.model).toBe("vendor/brand-new-model");
    expect(err.join("")).toContain("isn't in the OpenRouter catalog");
  });

  it("offers both readings when an argument is a model *and* a config name", async () => {
    seed({ name: "sonnet" }); // a config literally named after a model substring
    const message = await refusal(["sonnet", "--offline"]);
    expect(message).toContain("is both a model and a config here");
    expect(message).toContain("--model <id>");
  });
});

describe("bindings walk up to the nearest bound ancestor", () => {
  it("rewrites the project's binding, not the subdirectory you happened to be in", async () => {
    const opus = seed();
    const deep = path.join(project, "src", "deep");
    expect(bound(deep)).toBeUndefined();

    await model(["anthropic/claude-sonnet-5", "--offline"], deep);

    // The *project* moved…
    expect(boundConfig(project)!.model).toBe("anthropic/claude-sonnet-5");
    expect(bound(project)).not.toBe(opus.id);
    // …and the subdirectory gained no binding of its own.
    expect(bound(deep)).toBeUndefined();
    expect(Object.keys(store().folderBindings)).toEqual([project]);
  });

  it("leaves resolveForCwd exact — the walk belongs to this command only", () => {
    seed();
    const deep = path.join(project, "src", "deep");
    // `nearestBinding` finds the ancestor…
    expect(nearestBinding(store(), deep)?.dir).toBe(project);
    // …while the exact-path resolution every other command uses still says no.
    expect(store().folderBindings[deep]).toBeUndefined();
  });

  it("sets a folder up inline when nothing above it is bound", async () => {
    const elsewhere = path.join(dir, "unbound");
    fs.mkdirSync(elsewhere, { recursive: true });
    saveConfig(defaultConfig(), paths);

    expect(await model(["anthropic/claude-sonnet-5", "--offline", "--key", "sk-fresh"], elsewhere)).toBe(0);
    const created = boundConfig(elsewhere)!;
    expect(created.model).toBe("anthropic/claude-sonnet-5");
    expect(created.openRouterKey).toBe("sk-fresh");
    expect(created.name).toBe("unbound — claude-sonnet-5");
  });
});

describe("without a terminal, a refusal names the flag that would have answered it", () => {
  it("names --model when a short name matches several", async () => {
    seed();
    const message = await refusal(["claude", "--offline"]);
    expect(message).toContain("2 models match");
    expect(message).toContain("anthropic/claude-opus-5");
    expect(message).toContain("anthropic/claude-sonnet-5");
    expect(message).toContain("--model <id>");
  });

  it("names --config when two configs share this key and model", async () => {
    seed();
    await model(["anthropic/claude-sonnet-5", "--offline"]); // creates one
    // A second row with the same key *and* the same model — the tie D-82 names.
    const twin = addModelConfig(store(), {
      name: "Sonnet, second copy",
      model: "anthropic/claude-sonnet-5",
      openRouterKey: "sk-client-a",
      defaultMode: "code",
      defaultApproval: "manual",
    });
    saveConfig(twin.config, paths);
    await model(["anthropic/claude-opus-5", "--offline"]); // step off Sonnet first

    const message = await refusal(["anthropic/claude-sonnet-5", "--offline"]);
    expect(message).toContain("2 configs already hold this key");
    expect(message).toContain("--config <name|id>");

    // …and the flag it names actually answers it.
    expect(await model(["anthropic/claude-sonnet-5", "--offline", "--config", "Sonnet, second copy"])).toBe(0);
    expect(boundConfig()!.id).toBe(twin.added.id);
  });

  it("names --key when the folder has no config to take one from", async () => {
    const elsewhere = path.join(dir, "keyless");
    fs.mkdirSync(elsewhere, { recursive: true });
    saveConfig(defaultConfig(), paths);
    const message = await refusal(["anthropic/claude-sonnet-5", "--offline"], elsewhere);
    expect(message).toContain("--key <secret>");
  });

  it("names --model for the bare invocation too", async () => {
    seed();
    await model(["anthropic/claude-sonnet-5", "--offline"]);
    await model(["anthropic/claude-opus-5", "--offline"]);
    const message = await refusal(["--offline"]);
    expect(message).toContain("--model <id>");
  });
});

describe("the folder's recently-used list", () => {
  it("orders the picker most-recent-first, and leaves out the model you are on", async () => {
    seed();
    // Visit gpt-4o-mini, then Sonnet, then come back to Opus. MRU is now
    // [opus, sonnet, gpt-4o-mini] — and Opus is where we are standing.
    await model(["openai/gpt-4o-mini", "--offline"]);
    await model(["anthropic/claude-sonnet-5", "--offline"]);
    await model(["anthropic/claude-opus-5", "--offline"]);

    const message = await refusal(["--offline"]);
    const lines = message.split("\n").filter((l) => /^\s+\d+\./.test(l));
    // The most recent one you are *not* on is `1` — which is what makes the
    // back-and-forth round trip always a single keystroke.
    expect(lines[0]).toContain("anthropic/claude-sonnet-5");
    expect(lines[1]).toContain("openai/gpt-4o-mini");
    expect(lines[2]).toContain("other…");
    expect(message).not.toMatch(/^\s+\d+\. anthropic\/claude-opus-5$/m);
  });

  it("survives a config remove — a dead id would renumber every entry under it", async () => {
    seed();
    await model(["openai/gpt-4o-mini", "--offline"]);
    await model(["anthropic/claude-sonnet-5", "--offline"]);
    await model(["anthropic/claude-opus-5", "--offline"]);
    expect(store().folderRecents?.[project]).toHaveLength(3);

    expect(await runConfig(["remove", "JLCode — claude-sonnet-5"])).toBe(0);

    const recents = store().folderRecents?.[project] ?? [];
    expect(recents).toHaveLength(2);
    expect(recents.every((id) => byId(id) !== undefined)).toBe(true);

    // …and the picker renumbers, rather than offering a row that cannot be chosen.
    const message = await refusal(["--offline"]);
    const lines = message.split("\n").filter((l) => /^\s+\d+\./.test(l));
    expect(lines[0]).toContain("openai/gpt-4o-mini");
    expect(lines[1]).toContain("other…");
  });
});

describe("config add --use", () => {
  it("adds and binds in one line, so a script needs one command instead of two", async () => {
    saveConfig(defaultConfig(), paths);
    process.env.JLCODE_ADD_KEY = "sk-scripted";
    try {
      expect(await runConfig(["add", "--name", "Scripted", "--model", "anthropic/claude-sonnet-5", "--use"])).toBe(0);
    } finally {
      delete process.env.JLCODE_ADD_KEY;
    }
    const added = store().modelConfigs.find((c) => c.name === "Scripted")!;
    expect(store().folderBindings[process.cwd()]).toBe(added.id);
    expect(out.join("")).toContain("Bound");
  });
});

describe("the subcommand is wired into `jlcode config`", () => {
  it("answers `config model help` with its own flag list", async () => {
    expect(await runConfig(["model", "help"])).toBe(0);
    const help = out.join("");
    expect(help).toContain("config model");
    expect(help).toContain("--key <secret>");
  });
});
