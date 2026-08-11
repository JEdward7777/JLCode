/**
 * H-06 — the test that would have caught it.
 *
 * The defect: `serve` built every real session without a `contextWindow`, so
 * `compactionBudget()` was undefined, `needs-compaction` could never fire, and
 * all of Phase 6 was dead code in production for a month. Every existing
 * compaction test passed throughout, because each one constructs its own
 * `Session` and injects a window — which is exactly the level that cannot see
 * this bug.
 *
 * So these assertions run against `createSessionFactory`, the same function
 * `runServe` hands to the server. If someone drops the window from it again,
 * this goes red.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createSessionFactory, resolveWindows } from "../src/server/session-factory";
import { ModelCatalog, FALLBACK_CONTEXT_WINDOW } from "../src/llm/models";
import { echoDriver } from "../src/session/fake";
import { resolvePaths } from "../src/paths";
import type { ModelConfig } from "../src/config/types";
import type { JlcodePaths } from "../src/paths";

const payload = {
  data: [
    { id: "anthropic/claude-opus-5", context_length: 1000000 },
    { id: "openai/gpt-4o-mini", context_length: 128000 },
  ],
};

const modelConfig = (over: Partial<ModelConfig> = {}): ModelConfig => ({
  id: "cfg_x",
  name: "Test",
  openRouterKey: "sk",
  model: "anthropic/claude-opus-5",
  defaultMode: "code",
  defaultApproval: "manual",
  createdAt: "",
  updatedAt: "",
  ...over,
});

let dir: string;
let paths: JlcodePaths;
let catalog: ModelCatalog;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-window-"));
  paths = resolvePaths({ JLCODE_CONFIG_DIR: path.join(dir, "config"), JLCODE_DATA_DIR: path.join(dir, "data") });
  fs.mkdirSync(paths.configDir, { recursive: true });
  catalog = new ModelCatalog({
    file: paths.modelsCacheFile,
    fetch: (async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch,
  });
  await catalog.refresh();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const factory = () =>
  createSessionFactory({ paths, cwd: dir, makeDriver: () => echoDriver(), mcpTools: () => [], catalog });

describe("serve's session factory — the compaction budget", () => {
  it("gives every session a budget (the H-06 regression)", () => {
    const session = factory()(modelConfig());
    const budget = session.compactionBudget();
    expect(budget).toBeDefined();
    expect(budget!.window).toBe(1000000);
    expect(budget!.threshold).toBeGreaterThan(0);
  });

  it("still has a budget for a model the catalog has never heard of", () => {
    const session = factory()(modelConfig({ model: "who/knows" }));
    expect(session.compactionBudget()?.window).toBe(FALLBACK_CONTEXT_WINDOW);
    // …and admits it is a guess.
    expect(session.contextWindowSource).toBe("fallback");
  });

  it("resolves the :online variant Joshua actually runs under", () => {
    // `:online` is a routing modifier, not a listed model — an exact-match
    // lookup would report no window for a mainstream Opus preset.
    const session = factory()(modelConfig({ model: "anthropic/claude-opus-5:online" }));
    expect(session.compactionBudget()?.window).toBe(1000000);
    expect(session.contextWindowSource).toBe("catalog");
  });

  it("lets a config contextLength override the catalog", () => {
    const session = factory()(modelConfig({ compaction: { auto: false, contextLength: 171500 } }));
    expect(session.compactionBudget()?.window).toBe(171500);
    expect(session.contextWindowSource).toBe("config");
  });

  it("carries the mode, approval and sandbox wiring through unchanged", () => {
    const session = factory()(modelConfig({ defaultMode: "plan", defaultApproval: "auto-safe" }));
    expect(session.mode).toBe("plan");
    expect(session.approval).toBe("auto-safe");
  });
});

/**
 * X-33's setting goes through the same seam, and would fail the same way: a
 * `commands.watchdogMinutes` that reaches the config file and not the session is
 * H-06 wearing a smaller hat. It is worse here than for the window, because the
 * number is *also* stated in `run_command`'s description — so a half-wired
 * setting doesn't just fail to apply, it tells the model something untrue.
 */
describe("serve's session factory — the command watchdog (X-33)", () => {
  const runCommandDescription = (session: { buildRequest: () => { tools?: unknown[] } }) => {
    const tools = (session.buildRequest().tools ?? []) as {
      function: { name: string; description?: string };
    }[];
    return tools.find((t) => t.function.name === "run_command")!.function.description!;
  };

  it("arms the timer with the configured interval", () => {
    const session = factory()(modelConfig({ commands: { watchdogMinutes: 5 } }));
    expect(session.watchdogMs).toBe(5 * 60_000);
  });

  it("defaults to 30 minutes for a config that has never heard of the setting", () => {
    expect(factory()(modelConfig()).watchdogMs).toBe(30 * 60_000);
  });

  it("switches the check off at 0 rather than falling back to the default", () => {
    expect(factory()(modelConfig({ commands: { watchdogMinutes: 0 } })).watchdogMs).toBe(0);
  });

  it("tells the model the same number it armed", () => {
    // The two halves come off one line in the factory; this is the assertion
    // that keeps them there.
    const session = factory()(modelConfig({ commands: { watchdogMinutes: 5 } }));
    expect(session.watchdogMs).toBe(5 * 60_000);
    expect(runCommandDescription(session)).toContain("5 min");
    expect(runCommandDescription(session)).not.toContain("30 min");
  });

  it("promises no check to the model when there is none", () => {
    const session = factory()(modelConfig({ commands: { watchdogMinutes: 0 } }));
    expect(runCommandDescription(session)).toContain("nothing will check on it");
  });
});

describe("resolveWindows — the compactor-fit input (D-44a)", () => {
  it("resolves a separate compactor's window", () => {
    const resolved = resolveWindows(
      modelConfig({ compaction: { auto: false, model: "openai/gpt-4o-mini" } }),
      catalog,
    );
    expect(resolved.window).toBe(1000000);
    expect(resolved.compactorWindow).toBe(128000);
  });

  it("leaves the compactor window unset when the summarizer is the working model", () => {
    const resolved = resolveWindows(
      modelConfig({ compaction: { auto: false, model: "anthropic/claude-opus-5" } }),
      catalog,
    );
    expect(resolved.compactorWindow).toBeUndefined();
  });
});
