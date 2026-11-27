/**
 * The model manager dialog's pure half (X-62). The form is driven by the
 * server's **real** field list, so these tests use it too.
 */
import { describe, it, expect } from "vitest";
import { MODEL_CONFIG_FIELDS } from "../src/config/fields";
import {
  blankForm,
  catalogFacts,
  changedKeys,
  cloneForm,
  deletePlan,
  keyProblem,
  keySources,
  layout,
  payload,
  searchCatalog,
  toForm,
  uniqueName,
} from "../web/src/model-manager";
import type { CatalogModel, FieldSpec, ManagedConfig } from "../web/src/api";

const FIELDS = MODEL_CONFIG_FIELDS as unknown as FieldSpec[];

function managed(id: string, name: string, keyGroup: number, extra: Partial<ManagedConfig> = {}): ManagedConfig {
  return {
    id,
    values: { name, model: "a/b", defaultMode: "code", defaultApproval: "manual", provider: { only: ["x/y"] }, "commands.watchdogMinutes": 0 },
    fingerprint: `k${keyGroup}00`.slice(-4),
    keyGroup,
    sharedWith: 0,
    folderDefault: false,
    pinned: false,
    updatedAt: "",
    ...extra,
  };
}

describe("form state", () => {
  it("edits numbers and JSON as text, absent as null", () => {
    const f = toForm(FIELDS, managed("1", "A", 0).values);
    expect(f["commands.watchdogMinutes"]).toBe("0");
    expect(f["provider"]).toBe('{\n  "only": [\n    "x/y"\n  ]\n}');
    expect(f["sampling.temperature"]).toBeNull();
  });

  it("starts a new config on the CLI's defaults", () => {
    const f = blankForm(FIELDS);
    expect(f["defaultMode"]).toBe("code");
    expect(f["defaultApproval"]).toBe("manual");
    expect(f["compaction.auto"]).toBe(true);
    expect(f["name"]).toBeNull();
  });

  it("names a clone uniquely", () => {
    expect(uniqueName("A", ["A"])).toBe("A copy");
    expect(uniqueName("A", ["A", "a COPY", "A copy 2"])).toBe("A copy 3");
    const all = [managed("1", "A", 0), managed("2", "A copy", 0)];
    expect(cloneForm(FIELDS, all[0]!, all)["name"]).toBe("A copy 2");
  });

  it("sends only what changed on an edit, everything on a create", () => {
    const start = toForm(FIELDS, managed("1", "A", 0).values);
    const now = { ...start, name: "B", "sampling.temperature": "0.3" };
    expect(changedKeys(start, now).sort()).toEqual(["name", "sampling.temperature"]);
    expect(payload(start, now, false)).toEqual({ name: "B", "sampling.temperature": "0.3" });
    expect(Object.keys(payload(start, now, true)).length).toBe(FIELDS.length);
  });

  it("checks the key part before saving", () => {
    expect(keyProblem({ mode: "keep" }, true)).toMatch(/needs a key/);
    expect(keyProblem({ mode: "keep" }, false)).toBeNull();
    expect(keyProblem({ mode: "new", value: " " }, false)).toMatch(/Enter/);
    expect(keyProblem({ mode: "copy", fromId: "x" }, true)).toBeNull();
  });

  it("lays out core first, then advanced by section in server order", () => {
    const { core, sections } = layout(FIELDS);
    expect(core.map((f) => f.key)).toEqual(["name", "model", "reasoningEffort", "defaultMode", "defaultApproval"]);
    expect(sections.map((s) => s.title)).toEqual(["Prompt", "Sampling", "Routing & pricing", "Compaction", "Commands & agents"]);
  });
});

describe("catalog search", () => {
  const models: CatalogModel[] = [
    { id: "openai/gpt-5", name: "OpenAI: GPT-5", contextLength: 400_000, promptPerMTok: 1.25, completionPerMTok: 10, images: "yes" },
    { id: "openai/gpt-5-mini", name: "OpenAI: GPT-5 Mini", contextLength: 400_000, images: "no" },
    { id: "anthropic/claude-opus-5", name: "Anthropic: Claude Opus 5", contextLength: 1_000_000, images: "unknown" },
  ];

  it("matches every word in id or name, exact id first", () => {
    expect(searchCatalog(models, "claude opus").map((m) => m.id)).toEqual(["anthropic/claude-opus-5"]);
    expect(searchCatalog(models, "mini gpt").map((m) => m.id)).toEqual(["openai/gpt-5-mini"]);
    expect(searchCatalog(models, "openai/gpt-5")[0]!.id).toBe("openai/gpt-5");
    expect(searchCatalog(models, "", 2)).toHaveLength(2);
  });

  it("states the facts briefly", () => {
    expect(catalogFacts(models[0]!)).toBe("400K ctx · $1.25 / $10 per M · images");
    expect(catalogFacts(models[2]!)).toBe("1M ctx");
  });
});

describe("keys and deletes", () => {
  it("offers one copy source per key, skipping a key only this config holds", () => {
    const all = [managed("1", "A1", 0), managed("2", "A2", 0), managed("3", "B", 1)];
    const forA1 = keySources(all, "1");
    expect(forA1.map((s) => s.fromId)).toEqual(["2", "3"]);
    expect(forA1[0]!.label).toContain("A1, A2");
    expect(keySources(all, "3").map((s) => s.fromId)).toEqual(["1"]);
  });

  it("plans a delete like the server will judge it", () => {
    const a = managed("1", "A", 0, { folderDefault: true });
    const b = managed("2", "B", 1, { pinned: true });
    expect(deletePlan(a, [a])).toMatchObject({ kind: "blocked" });
    expect(deletePlan(b, [a, b])).toMatchObject({ kind: "blocked" });
    expect(deletePlan(a, [a, b])).toMatchObject({ kind: "confirm", needsDefault: true, candidates: [b] });
  });
});
