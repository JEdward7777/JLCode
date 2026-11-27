/**
 * The model manager's operations (X-62, D-110): list, create/clone, edit,
 * delete, and set this folder's default — all pure over a `Config`, so the
 * server route only loads, calls and saves.
 *
 * **The key never leaves the server.** The list carries a fingerprint (last
 * four) and a `keyGroup` (an opaque index shared by configs holding the same
 * key); a write names its key as one of:
 * - `keep`  — the config's current key (edit only);
 * - `copy`  — the key of another config, by id (what "clone" uses);
 * - `new`   — a key typed in the dialog, optionally `rotate`d onto every other
 *             config that held this config's old key.
 */
import type { Config, ModelConfig } from "./types.js";
import { MODEL_CONFIG_FIELDS, applyFields, readFields, type FieldValue } from "./fields.js";
import { addModelConfig, bindAndRemember, getBinding, keyFingerprint, removeModelConfig } from "./operations.js";

export type KeyChoice =
  | { mode: "keep" }
  | { mode: "copy"; fromId: string }
  | { mode: "new"; value: string; rotate?: boolean };

export interface ManagedConfig {
  id: string;
  values: Record<string, FieldValue>;
  /** Last four of the key, "****" for a short one, "" for none. */
  fingerprint: string;
  /** Configs with the same key share a number. Opaque; stable within one answer. */
  keyGroup: number;
  /** How many *other* configs hold the same key. */
  sharedWith: number;
  folderDefault: boolean;
  /** The server was started with `--config` naming this one. */
  pinned: boolean;
  updatedAt: string;
}

export function listManaged(config: Config, cwd: string, pinnedId?: string): ManagedConfig[] {
  const groups = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const c of config.modelConfigs) {
    if (!groups.has(c.openRouterKey)) groups.set(c.openRouterKey, groups.size);
    counts.set(c.openRouterKey, (counts.get(c.openRouterKey) ?? 0) + 1);
  }
  const def = getBinding(config, cwd);
  return config.modelConfigs.map((c) => ({
    id: c.id,
    values: readFields(c),
    fingerprint: keyFingerprint(c.openRouterKey),
    keyGroup: groups.get(c.openRouterKey)!,
    sharedWith: counts.get(c.openRouterKey)! - 1,
    folderDefault: c.id === def,
    pinned: c.id === pinnedId,
    updatedAt: c.updatedAt,
  }));
}

export class ManageError extends Error {
  constructor(
    message: string,
    readonly fieldErrors?: Record<string, string>,
    readonly status = 400,
  ) {
    super(message);
  }
}

function nameTaken(config: Config, name: string, exceptId?: string): boolean {
  const n = name.trim().toLowerCase();
  return config.modelConfigs.some((c) => c.id !== exceptId && c.name.trim().toLowerCase() === n);
}

function resolveKey(config: Config, key: KeyChoice, current?: ModelConfig): string {
  if (key.mode === "keep") {
    if (!current) throw new ManageError("A new config needs a key: copy one or enter one.");
    return current.openRouterKey;
  }
  if (key.mode === "copy") {
    const src = config.modelConfigs.find((c) => c.id === key.fromId);
    if (!src) throw new ManageError("The config to copy the key from no longer exists.", undefined, 404);
    return src.openRouterKey;
  }
  const v = typeof key.value === "string" ? key.value.trim() : "";
  if (v === "") throw new ManageError("Enter the new key, or keep or copy one.");
  return v;
}

function parseKey(raw: unknown): KeyChoice {
  const k = raw as Partial<Record<string, unknown>> | undefined;
  if (k?.["mode"] === "keep") return { mode: "keep" };
  if (k?.["mode"] === "copy" && typeof k["fromId"] === "string") return { mode: "copy", fromId: k["fromId"] };
  if (k?.["mode"] === "new" && typeof k["value"] === "string") {
    return { mode: "new", value: k["value"], rotate: k["rotate"] === true };
  }
  throw new ManageError("key must be {mode: keep} | {mode: copy, fromId} | {mode: new, value, rotate?}.");
}

function fieldsOrThrow(base: Partial<ModelConfig>, values: unknown): Partial<ModelConfig> {
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    throw new ManageError("values must be an object of field → value.");
  }
  const r = applyFields(base, values as Record<string, unknown>);
  if ("errors" in r) throw new ManageError("Some fields need fixing.", r.errors);
  return r.config;
}

/** Create a config — blank or a clone (the browser sends the source's values
 *  and `key: {mode: "copy", fromId: source}`). */
export function createManaged(
  config: Config,
  body: { values?: unknown; key?: unknown },
): { config: Config; created: ModelConfig } {
  const key = parseKey(body.key);
  const fields = fieldsOrThrow({}, body.values);
  // Every required field must be present on a create (an absent key would
  // otherwise skip validation entirely).
  const missing: Record<string, string> = {};
  for (const f of MODEL_CONFIG_FIELDS) {
    if (f.required && (fields as Record<string, unknown>)[f.key] === undefined) missing[f.key] = `${f.label} is required.`;
  }
  if (Object.keys(missing).length > 0) throw new ManageError("Some fields need fixing.", missing);
  if (nameTaken(config, fields.name!)) throw new ManageError("Some fields need fixing.", { name: "Another config already has this name." });
  const openRouterKey = resolveKey(config, key);
  const { config: next, added } = addModelConfig(config, {
    ...(fields as Omit<ModelConfig, "id" | "createdAt" | "updatedAt" | "openRouterKey">),
    openRouterKey,
  });
  return { config: next, created: added };
}

/** Edit a config's fields and/or key. `rotate` on a new key also re-keys every
 *  other config that held this one's **old** key. */
export function updateManaged(
  config: Config,
  id: string,
  body: { values?: unknown; key?: unknown },
): { config: Config; updated: ModelConfig; rotated: number } {
  const current = config.modelConfigs.find((c) => c.id === id);
  if (!current) throw new ManageError("That config no longer exists.", undefined, 404);
  const key = body.key === undefined ? ({ mode: "keep" } as KeyChoice) : parseKey(body.key);
  const fields = fieldsOrThrow(current, body.values ?? {});
  if (fields.name !== undefined && nameTaken(config, fields.name, id)) {
    throw new ManageError("Some fields need fixing.", { name: "Another config already has this name." });
  }
  const newKey = resolveKey(config, key, current);
  const now = new Date().toISOString();
  const updated: ModelConfig = { ...(fields as ModelConfig), id, openRouterKey: newKey, createdAt: current.createdAt, updatedAt: now };
  const rotate = key.mode === "new" && key.rotate === true && newKey !== current.openRouterKey;
  let rotated = 0;
  const modelConfigs = config.modelConfigs.map((c) => {
    if (c.id === id) return updated;
    if (rotate && c.openRouterKey === current.openRouterKey) {
      rotated++;
      return { ...c, openRouterKey: newKey, updatedAt: now };
    }
    return c;
  });
  return { config: { ...config, modelConfigs }, updated, rotated };
}

/**
 * Delete a config. Refused for the last config (nothing could run) and for the
 * one the server is pinned to. Deleting this folder's default needs a
 * replacement default, so new threads here still have a model.
 *
 * Threads that ran on it: a thread **switched** to it (X-56) refuses its next
 * send and shows the "pick a model" card (D-87); a thread on the folder default
 * follows the new default at its next turn. A turn already running finishes.
 */
export function deleteManaged(
  config: Config,
  id: string,
  opts: { cwd: string; pinnedId?: string; newDefaultId?: string },
): Config {
  const target = config.modelConfigs.find((c) => c.id === id);
  if (!target) throw new ManageError("That config no longer exists.", undefined, 404);
  if (config.modelConfigs.length === 1) throw new ManageError("This is the only config — add another before deleting it.", undefined, 409);
  if (id === opts.pinnedId) {
    throw new ManageError("This server was started with --config naming this config; it can't be deleted while it runs.", undefined, 409);
  }
  let next = removeModelConfig(config, id);
  if (getBinding(config, opts.cwd) === id) {
    const replacement = next.modelConfigs.find((c) => c.id === opts.newDefaultId);
    if (!replacement) {
      throw new ManageError("This is this folder's default — choose which config becomes the default instead.", undefined, 409);
    }
    next = bindAndRemember(next, opts.cwd, replacement.id);
  }
  return next;
}

export function setFolderDefault(config: Config, id: string, cwd: string): Config {
  if (!config.modelConfigs.some((c) => c.id === id)) throw new ManageError("That config no longer exists.", undefined, 404);
  // Same act as `jlcode config use` (X-40): bind and note it in the MRU list.
  return bindAndRemember(config, cwd, id);
}
