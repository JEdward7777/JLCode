import { describe, it, expect } from "vitest";
import { defaultConfig } from "../src/config/store";
import {
  addModelConfig,
  cloneModelConfig,
  filterModelConfigs,
  findModelConfig,
  removeModelConfig,
  resolveForCwd,
  setBinding,
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

  it("removing a config prunes bindings that pointed at it", () => {
    const { config, added } = addModelConfig(defaultConfig(), base("A", "m"));
    const bound = setBinding(config, "/work/clientA", added.id);
    const after = removeModelConfig(bound, added.id);
    expect(after.modelConfigs).toHaveLength(0);
    expect(resolveForCwd(after, "/work/clientA")).toBeUndefined();
  });
});
