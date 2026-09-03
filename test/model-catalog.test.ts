/**
 * H-06 / D-44c — the model catalog that finally gives a session a context window.
 *
 * The lookup cases here are not hypothetical: `anthropic/claude-opus-5:online`
 * is one of the two presets Joshua actually works under, and `:online` is a
 * routing modifier that OpenRouter does not list as a model — so an exact-match
 * lookup reports "unknown window" for a mainstream Opus preset.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  ModelCatalog,
  parseModels,
  baseModelId,
  lookupWindow,
  resolveWindow,
  parseModalities,
  imageSupport,
  FALLBACK_CONTEXT_WINDOW,
} from "../src/llm/models";

/** A trimmed `GET /models` payload in the real shape — including the
 *  `architecture.input_modalities` P8b reads for the image capability (D-78c),
 *  which was in this payload all along and thrown away. `broken/no-length`
 *  declares modalities but no window and `broken/zero-length` declares neither,
 *  so the two maps are deliberately not the same set of ids. */
const payload = {
  data: [
    {
      id: "anthropic/claude-opus-5",
      context_length: 1000000,
      architecture: { input_modalities: ["text", "image", "file"] },
    },
    {
      id: "anthropic/claude-opus-5:batch",
      context_length: 1000000,
      architecture: { input_modalities: ["text", "image", "file"] },
    },
    {
      id: "openai/gpt-4o-mini",
      context_length: 128000,
      architecture: { input_modalities: ["text", "image"] },
    },
    { id: "broken/no-length", architecture: { input_modalities: ["text"] } },
    { id: "broken/zero-length", context_length: 0 },
  ],
};

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-catalog-"));
  file = path.join(dir, "models.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const okFetch = (body: unknown = payload): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

describe("parseModels", () => {
  it("keeps entries with a usable context_length and skips the rest", () => {
    expect(parseModels(payload)).toEqual({
      "anthropic/claude-opus-5": 1000000,
      "anthropic/claude-opus-5:batch": 1000000,
      "openai/gpt-4o-mini": 128000,
    });
  });

  it("returns nothing for a payload that isn't the expected shape", () => {
    expect(parseModels({})).toEqual({});
    expect(parseModels(null)).toEqual({});
    expect(parseModels({ data: "nope" })).toEqual({});
  });
});

describe("model id variants", () => {
  it("strips a variant suffix down to the base id", () => {
    expect(baseModelId("anthropic/claude-opus-5:online")).toBe("anthropic/claude-opus-5");
    expect(baseModelId("anthropic/claude-opus-5")).toBe("anthropic/claude-opus-5");
  });

  it("finds :online by falling back to the base id — it is not a listed model", () => {
    const windows = parseModels(payload);
    expect(lookupWindow(windows, "anthropic/claude-opus-5:online")).toBe(1000000);
  });

  it("prefers an exact match so a listed variant keeps its own window", () => {
    const windows = { "a/b": 100, "a/b:batch": 200 };
    expect(lookupWindow(windows, "a/b:batch")).toBe(200);
  });

  it("reports unknown for a model in neither form", () => {
    expect(lookupWindow(parseModels(payload), "who/knows")).toBeUndefined();
  });
});

describe("resolveWindow", () => {
  const windows = parseModels(payload);

  it("lets an explicit config contextLength win over the catalog", () => {
    expect(resolveWindow("anthropic/claude-opus-5", 250000, windows)).toEqual({
      window: 250000,
      source: "config",
    });
  });

  it("uses the catalog when the config says nothing", () => {
    expect(resolveWindow("anthropic/claude-opus-5", undefined, windows)).toEqual({
      window: 1000000,
      source: "catalog",
    });
  });

  it("falls back — labelled — when nothing knows the model", () => {
    expect(resolveWindow("who/knows", undefined, windows)).toEqual({
      window: FALLBACK_CONTEXT_WINDOW,
      source: "fallback",
    });
  });

  it("never returns undefined, which is the whole point of H-06", () => {
    for (const id of ["who/knows", "anthropic/claude-opus-5:online", "openai/gpt-4o-mini"]) {
      expect(resolveWindow(id, undefined, windows).window).toBeGreaterThan(0);
    }
  });
});

describe("ModelCatalog", () => {
  it("fetches when cold and answers from the fetched data", async () => {
    const catalog = new ModelCatalog({ file, fetch: okFetch() });
    expect(catalog.isEmpty).toBe(true);
    expect(await catalog.refresh()).toEqual({ refreshed: true });
    expect(catalog.windowFor("anthropic/claude-opus-5")).toBe(1000000);
  });

  it("persists to disk so the next process starts warm without a fetch", async () => {
    await new ModelCatalog({ file, fetch: okFetch() }).refresh();

    const noFetch = (async () => {
      throw new Error("should not fetch — cache is fresh");
    }) as unknown as typeof fetch;
    const second = new ModelCatalog({ file, fetch: noFetch });
    expect(second.isEmpty).toBe(false);
    expect(second.isStale()).toBe(false);
    expect(await second.refresh()).toEqual({ refreshed: false });
    expect(second.windowFor("openai/gpt-4o-mini")).toBe(128000);
  });

  it("refetches once the TTL has passed", async () => {
    let calls = 0;
    const counting = (async () => {
      calls++;
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as unknown as typeof fetch;

    let clock = 1_000_000;
    const opts = { file, fetch: counting, ttlMs: 1000, now: () => clock };
    await new ModelCatalog(opts).refresh();
    expect(calls).toBe(1);

    clock += 5000;
    const stale = new ModelCatalog(opts);
    expect(stale.isStale()).toBe(true);
    await stale.refresh();
    expect(calls).toBe(2);
  });

  it("keeps stale data when a refresh fails — a network error is not fatal", async () => {
    await new ModelCatalog({ file, fetch: okFetch() }).refresh();

    const failing = (async () => {
      throw new Error("ENETUNREACH");
    }) as unknown as typeof fetch;
    const catalog = new ModelCatalog({ file, fetch: failing, ttlMs: -1 });
    const result = await catalog.refresh();
    expect(result.refreshed).toBe(false);
    expect(result.error).toContain("ENETUNREACH");
    // The point: the old answer survives the failure.
    expect(catalog.windowFor("anthropic/claude-opus-5")).toBe(1000000);
  });

  it("reports an HTTP failure without clobbering what it had", async () => {
    const catalog = new ModelCatalog({
      file,
      fetch: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
    });
    expect(await catalog.refresh()).toEqual({ refreshed: false, error: "HTTP 503" });
    expect(catalog.resolve("anything", undefined).source).toBe("fallback");
  });

  it("refuses to replace a good catalog with an empty parse", async () => {
    await new ModelCatalog({ file, fetch: okFetch() }).refresh();
    const catalog = new ModelCatalog({ file, fetch: okFetch({ data: [] }), ttlMs: -1 });
    const result = await catalog.refresh();
    expect(result.error).toBe("no models in response");
    expect(catalog.windowFor("anthropic/claude-opus-5")).toBe(1000000);
  });

  it("refetches out of turn for a model the fresh cache doesn't know", async () => {
    // The "I just added a preset for a model released this week" case: the cache
    // is well inside its TTL, so nothing would refetch on its own.
    let calls = 0;
    const counting = (async () => {
      calls++;
      return new Response(
        JSON.stringify({ data: [...payload.data, { id: "brand/new-model", context_length: 400000 }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await new ModelCatalog({ file, fetch: okFetch() }).refresh();
    const catalog = new ModelCatalog({ file, fetch: counting });
    expect(catalog.isStale()).toBe(false);
    expect(catalog.windowFor("brand/new-model")).toBeUndefined();

    await catalog.ensureKnown("brand/new-model");
    expect(calls).toBe(1);
    expect(catalog.windowFor("brand/new-model")).toBe(400000);
  });

  it("does not refetch when the model is already known and the cache is fresh", async () => {
    await new ModelCatalog({ file, fetch: okFetch() }).refresh();
    const noFetch = (async () => {
      throw new Error("should not fetch");
    }) as unknown as typeof fetch;
    const catalog = new ModelCatalog({ file, fetch: noFetch });
    expect(await catalog.ensureKnown("anthropic/claude-opus-5")).toEqual({ refreshed: false });
  });

  it("refetches a cache that predates modalities, then stops (P8b)", async () => {
    // A catalog cached before P8b has every window it needs and no modalities at
    // all. Left alone it would report the working model as text-only for a whole
    // TTL, and images would silently not work — so a model whose modalities are
    // unknown counts as not-known, exactly like a missing window.
    fs.writeFileSync(
      file,
      JSON.stringify({ fetchedAt: new Date().toISOString(), windows: { "anthropic/claude-opus-5": 1000000 } }),
      "utf8",
    );
    let calls = 0;
    const counting = (async () => {
      calls++;
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as unknown as typeof fetch;
    const catalog = new ModelCatalog({ file, fetch: counting });
    expect(catalog.isStale()).toBe(false);
    expect(catalog.imageSupport("anthropic/claude-opus-5")).toBe("unknown");

    await catalog.ensureKnown("anthropic/claude-opus-5");
    expect(calls).toBe(1);
    expect(catalog.imageSupport("anthropic/claude-opus-5")).toBe("yes");
    // …and it is settled now, so the next ask costs nothing.
    await catalog.ensureKnown("anthropic/claude-opus-5");
    expect(calls).toBe(1);
  });

  it("keeps the modalities it fetched across a restart", async () => {
    await new ModelCatalog({ file, fetch: okFetch() }).refresh();
    const reopened = new ModelCatalog({ file, fetch: okFetch() });
    expect(reopened.imageSupport("anthropic/claude-opus-5")).toBe("yes");
    expect(reopened.modalitiesFor("openai/gpt-4o-mini")).toEqual(["text", "image"]);
  });

  it("survives a corrupt cache file as a cold start", () => {
    fs.writeFileSync(file, "{not json", "utf8");
    const catalog = new ModelCatalog({ file, fetch: okFetch() });
    expect(catalog.isEmpty).toBe(true);
    expect(catalog.isStale()).toBe(true);
  });
});

describe("input modalities — can this model be handed a picture? (P8b, D-78c)", () => {
  it("keeps entries that declare input_modalities and skips the rest", () => {
    expect(parseModalities(payload)).toEqual({
      "anthropic/claude-opus-5": ["text", "image", "file"],
      "anthropic/claude-opus-5:batch": ["text", "image", "file"],
      "openai/gpt-4o-mini": ["text", "image"],
      "broken/no-length": ["text"],
    });
  });

  it("ignores a payload that isn't the shape we expect", () => {
    expect(parseModalities({})).toEqual({});
    expect(parseModalities({ data: [{ id: "x", architecture: { input_modalities: "text" } }] })).toEqual({});
    expect(parseModalities({ data: [{ id: "x", architecture: { input_modalities: [] } }] })).toEqual({});
  });

  it("answers yes, no, and unknown — three answers, not two", () => {
    const modalities = parseModalities(payload);
    expect(imageSupport(modalities, "anthropic/claude-opus-5")).toBe("yes");
    // Declared, and image is not among them: a real no.
    expect(imageSupport(modalities, "broken/no-length")).toBe("no");
    // Never declared. "We weren't told" is not "it can't" — treating it as a no
    // is a caller's decision (the config override is the way back), not a fact
    // this function may invent.
    expect(imageSupport(modalities, "broken/zero-length")).toBe("unknown");
    expect(imageSupport(modalities, "who/dis")).toBe("unknown");
  });

  it("falls back to the base id, so `:online` answers like the model it routes to", () => {
    // The same miss H-06's window lookup had: `:online` is a routing modifier
    // OpenRouter does not list, and it is one of Joshua's two presets.
    const modalities = parseModalities(payload);
    expect(imageSupport(modalities, "anthropic/claude-opus-5:online")).toBe("yes");
    // …while a listed variant keeps its own answer rather than being flattened.
    expect(imageSupport(modalities, "anthropic/claude-opus-5:batch")).toBe("yes");
  });
});
