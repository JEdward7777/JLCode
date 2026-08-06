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
