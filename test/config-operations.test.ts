import { describe, it, expect } from "vitest";
import { defaultConfig } from "../src/config/store";
import {
  DEFAULT_WATCHDOG_MINUTES,
  addModelConfig,
  cloneModelConfig,
  commandWatchdogMinutes,
  filterModelConfigs,
  findModelConfig,
  removeModelConfig,
  resolveForCwd,
  setBinding,
  updateModelConfig,
  type NewModelConfig,
} from "../src/config/operations";

function base(name: string, model: string): NewModelConfig {
  return { name, model, openRouterKey: "sk-test", defaultMode: "code", defaultApproval: "manual" };
}

describe("model config operations", () => {
  it("adds a config with a generated id and timestamps", () => {
    const { config, added } = addModelConfig(defaultConfig(), base("Client A — Opus", "anthropic/opus"));
    expect(added.id).toMatch(/^cfg_[0-9a-f]{12}$/);
    expect(added.createdAt).toBeTruthy();
    expect(config.modelConfigs).toHaveLength(1);
  });

  it("clones fields into a new config with a new id and name", () => {
    const { config, added } = addModelConfig(defaultConfig(), base("Client A — Opus", "anthropic/opus"));
    const { added: clone } = cloneModelConfig(config, added.id, "Client A — Fable");
    expect(clone.id).not.toBe(added.id);
    expect(clone.name).toBe("Client A — Fable");
    expect(clone.model).toBe("anthropic/opus");
    expect(clone.openRouterKey).toBe("sk-test");
  });

  it("filters case-insensitively on name and model", () => {
    let c = defaultConfig();
    c = addModelConfig(c, base("Client A — Opus", "anthropic/opus")).config;
    c = addModelConfig(c, base("Client B — Sonnet", "anthropic/sonnet")).config;
    expect(filterModelConfigs(c, "opus").map((x) => x.name)).toEqual(["Client A — Opus"]);
    expect(filterModelConfigs(c, "SONNET")).toHaveLength(1);
    expect(filterModelConfigs(c, "client")).toHaveLength(2);
    expect(filterModelConfigs(c, "")).toHaveLength(2);
  });

  it("finds by id, exact name, and case-insensitive name", () => {
    const { config, added } = addModelConfig(defaultConfig(), base("Client A — Opus", "anthropic/opus"));
    expect(findModelConfig(config, added.id)?.id).toBe(added.id);
    expect(findModelConfig(config, "Client A — Opus")?.id).toBe(added.id);
    expect(findModelConfig(config, "client a — opus")?.id).toBe(added.id);
    expect(findModelConfig(config, "nope")).toBeUndefined();
  });

  it("binds a directory and resolves it back", () => {
    const { config, added } = addModelConfig(defaultConfig(), base("A", "m"));
    const bound = setBinding(config, "/work/clientA", added.id);
    expect(resolveForCwd(bound, "/work/clientA")?.id).toBe(added.id);
    expect(resolveForCwd(bound, "/somewhere/else")).toBeUndefined();
  });

  it("updates fields and merges sampling in place", () => {
    const { config, added } = addModelConfig(defaultConfig(), base("A", "m"));
    const step1 = updateModelConfig(config, added.id, { model: "m2", sampling: { maxTokens: 16 } });
    expect(step1.updated.model).toBe("m2");
    expect(step1.updated.sampling).toEqual({ maxTokens: 16 });
    // A second patch merges rather than replaces sampling.
    const step2 = updateModelConfig(step1.config, added.id, { sampling: { temperature: 0.2 } });
    expect(step2.updated.sampling).toEqual({ maxTokens: 16, temperature: 0.2 });
    expect(step2.updated.id).toBe(added.id); // same config, edited in place
  });

  it("stores the auto-re-title opt-out, and clears it rather than storing the default (X-17)", () => {
    const { config, added } = addModelConfig(defaultConfig(), base("A", "m"));
    expect(added.autoRetitle).toBeUndefined(); // on by default, unwritten

    const off = updateModelConfig(config, added.id, { autoRetitle: false });
    expect(off.updated.autoRetitle).toBe(false);
    // Turning it back on removes the field instead of writing `true` — the
    // default is the absence of the setting.
    const on = updateModelConfig(off.config, added.id, { autoRetitle: true });
    expect(on.updated.autoRetitle).toBeUndefined();
  });

  it("stores the command watchdog interval, and tells 0 apart from unset (X-33)", () => {
    const { config, added } = addModelConfig(defaultConfig(), base("A", "m"));
    expect(commandWatchdogMinutes(added)).toBe(DEFAULT_WATCHDOG_MINUTES); // absent = the default

    const five = updateModelConfig(config, added.id, { watchdogMinutes: 5 });
    expect(five.updated.commands).toEqual({ watchdogMinutes: 5 });
    expect(commandWatchdogMinutes(five.updated)).toBe(5);

    // 0 is a *value* — "no check at all" — not an absence, so it must survive
    // both the store and the reader that would otherwise supply the default.
    const off = updateModelConfig(five.config, added.id, { watchdogMinutes: 0 });
    expect(off.updated.commands).toEqual({ watchdogMinutes: 0 });
    expect(commandWatchdogMinutes(off.updated)).toBe(0);

    // …and `null` is the way back, without hand-editing JSON.
    const cleared = updateModelConfig(off.config, added.id, { watchdogMinutes: null });
    expect(cleared.updated.commands?.watchdogMinutes).toBeUndefined();
    expect(commandWatchdogMinutes(cleared.updated)).toBe(DEFAULT_WATCHDOG_MINUTES);
  });

  it("leaves other settings alone when the watchdog is patched", () => {
    const { config, added } = addModelConfig(defaultConfig(), base("A", "m"));
    const withEnv = updateModelConfig(config, added.id, { turnTimestamps: false, watchdogMinutes: 5 });
    expect(withEnv.updated.environment).toEqual({ turnTimestamps: false });
    expect(withEnv.updated.commands).toEqual({ watchdogMinutes: 5 });
  });

  it("removing a config prunes bindings that pointed at it", () => {
    const { config, added } = addModelConfig(defaultConfig(), base("A", "m"));
    const bound = setBinding(config, "/work/clientA", added.id);
    const after = removeModelConfig(bound, added.id);
    expect(after.modelConfigs).toHaveLength(0);
    expect(resolveForCwd(after, "/work/clientA")).toBeUndefined();
  });
});
