/**
 * Pure operations over a Config: create/clone/find/filter/remove model configs
 * and manage per-directory bindings (D-05, D-06). All return new values; nothing
 * here does IO (the store handles that).
 */
import { newId } from "../util/id.js";
import type {
  ApprovalPolicy,
  CompactionSettings,
  Config,
  Mode,
  ModelConfig,
  ReasoningEffort,
  SamplingParams,
} from "./types.js";

/** Fields a caller supplies when creating a config (id/timestamps are generated). */
export type NewModelConfig = Omit<ModelConfig, "id" | "createdAt" | "updatedAt">;

function withModelConfigs(config: Config, modelConfigs: ModelConfig[]): Config {
  return { ...config, modelConfigs };
}

/** Find a config by exact id, then by exact name, then case-insensitive name. */
export function findModelConfig(config: Config, ref: string): ModelConfig | undefined {
  const byId = config.modelConfigs.find((c) => c.id === ref);
  if (byId) return byId;
  const byName = config.modelConfigs.find((c) => c.name === ref);
  if (byName) return byName;
  const lower = ref.toLowerCase();
  return config.modelConfigs.find((c) => c.name.toLowerCase() === lower);
}

/** KiloCode-style filter: case-insensitive substring on name or model slug. */
export function filterModelConfigs(config: Config, query: string): ModelConfig[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...config.modelConfigs];
  return config.modelConfigs.filter(
    (c) => c.name.toLowerCase().includes(q) || c.model.toLowerCase().includes(q),
  );
}

export function addModelConfig(
  config: Config,
  input: NewModelConfig,
): { config: Config; added: ModelConfig } {
  const now = new Date().toISOString();
  const added: ModelConfig = { ...input, id: newId("cfg"), createdAt: now, updatedAt: now };
  return { config: withModelConfigs(config, [...config.modelConfigs, added]), added };
}

/** Clone an existing config into a new one with a new name (SPEC §4). */
export function cloneModelConfig(
  config: Config,
  sourceRef: string,
  newName: string,
): { config: Config; added: ModelConfig } {
  const source = findModelConfig(config, sourceRef);
  if (!source) throw new Error(`No model config matching "${sourceRef}"`);
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = source;
  return addModelConfig(config, { ...rest, name: newName });
}

export interface ModelConfigPatch {
  name?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  systemPromptAddendum?: string;
  defaultMode?: Mode;
  defaultApproval?: ApprovalPolicy;
  sampling?: Partial<SamplingParams>;
  /** Override the model's context window (D-44c). Normally unset — the live
   *  OpenRouter catalog supplies it — so this is the escape hatch for a model
   *  the catalog doesn't list or gets wrong. */
  contextLength?: number;
  /** Absolute compaction threshold in tokens (X-27); `null` clears it, putting
   *  the config back on the `window − buffer` derivation. */
  thresholdTokens?: number | null;
  /** Re-title a thread as it drifts (X-17). Only `false` is stored — the
   *  default is on, and writing `true` everywhere would be noise. */
  autoRetitle?: boolean;
}

/** Edit an existing config in place (merging sampling), bumping updatedAt. */
export function updateModelConfig(
  config: Config,
  ref: string,
  patch: ModelConfigPatch,
): { config: Config; updated: ModelConfig } {
  const target = findModelConfig(config, ref);
  if (!target) throw new Error(`No model config matching "${ref}"`);

  const mergedSampling: Record<string, number> = {};
  for (const [k, v] of Object.entries({ ...target.sampling, ...patch.sampling })) {
    if (typeof v === "number") mergedSampling[k] = v;
  }

  // Compaction fields (`contextLength` D-44c, `thresholdTokens` X-27) merge into
  // the one settings object, so setting both in a single command keeps both.
  // `null` clears a field rather than writing it — the way back to the derived
  // threshold without hand-editing JSON.
  let compaction: CompactionSettings | undefined;
  if (patch.contextLength !== undefined || patch.thresholdTokens !== undefined) {
    compaction = { ...(target.compaction ?? { auto: false }) };
    if (patch.contextLength !== undefined) compaction.contextLength = patch.contextLength;
    if (patch.thresholdTokens === null) delete compaction.thresholdTokens;
    else if (patch.thresholdTokens !== undefined) compaction.thresholdTokens = patch.thresholdTokens;
  }

  const updated: ModelConfig = {
    ...target,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.reasoningEffort !== undefined ? { reasoningEffort: patch.reasoningEffort } : {}),
    ...(patch.systemPromptAddendum !== undefined ? { systemPromptAddendum: patch.systemPromptAddendum } : {}),
    ...(patch.defaultMode !== undefined ? { defaultMode: patch.defaultMode } : {}),
    ...(patch.defaultApproval !== undefined ? { defaultApproval: patch.defaultApproval } : {}),
    // X-17: on is the default, so `true` clears the field rather than storing it.
    ...(patch.autoRetitle === undefined ? {} : patch.autoRetitle ? { autoRetitle: undefined } : { autoRetitle: false }),
    ...(compaction ? { compaction } : {}),
    sampling: Object.keys(mergedSampling).length > 0 ? mergedSampling : undefined,
    updatedAt: new Date().toISOString(),
  };

  return {
    config: { ...config, modelConfigs: config.modelConfigs.map((c) => (c.id === target.id ? updated : c)) },
    updated,
  };
}

export function removeModelConfig(config: Config, ref: string): Config {
  const target = findModelConfig(config, ref);
  if (!target) throw new Error(`No model config matching "${ref}"`);
  const modelConfigs = config.modelConfigs.filter((c) => c.id !== target.id);
  const folderBindings = Object.fromEntries(
    Object.entries(config.folderBindings).filter(([, id]) => id !== target.id),
  );
  return { ...withModelConfigs(config, modelConfigs), folderBindings };
}

/** Bind a working directory to a config (D-06). */
export function setBinding(config: Config, dir: string, configId: string): Config {
  return { ...config, folderBindings: { ...config.folderBindings, [dir]: configId } };
}

export function getBinding(config: Config, dir: string): string | undefined {
  return config.folderBindings[dir];
}

/** The config auto-selected for a directory, if its binding still resolves. */
export function resolveForCwd(config: Config, dir: string): ModelConfig | undefined {
  const id = config.folderBindings[dir];
  return id === undefined ? undefined : config.modelConfigs.find((c) => c.id === id);
}
