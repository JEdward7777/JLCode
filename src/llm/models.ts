/**
 * The OpenRouter model catalog (D-44c) — how JLCode learns a model's context
 * window.
 *
 * This is load-bearing in a way that isn't obvious: without a window,
 * `Session.compactionBudget()` returns undefined, no `needs-compaction` can
 * ever be emitted, and the entire Phase 6 compaction machine is dead code
 * (H-06). It hid for a month because an un-compacted conversation is *correct*
 * — just steadily more expensive until the provider refuses it.
 *
 * The list is public (no API key), ~400 entries, and changes slowly, so it is
 * fetched once and cached to the data dir behind a TTL. A failure here is never
 * fatal and never silent: a stale cache beats a fresh fetch that didn't happen,
 * a fallback window beats no window at all, and the caller is always told which
 * of the three it got (`WindowSource`) so the UI can say so rather than imply a
 * precision we don't have.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
/** The catalog changes slowly; a day-old answer is a good answer. */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
/** Startup must not hang on a slow network — we have a fallback for that. */
export const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Used when the model is in neither the config nor the catalog. Deliberately
 * *small*: the cost of guessing low is early compaction (a summary call and
 * some lost detail, both visible); the cost of guessing high is never
 * compacting at all, which is the defect this module exists to fix. Always
 * reported as `source: "fallback"` so it can be labelled rather than believed.
 */
export const FALLBACK_CONTEXT_WINDOW = 128_000;

/** Model id → context window in tokens. */
export type ModelWindows = Record<string, number>;

/**
 * Model id → what it accepts as *input* (`["text","image","file"]`), from the
 * same `GET /models` payload the windows come from (D-78c).
 *
 * X-37 assumed this was a fetch JLCode would have to add. It was already there
 * and being thrown away: `parseModels` read `context_length` off each entry and
 * dropped everything else, `architecture.input_modalities` included. So the
 * capability check that makes an image refusal honest costs one more field on a
 * request we already make once a day.
 */
export type ModelModalities = Record<string, string[]>;

interface CatalogFile {
  fetchedAt: string;
  windows: ModelWindows;
  /** Absent in a cache written before P8b — read as "nothing known", which is
   *  what `ImageSupport` reports as `"unknown"` rather than as `"no"`. */
  modalities?: ModelModalities;
}

/** Where a resolved window actually came from — the honesty half of the fix. */
export type WindowSource = "config" | "catalog" | "fallback";

export interface ResolvedWindow {
  window: number;
  source: WindowSource;
}

/** Human wording for a window's provenance — the fallback must read as a guess. */
export function describeWindowSource(source: WindowSource): string {
  switch (source) {
    case "config":
      return "set in this config";
    case "catalog":
      return "from OpenRouter";
    case "fallback":
      return "assumed — model not found; set compaction.contextLength to correct it";
  }
}

/** Pull `id → context_length` out of a `GET /models` payload, skipping any
 *  entry that doesn't carry a usable number rather than failing the whole parse. */
export function parseModels(payload: unknown): ModelWindows {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return {};
  const windows: ModelWindows = {};
  for (const entry of data) {
    const model = entry as { id?: unknown; context_length?: unknown };
    if (typeof model.id !== "string") continue;
    const length = model.context_length;
    if (typeof length !== "number" || !Number.isFinite(length) || length <= 0) continue;
    windows[model.id] = length;
  }
  return windows;
}

/** Pull `id → architecture.input_modalities` out of a `GET /models` payload.
 *  An entry that doesn't declare them is skipped rather than recorded as an
 *  empty list — "we were not told" and "it takes nothing" are different answers,
 *  and only the second may be reported as a `no`. */
export function parseModalities(payload: unknown): ModelModalities {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return {};
  const modalities: ModelModalities = {};
  for (const entry of data) {
    const model = entry as { id?: unknown; architecture?: { input_modalities?: unknown } };
    if (typeof model.id !== "string") continue;
    const inputs = model.architecture?.input_modalities;
    if (!Array.isArray(inputs)) continue;
    const named = inputs.filter((m): m is string => typeof m === "string");
    if (named.length === 0) continue;
    modalities[model.id] = named;
  }
  return modalities;
}

/**
 * Whether a model can be handed an image, as three answers rather than two
 * (P8b). `"unknown"` is the one that earns its keep: a model missing from the
 * catalog, or a catalog cached before P8b, is not evidence that it is text-only,
 * and silently treating it as such is how a capability quietly stops working —
 * the H-06 shape. Callers decide what to do with a `"unknown"`; the config
 * override (`acceptsImages`) is what settles it by hand.
 */
export type ImageSupport = "yes" | "no" | "unknown";

export function imageSupport(modalities: ModelModalities, modelId: string): ImageSupport {
  const inputs = modalities[modelId] ?? modalities[baseModelId(modelId)];
  if (inputs === undefined) return "unknown";
  return inputs.includes("image") ? "yes" : "no";
}

/**
 * Strip an OpenRouter variant suffix (`vendor/name:variant` → `vendor/name`).
 * Base ids never contain a colon, so splitting on the first one is safe.
 */
export function baseModelId(modelId: string): string {
  const colon = modelId.indexOf(":");
  return colon < 0 ? modelId : modelId.slice(0, colon);
}

/**
 * Look a model up, exact id first. The fallback to the base id matters for
 * `:online` — a *routing* modifier that is not itself a listed model, so
 * `anthropic/claude-opus-5:online` misses on an exact match and would otherwise
 * report no window at all. Exact-first is what keeps the variants that *are*
 * listed with their own `context_length` (`:free`, `:batch`, `:thinking`) from
 * being flattened onto their base.
 */
export function lookupWindow(windows: ModelWindows, modelId: string): number | undefined {
  return windows[modelId] ?? windows[baseModelId(modelId)];
}

/**
 * Settle the window for a model. Precedence: an explicit `contextLength` in the
 * config always wins (it is the user's override and the manual escape hatch),
 * then the catalog, then the labelled fallback.
 */
export function resolveWindow(
  modelId: string,
  configLength: number | undefined,
  windows: ModelWindows,
): ResolvedWindow {
  if (configLength !== undefined && configLength > 0) return { window: configLength, source: "config" };
  const known = lookupWindow(windows, modelId);
  if (known !== undefined) return { window: known, source: "catalog" };
  return { window: FALLBACK_CONTEXT_WINDOW, source: "fallback" };
}

export interface ModelCatalogOptions {
  /** Where the cached catalog lives on disk. */
  file: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
}

/**
 * A disk-cached view of `GET /models`. Construct it, `await refresh()` once at
 * startup, then `windowFor()` is a synchronous point lookup for the life of the
 * process.
 */
export class ModelCatalog {
  private windows: ModelWindows = {};
  private modalities: ModelModalities = {};
  private fetchedAt = 0;
  private readonly file: string;
  private readonly doFetch: typeof fetch;
  private readonly baseUrl: string;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;

  constructor(options: ModelCatalogOptions) {
    this.file = options.file;
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.loadCache();
  }

  /** Read whatever the last run left behind. A missing or corrupt file is a
   *  cold start, not an error. */
  private loadCache(): void {
    try {
      const cached = JSON.parse(readFileSync(this.file, "utf8")) as CatalogFile;
      if (cached && typeof cached.fetchedAt === "string" && cached.windows) {
        this.windows = cached.windows;
        this.modalities = cached.modalities ?? {};
        this.fetchedAt = Date.parse(cached.fetchedAt) || 0;
      }
    } catch {
      // cold start
    }
  }

  private writeCache(): void {
    const body: CatalogFile = {
      fetchedAt: new Date(this.now()).toISOString(),
      windows: this.windows,
      modalities: this.modalities,
    };
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(body), "utf8");
    } catch {
      // A cache we can't persist still works for this process; refetching next
      // launch is cheap. Not worth failing a server start over.
    }
  }

  isStale(): boolean {
    return this.now() - this.fetchedAt > this.ttlMs;
  }

  /** True once we have windows from *somewhere* (fresh fetch or prior run). */
  get isEmpty(): boolean {
    return Object.keys(this.windows).length === 0;
  }

  get snapshot(): ModelWindows {
    return this.windows;
  }

  /**
   * Refresh from the API when the cache is stale. Returns the error message on
   * failure instead of throwing — the caller carries on with stale data or the
   * fallback, and reports what happened.
   */
  async refresh(force = false): Promise<{ refreshed: boolean; error?: string }> {
    if (!force && !this.isStale()) return { refreshed: false };
    try {
      const res = await this.doFetch(`${this.baseUrl}/models`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return { refreshed: false, error: `HTTP ${res.status}` };
      const payload = await res.json();
      const windows = parseModels(payload);
      // An empty parse means the shape changed under us; keeping the stale
      // catalog is strictly better than replacing it with nothing.
      if (Object.keys(windows).length === 0) return { refreshed: false, error: "no models in response" };
      this.windows = windows;
      // Modalities ride the same parse. Not gated on being non-empty: windows
      // are what make the catalog usable at all, and an empty modality map just
      // means every model answers `"unknown"` — which is the honest answer, and
      // the one the config override exists for.
      this.modalities = parseModalities(payload);
      this.fetchedAt = this.now();
      this.writeCache();
      return { refreshed: true };
    } catch (err) {
      return { refreshed: false, error: (err as Error).message };
    }
  }

  windowFor(modelId: string): number | undefined {
    return lookupWindow(this.windows, modelId);
  }

  /** What this model accepts as input, when the catalog said (P8b, D-78c). */
  modalitiesFor(modelId: string): string[] | undefined {
    return this.modalities[modelId] ?? this.modalities[baseModelId(modelId)];
  }

  /** Can we hand this model a picture? Three answers — see `ImageSupport`. */
  imageSupport(modelId: string): ImageSupport {
    return imageSupport(this.modalities, modelId);
  }

  /**
   * Make sure *this* model is known, refetching out of turn if it isn't. The
   * TTL alone is not enough: a model released after the cache was written stays
   * unknown for up to a day, which is precisely the case of adding a preset for
   * a brand-new model and silently getting the fallback window. A miss is cheap
   * to check and self-limiting — once the refresh lands the id is either known
   * or genuinely absent from OpenRouter.
   */
  async ensureKnown(modelId: string): Promise<{ refreshed: boolean; error?: string }> {
    const stale = this.isStale();
    // Modalities count as "known" alongside the window (P8b): a catalog cached
    // before P8b has every window it needs and no modalities at all, so without
    // this the model reads as text-only for a whole TTL and images silently
    // don't work — the same shape as the brand-new-model miss above.
    const known = this.windowFor(modelId) !== undefined && this.modalitiesFor(modelId) !== undefined;
    if (!stale && known) return { refreshed: false };
    return this.refresh(true);
  }

  resolve(modelId: string, configLength: number | undefined): ResolvedWindow {
    return resolveWindow(modelId, configLength, this.windows);
  }
}
