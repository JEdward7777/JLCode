/**
 * X-27 — a compaction threshold you can actually set.
 *
 * Joshua: *"KiloCode condenses at 171.5k, so we should probably have a preset
 * for condensing at the same size."* Before this, the threshold was only ever
 * *derived* (`window − bufferTokens`, D-44c), so asking for 171,500 meant doing
 * arithmetic against a window by hand. Now `compaction.thresholdTokens` states
 * it outright, and the buffer stays the derivation when it is absent.
 *
 * Four levels are asserted here, deliberately, because the interesting failures
 * live between them (H-06/D-60): the pure budget math, a `Session`, the
 * **`serve` session factory** — the level D-60's month-long bug lived at, where
 * every unit test that builds its own `Session` is blind — and the settled state
 * frame the browser meter draws its mark from (D-61). Plus the `config set`
 * surface, since "a preset" means reachable without hand-editing JSON.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  applyCompactorFit,
  computeBudget,
  describeThresholdSource,
  thresholdFitsWindow,
  DEFAULT_BUFFER_TOKENS,
} from "../src/session/compaction";
import { Session } from "../src/session/session";
import { scriptedDriver, echoDriver } from "../src/session/fake";
import { createSessionFactory } from "../src/server/session-factory";
import { createServer } from "../src/server/server";
import { ConversationStore } from "../src/persist/conversation-store";
import { ModelCatalog, FALLBACK_CONTEXT_WINDOW } from "../src/llm/models";
import { runConfig } from "../src/config/commands";
import { loadConfig, saveConfig } from "../src/config/store";
import { addModelConfig } from "../src/config/operations";
import { resolvePaths } from "../src/paths";
import type { JlcodePaths } from "../src/paths";
import type { ModelConfig, CompactionSettings } from "../src/config/types";
import type { StreamEvent, Usage } from "../src/llm/types";
import type { SessionEvent } from "../src/session/types";

// ---------------------------------------------------------------------------
// The pure math (precedence, refusal, and the guard that still applies after).
// ---------------------------------------------------------------------------

describe("threshold precedence (X-27a)", () => {
  it("an absolute thresholdTokens wins over the buffer derivation", () => {
    const budget = computeBudget(200_000, { bufferTokens: 20_000, thresholdTokens: 171_500 });
    expect(budget.threshold).toBe(171_500);
    expect(budget.source).toBe("absolute");
    // The buffer is still reported — it is what the compactor-fit proxy uses.
    expect(budget.buffer).toBe(20_000);
  });

  it("without one, nothing changes meaning: still window − buffer", () => {
    expect(computeBudget(200_000, { bufferTokens: 20_000 })).toMatchObject({
      threshold: 180_000,
      source: "buffer",
    });
    expect(computeBudget(200_000)).toMatchObject({
      threshold: 200_000 - DEFAULT_BUFFER_TOKENS,
      source: "buffer",
    });
  });

  it("refuses a threshold that is not below the window, and says which (X-27d)", () => {
    // At or above the window it could only be crossed by a request the provider
    // has already rejected — i.e. it would silently never fire.
    for (const bad of [200_000, 240_000, 0, -5]) {
      const budget = computeBudget(200_000, { bufferTokens: 20_000, thresholdTokens: bad });
      expect(budget.threshold).toBe(180_000); // falls back to the derivation
      expect(budget.source).toBe("buffer");
      expect(budget.refusedThreshold).toBe(bad);
    }
    expect(thresholdFitsWindow(199_999, 200_000)).toBe(true);
    expect(thresholdFitsWindow(200_000, 200_000)).toBe(false);
  });

  it("the compactor-fit guard still applies after it (D-44a)", () => {
    const budget = computeBudget(200_000, { bufferTokens: 20_000, thresholdTokens: 171_500 });
    // A 100K summarizer can only read 80K under the same slack — an absolute
    // threshold it cannot read must still tighten, or compaction fails exactly
    // when it is needed.
    const fitted = applyCompactorFit(budget, 100_000, 20_000);
    expect(fitted.threshold).toBe(80_000);
    expect(fitted.source).toBe("compactor-fit");
    // A roomier compactor never loosens the absolute value.
    expect(applyCompactorFit(budget, 1_000_000, 20_000)).toMatchObject({
      threshold: 171_500,
      source: "absolute",
    });
  });

  it("states where the threshold came from", () => {
    expect(describeThresholdSource(computeBudget(200_000, { thresholdTokens: 171_500 }))).toMatch(
      /thresholdTokens/,
    );
    expect(describeThresholdSource(computeBudget(200_000, { bufferTokens: 20_000 }))).toBe(
      "derived: window − 20,000 buffer",
    );
  });
});

// ---------------------------------------------------------------------------
// A Session reads it off the config.
// ---------------------------------------------------------------------------

const baseConfig: ModelConfig = {
  id: "cfg",
  name: "Test",
  openRouterKey: "sk",
  model: "work-model",
  defaultMode: "code",
  defaultApproval: "manual",
  createdAt: "",
  updatedAt: "",
};

function configWith(compaction: Partial<CompactionSettings>): ModelConfig {
  return { ...baseConfig, compaction: { auto: false, ...compaction } };
}

function usageDriver(usage: Usage) {
  return scriptedDriver((): StreamEvent[] => [
    { type: "text", delta: "ok" },
    { type: "finish", reason: "stop" },
    { type: "usage", usage },
  ]);
}

describe("Session honors the configured threshold", () => {
  it("fires at thresholdTokens, not at window − buffer", async () => {
    // Window 1000, buffer 100 → the derivation would be 900. The absolute 400
    // fires on a 500-token prefix that the derivation would have let pass.
    const session = new Session({
      config: configWith({ bufferTokens: 100, thresholdTokens: 400 }),
      driver: usageDriver({ promptTokens: 400, completionTokens: 100 }),
      contextWindow: 1_000,
    });
    const events: SessionEvent[] = [];
    session.onEvent((e) => events.push(e));
    await session.send("hi");
    expect(session.compactionBudget()).toMatchObject({ threshold: 400, source: "absolute" });
    expect(session.needsCompaction).toBe(true);
    expect(events.find((e) => e.type === "needs-compaction")).toMatchObject({
      prefixTokens: 500,
      threshold: 400,
      window: 1_000,
    });
  });

  it("falls back to the derivation when the configured threshold can't fit", async () => {
    const session = new Session({
      config: configWith({ bufferTokens: 100, thresholdTokens: 5_000 }), // ≥ the window
      driver: usageDriver({ promptTokens: 400, completionTokens: 100 }),
      contextWindow: 1_000,
    });
    await session.send("hi");
    expect(session.compactionBudget()).toMatchObject({
      threshold: 900,
      source: "buffer",
      refusedThreshold: 5_000,
    });
    expect(session.needsCompaction).toBe(false); // 500 < 900 — and it can still fire
  });
});

// ---------------------------------------------------------------------------
// The `serve` wiring — the level H-06/D-60 lived at.
// ---------------------------------------------------------------------------

const catalogPayload = {
  data: [
    { id: "anthropic/claude-opus-5", context_length: 1_000_000 },
    { id: "openai/gpt-4o-mini", context_length: 128_000 },
  ],
};

describe("serve's session factory carries the threshold (the H-06 level)", () => {
  let dir: string;
  let paths: JlcodePaths;
  let catalog: ModelCatalog;
  let store: ConversationStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-x27-"));
    paths = resolvePaths({ JLCODE_CONFIG_DIR: path.join(dir, "config"), JLCODE_DATA_DIR: path.join(dir, "data") });
    fs.mkdirSync(paths.configDir, { recursive: true });
    catalog = new ModelCatalog({
      file: paths.modelsCacheFile,
      fetch: (async () => new Response(JSON.stringify(catalogPayload), { status: 200 })) as unknown as typeof fetch,
    });
    await catalog.refresh();
    store = new ConversationStore(path.join(dir, "conversations"));
  });
  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const factory = () =>
    createSessionFactory({ paths, cwd: dir, makeDriver: () => echoDriver(), mcpTools: () => [], catalog });

  const opus = (compaction?: CompactionSettings): ModelConfig => ({
    ...baseConfig,
    id: "cfg_x",
    model: "anthropic/claude-opus-5",
    compaction,
  });

  it("condenses at 171,500 on a 1M-window model, as asked", () => {
    const session = factory()(opus({ auto: true, thresholdTokens: 171_500 }));
    expect(session.compactionBudget()).toMatchObject({
      window: 1_000_000,
      threshold: 171_500,
      source: "absolute",
    });
  });

  it("keeps the derived threshold for a config that never set one", () => {
    const session = factory()(opus({ auto: true }));
    expect(session.compactionBudget()).toMatchObject({
      threshold: 1_000_000 - DEFAULT_BUFFER_TOKENS,
      source: "buffer",
    });
  });

  it("refuses a threshold above the resolved window rather than never firing", () => {
    // 171,500 against the 128K fallback window of an unlisted model: the config
    // is stale/wrong, and a session must still compact somewhere reachable.
    const session = factory()(opus({ auto: true, thresholdTokens: 171_500 }));
    const unlisted = factory()({ ...opus({ auto: true, thresholdTokens: 171_500 }), model: "who/knows" });
    expect(session.compactionBudget()?.threshold).toBe(171_500);
    expect(unlisted.compactionBudget()).toMatchObject({
      window: FALLBACK_CONTEXT_WINDOW,
      threshold: FALLBACK_CONTEXT_WINDOW - DEFAULT_BUFFER_TOKENS,
      refusedThreshold: 171_500,
    });
  });

  it("pairs with a contextLength override — the pre-D-60 way of stating a window", () => {
    const session = factory()(opus({ auto: true, contextLength: 200_000, thresholdTokens: 171_500 }));
    expect(session.compactionBudget()).toMatchObject({ window: 200_000, threshold: 171_500 });
  });

  it("reaches the state frame the browser meter marks (D-61)", async () => {
    const config = opus({ auto: false, thresholdTokens: 171_500 });
    const app = createServer({
      resolveConfig: () => config,
      newSession: factory(),
      store,
      workingDir: dir,
      version: "0.0.0",
    }).app;
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    const state = (await res.json()) as { contextWindow: number; contextThreshold: number };
    expect(state.contextWindow).toBe(1_000_000);
    // The mark on X-24's bar is exactly the value we just made settable.
    expect(state.contextThreshold).toBe(171_500);
  });
});

// ---------------------------------------------------------------------------
// `config set` — "preset" means reachable without hand-editing JSON (X-27b).
// ---------------------------------------------------------------------------

describe("config set --compaction-threshold (X-27b)", () => {
  let dir: string;
  let paths: JlcodePaths;
  let out: string[];
  let err: string[];
  const savedEnv = { config: process.env.JLCODE_CONFIG_DIR, data: process.env.JLCODE_DATA_DIR };
  let restoreOut: () => void;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-x27-cli-"));
    process.env.JLCODE_CONFIG_DIR = path.join(dir, "config");
    process.env.JLCODE_DATA_DIR = path.join(dir, "data");
    paths = resolvePaths();
    fs.mkdirSync(paths.configDir, { recursive: true });
    fs.mkdirSync(paths.dataDir, { recursive: true });
    // A fresh catalog cache, so `--offline` runs never reach the network.
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
    err = [];
    const realOut = process.stdout.write.bind(process.stdout);
    const realErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((s: string) => (out.push(String(s)), true)) as typeof process.stdout.write;
    process.stderr.write = ((s: string) => (err.push(String(s)), true)) as typeof process.stderr.write;
    restoreOut = () => {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    };
  });
  afterEach(() => {
    restoreOut();
    process.env.JLCODE_CONFIG_DIR = savedEnv.config;
    process.env.JLCODE_DATA_DIR = savedEnv.data;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const stored = () => loadConfig(paths).modelConfigs[0]!;

  it("sets the absolute threshold and reads it back", async () => {
    expect(await runConfig(["set", "Opus", "--compaction-threshold", "171500", "--offline"])).toBe(0);
    expect(stored().compaction?.thresholdTokens).toBe(171_500);
    expect(out.join("")).toContain("compacts above 171,500 tokens");
  });

  it("refuses a threshold at or above the known window (X-27d)", async () => {
    await expect(
      runConfig(["set", "Opus", "--compaction-threshold", "2000000", "--offline"]),
    ).rejects.toThrow(/never fire/);
    expect(stored().compaction?.thresholdTokens).toBeUndefined(); // nothing written
  });

  it('"none" clears it back to the derived threshold', async () => {
    await runConfig(["set", "Opus", "--compaction-threshold", "171500", "--offline"]);
    await runConfig(["set", "Opus", "--compaction-threshold", "none", "--offline"]);
    expect(stored().compaction?.thresholdTokens).toBeUndefined();
    expect(stored().compaction?.auto).toBe(true); // the rest of the settings survive
    expect(out.join("")).toContain("compacts above 980,000 tokens"); // 1M − 20K
  });

  it("keeps both when the window override and the threshold are set together", async () => {
    await runConfig([
      "set",
      "Opus",
      "--context-length",
      "200000",
      "--compaction-threshold",
      "171500",
      "--offline",
    ]);
    expect(stored().compaction).toMatchObject({ contextLength: 200_000, thresholdTokens: 171_500 });
  });

  it("accepts a threshold against an assumed window, but says it is a guess", async () => {
    await runConfig(["set", "Opus", "--model", "who/knows", "--compaction-threshold", "171500", "--offline"]);
    expect(stored().compaction?.thresholdTokens).toBe(171_500);
    expect(err.join("")).toMatch(/assumed/);
  });

  it("rejects a non-numeric threshold", async () => {
    await expect(runConfig(["set", "Opus", "--compaction-threshold", "lots"])).rejects.toThrow(
      /positive integer/,
    );
  });

  it("config which states where compaction fires", async () => {
    await runConfig(["use", "Opus"]);
    await runConfig(["set", "Opus", "--compaction-threshold", "171500", "--offline"]);
    out.length = 0;
    expect(await runConfig(["which", "--offline"])).toBe(0);
    const text = out.join("");
    expect(text).toContain("context window 1,000,000 tokens");
    expect(text).toContain("compacts above 171,500 tokens — set in this config");
  });
});
