/**
 * The model manager (X-62, D-110): the field registry, the pure operations, and
 * the routes — above all, that **no answer ever carries key bytes**.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { COVERAGE, MODEL_CONFIG_FIELDS, NON_FIELDS, applyFields, readFields } from "../src/config/fields";
import { createManaged, deleteManaged, listManaged, setFolderDefault, updateManaged, ManageError } from "../src/config/manage";
import { registerModelManager } from "../src/server/config-routes";
import { defaultConfig } from "../src/config/store";
import { addModelConfig, setBinding } from "../src/config/operations";
import { ModelCatalog, parseNames } from "../src/llm/models";
import type { Config, ModelConfig } from "../src/config/types";

const KEY_A = "sk-or-v1-client-a-0000000000aaaa";
const KEY_B = "sk-or-v1-client-b-0000000000bbbb";
const KEY_NEW = "sk-or-v1-rotated-000000000000cccc";
const CWD = "/work/project";

function base(): { config: Config; a1: ModelConfig; a2: ModelConfig; b: ModelConfig } {
  let config = defaultConfig();
  const mk = (name: string, model: string, key: string, extra: Partial<ModelConfig> = {}) => {
    const r = addModelConfig(config, {
      name,
      model,
      openRouterKey: key,
      defaultMode: "code",
      defaultApproval: "manual",
      ...extra,
    });
    config = r.config;
    return r.added;
  };
  const a1 = mk("A opus", "anthropic/claude-opus-5", KEY_A, {
    compaction: { auto: true, thresholdTokens: 150_000 },
    // A hand-edited field nothing in the form speaks for (D-68) must survive edits.
    ...({ handEdited: "keep me" } as object),
  });
  const a2 = mk("A sonnet", "anthropic/claude-sonnet-5", KEY_A);
  const b = mk("B haiku", "anthropic/claude-haiku-5", KEY_B);
  config = setBinding(config, CWD, a1.id);
  return { config, a1, a2, b };
}

/** Every leaf path of a sample object; free-form objects (`provider`) are one leaf. */
function leaves(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix + k;
    if (v !== null && typeof v === "object" && !Array.isArray(v) && k !== "provider") {
      return leaves(v as Record<string, unknown>, key + ".");
    }
    return [key];
  });
}

describe("the field registry", () => {
  it("lists every ModelConfig field (keep the dialog current)", () => {
    const keys = new Set(MODEL_CONFIG_FIELDS.map((f) => f.key));
    const missing = leaves(COVERAGE as unknown as Record<string, unknown>).filter(
      (k) => !(NON_FIELDS as readonly string[]).includes(k) && !keys.has(k),
    );
    expect(missing).toEqual([]);
  });

  it("has no duplicate keys, and every field explains itself", () => {
    const keys = MODEL_CONFIG_FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const f of MODEL_CONFIG_FIELDS) {
      expect(f.help.length, f.key).toBeGreaterThan(20);
      if (f.type === "enum" || f.type === "multi") expect(f.options?.length, f.key).toBeGreaterThan(0);
    }
  });

  it("reads absent fields as null and nested ones by path", () => {
    const { a1 } = base();
    const v = readFields(a1);
    expect(v["compaction.thresholdTokens"]).toBe(150_000);
    expect(v["sampling.temperature"]).toBeNull();
    expect(v["name"]).toBe("A opus");
  });

  it("applies values: blanks remove, groups emptied are dropped, untouched fields survive", () => {
    const { a1 } = base();
    const r = applyFields(a1, {
      "compaction.thresholdTokens": "",
      "sampling.temperature": "0.4",
      "commands.watchdogMinutes": 0,
      provider: '{"only":["openai/flex"]}',
    });
    if ("errors" in r) throw new Error(JSON.stringify(r.errors));
    expect(r.config.compaction).toEqual({ auto: true });
    expect(r.config.sampling).toEqual({ temperature: 0.4 });
    expect(r.config.commands).toEqual({ watchdogMinutes: 0 });
    expect(r.config.provider).toEqual({ only: ["openai/flex"] });
    expect((r.config as Record<string, unknown>)["handEdited"]).toBe("keep me");
    expect(a1.sampling).toBeUndefined(); // the source config is not mutated
    const cleared = applyFields(r.config, { "sampling.temperature": null });
    if ("errors" in cleared) throw new Error("unexpected");
    expect(cleared.config.sampling).toBeUndefined();
  });

  it("refuses bad values per field", () => {
    const { a1 } = base();
    const r = applyFields(a1, {
      name: " ",
      "commands.watchdogMinutes": 1.5,
      defaultMode: "yolo",
      provider: "[1]",
      "compaction.triggerModes": ["auto", "nope"],
      bogus: 1,
    });
    expect("errors" in r && Object.keys(r.errors).sort()).toEqual(
      ["bogus", "commands.watchdogMinutes", "compaction.triggerModes", "defaultMode", "name", "provider"].sort(),
    );
  });

  it("a compaction group without `auto` means auto off", () => {
    const r = applyFields({ name: "x" }, { "compaction.thresholdTokens": 1000 });
    if ("errors" in r) throw new Error("unexpected");
    expect(r.config.compaction).toEqual({ thresholdTokens: 1000, auto: false });
  });
});

describe("listing", () => {
  it("groups by key without the key, and marks the folder default and the pin", () => {
    const { config, a1, a2, b } = base();
    const list = listManaged(config, CWD, b.id);
    const byId = Object.fromEntries(list.map((m) => [m.id, m]));
    expect(byId[a1.id]!.keyGroup).toBe(byId[a2.id]!.keyGroup);
    expect(byId[a1.id]!.keyGroup).not.toBe(byId[b.id]!.keyGroup);
    expect(byId[a1.id]!.sharedWith).toBe(1);
    expect(byId[b.id]!.sharedWith).toBe(0);
    expect(byId[a1.id]!.fingerprint).toBe("aaaa");
    expect(byId[a1.id]!.folderDefault).toBe(true);
    expect(byId[b.id]!.pinned).toBe(true);
    expect(JSON.stringify(list)).not.toContain("client-a");
  });
});

describe("create, clone, edit", () => {
  const values = (over: Record<string, unknown> = {}) => ({
    name: "New one",
    model: "openai/gpt-5",
    defaultMode: "plan",
    defaultApproval: "auto-safe",
    ...over,
  });

  it("creates with a new key", () => {
    const { config } = base();
    const { config: next, created } = createManaged(config, { values: values(), key: { mode: "new", value: ` ${KEY_NEW} ` } });
    expect(created.openRouterKey).toBe(KEY_NEW);
    expect(created.defaultMode).toBe("plan");
    expect(next.modelConfigs).toHaveLength(4);
  });

  it("clones: copies the key by id, never through the browser", () => {
    const { config, b } = base();
    const { created } = createManaged(config, {
      values: { ...readFields(b), name: "B haiku copy" },
      key: { mode: "copy", fromId: b.id },
    });
    expect(created.openRouterKey).toBe(KEY_B);
    expect(created.model).toBe(b.model);
    expect(created.id).not.toBe(b.id);
  });

  it("refuses a create without a key, a missing required field, or a taken name", () => {
    const { config } = base();
    expect(() => createManaged(config, { values: values(), key: { mode: "keep" } })).toThrow(/needs a key/);
    expect(() => createManaged(config, { values: values(), key: { mode: "new", value: "  " } })).toThrow(/Enter the new key/);
    const missing = (() => {
      try {
        createManaged(config, { values: { name: "x" }, key: { mode: "new", value: KEY_NEW } });
      } catch (e) {
        return (e as ManageError).fieldErrors;
      }
    })();
    expect(Object.keys(missing ?? {}).sort()).toEqual(["defaultApproval", "defaultMode", "model"]);
    expect(() => createManaged(config, { values: values({ name: "a OPUS" }), key: { mode: "new", value: KEY_NEW } })).toThrow(
      ManageError,
    );
  });

  it("edits fields and keeps the key, the id and createdAt", () => {
    const { config, a1 } = base();
    const { updated, rotated } = updateManaged(config, a1.id, { values: { name: "A opus renamed", reasoningEffort: "high" } });
    expect(updated.name).toBe("A opus renamed");
    expect(updated.reasoningEffort).toBe("high");
    expect(updated.openRouterKey).toBe(KEY_A);
    expect(updated.id).toBe(a1.id);
    expect(updated.createdAt).toBe(a1.createdAt);
    expect(rotated).toBe(0);
  });

  it("replaces the key on one config only, unless asked to rotate the others", () => {
    const { config, a1, a2 } = base();
    const solo = updateManaged(config, a1.id, { key: { mode: "new", value: KEY_NEW } });
    expect(solo.config.modelConfigs.find((c) => c.id === a2.id)!.openRouterKey).toBe(KEY_A);
    const all = updateManaged(config, a1.id, { key: { mode: "new", value: KEY_NEW, rotate: true } });
    expect(all.rotated).toBe(1);
    expect(all.config.modelConfigs.find((c) => c.id === a2.id)!.openRouterKey).toBe(KEY_NEW);
    expect(all.config.modelConfigs.find((c) => c.openRouterKey === KEY_B)).toBeDefined();
  });

  it("copies another config's key onto an existing one", () => {
    const { config, a1, b } = base();
    const { updated } = updateManaged(config, a1.id, { key: { mode: "copy", fromId: b.id } });
    expect(updated.openRouterKey).toBe(KEY_B);
  });
});

describe("delete and the folder default", () => {
  it("deletes, pruning its bindings elsewhere", () => {
    const { config, a2 } = base();
    const next = deleteManaged(setBinding(config, "/other", a2.id), a2.id, { cwd: CWD });
    expect(next.modelConfigs.map((c) => c.id)).not.toContain(a2.id);
    expect(next.folderBindings["/other"]).toBeUndefined();
  });

  it("needs a replacement to delete this folder's default, and binds it", () => {
    const { config, a1, b } = base();
    expect(() => deleteManaged(config, a1.id, { cwd: CWD })).toThrow(/choose which config/);
    const next = deleteManaged(config, a1.id, { cwd: CWD, newDefaultId: b.id });
    expect(next.folderBindings[CWD]).toBe(b.id);
    expect(next.folderRecents?.[CWD]?.[0]).toBe(b.id);
  });

  it("refuses the last config and the pinned one", () => {
    const { config, a2, b } = base();
    expect(() => deleteManaged(config, b.id, { cwd: CWD, pinnedId: b.id })).toThrow(/--config/);
    let only = deleteManaged(config, a2.id, { cwd: CWD });
    only = deleteManaged(only, b.id, { cwd: CWD });
    expect(() => deleteManaged(only, only.modelConfigs[0]!.id, { cwd: CWD })).toThrow(/only config/);
  });

  it("sets this folder's default", () => {
    const { config, b } = base();
    expect(setFolderDefault(config, b.id, CWD).folderBindings[CWD]).toBe(b.id);
    expect(() => setFolderDefault(config, "cfg_nope", CWD)).toThrow(ManageError);
  });
});

describe("the routes", () => {
  function app(start = base().config) {
    let store = start;
    const dir = mkdtempSync(path.join(os.tmpdir(), "jlcode-mm-"));
    const file = path.join(dir, "models.json");
    writeFileSync(
      file,
      JSON.stringify({
        fetchedAt: "2099-01-01T00:00:00.000Z",
        windows: { "openai/gpt-5": 400_000 },
        modalities: { "openai/gpt-5": ["text", "image"] },
        prices: { "openai/gpt-5": { promptPerMTok: 1.25, completionPerMTok: 10 } },
        limits: {},
        names: { "openai/gpt-5": "OpenAI: GPT-5" },
      }),
    );
    const h = new Hono();
    registerModelManager(h, {
      load: () => store,
      save: (c) => (store = c),
      cwd: CWD,
      catalog: new ModelCatalog({ file }),
      offline: true,
    });
    const call = async (method: string, url: string, body?: unknown) => {
      const res = await h.request(url, {
        method,
        ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
      });
      const text = await res.text();
      // The one invariant every answer keeps: no key bytes, ever.
      for (const k of [KEY_A, KEY_B, KEY_NEW]) expect(text).not.toContain(k.slice(0, 20));
      return { status: res.status, json: JSON.parse(text) as Record<string, unknown> };
    };
    return { call, store: () => store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("serves the fields, the list, and the catalog", async () => {
    const t = app();
    expect(((await t.call("GET", "/model-config-fields")).json["fields"] as unknown[]).length).toBe(MODEL_CONFIG_FIELDS.length);
    const list = (await t.call("GET", "/model-configs")).json;
    expect((list["configs"] as unknown[]).length).toBe(3);
    expect(list["workingDir"]).toBe(CWD);
    const cat = (await t.call("GET", "/model-catalog")).json;
    expect(cat["models"]).toEqual([
      { id: "openai/gpt-5", name: "OpenAI: GPT-5", contextLength: 400_000, promptPerMTok: 1.25, completionPerMTok: 10, images: "yes" },
    ]);
    t.cleanup();
  });

  it("creates, edits with rotation, sets the default and deletes — through HTTP", async () => {
    const t = app();
    const created = await t.call("POST", "/model-configs", {
      values: { name: "G", model: "openai/gpt-5", defaultMode: "code", defaultApproval: "manual" },
      key: { mode: "new", value: KEY_NEW },
    });
    expect(created.status).toBe(201);
    const id = (created.json["config"] as { id: string }).id;
    expect((created.json["config"] as { fingerprint: string }).fingerprint).toBe("cccc");

    const a1 = t.store().modelConfigs.find((c) => c.name === "A opus")!;
    const edited = await t.call("PUT", `/model-configs/${a1.id}`, { key: { mode: "new", value: KEY_B, rotate: true } });
    expect(edited.json["rotated"]).toBe(1);

    const bad = await t.call("PUT", `/model-configs/${a1.id}`, { values: { "sampling.topP": "x" } });
    expect(bad.status).toBe(400);
    expect(bad.json["fieldErrors"]).toHaveProperty(["sampling.topP"]);

    expect((await t.call("DELETE", `/model-configs/${a1.id}`)).status).toBe(409);
    expect((await t.call("DELETE", `/model-configs/${a1.id}?newDefault=${id}`)).status).toBe(200);
    expect(t.store().folderBindings[CWD]).toBe(id);

    const other = t.store().modelConfigs.find((c) => c.name === "B haiku")!;
    expect((await t.call("POST", `/model-configs/${other.id}/default`)).status).toBe(200);
    expect(t.store().folderBindings[CWD]).toBe(other.id);
    expect((await t.call("PUT", "/model-configs/cfg_gone", { values: {} })).status).toBe(404);
    t.cleanup();
  });
});

describe("catalog names", () => {
  it("parses display names", () => {
    expect(parseNames({ data: [{ id: "a/b", name: "A: B" }, { id: "c/d" }] })).toEqual({ "a/b": "A: B" });
  });
});
