/**
 * Pure operations over a Config: create/clone/find/filter/remove model configs
 * and manage per-directory bindings (D-05, D-06). All return new values; nothing
 * here does IO (the store handles that).
 */
import { newId } from "../util/id.js";
import type {
  ApprovalPolicy,
  CommandSettings,
  CompactionSettings,
  Config,
  EnvironmentSettings,
  Mode,
  ModelConfig,
  ReasoningEffort,
  SamplingParams,
} from "./types.js";

/** The default watchdog interval — 30 minutes (D-34). Stated here because both
 *  the Session (which arms the timer) and `run_command` (whose description tells
 *  the model the number) have to agree on it, and a description promising a
 *  check at a different time than the one that fires is worse than none. */
export const DEFAULT_WATCHDOG_MINUTES = 30;

/** Model turns a single user message gets before the loop pauses and asks (D-79).
 *  Not a cost backstop — the spend cap (D-33) is that, and it is measured in the
 *  unit that actually matters. This one catches a loop that has stopped
 *  converging, so it sits where "still working" stops being credible on its own
 *  rather than where a normal piece of work ends: real turns run 10-25 rounds.
 *  The value it replaces was 12, and it **ended the turn** there, silently. */
export const DEFAULT_TOOL_ROUNDS = 50;

/** Are user turns stamped with the time they were sent (X-25e)? Stated once,
 *  here, because the default is the interesting part: **absent means on**, so a
 *  config written before X-25 — and every config nobody ever edits — gets the
 *  fix, and only an explicit `false` opts out. */
export function turnTimestampsEnabled(config: { environment?: EnvironmentSettings } | undefined): boolean {
  return config?.environment?.turnTimestamps !== false;
}

/** Is the workspace's own instruction file read into the system prompt (X-15)?
 *  Same shape and same reason as the stamps above: **absent means on**, so a
 *  repo that ships an `AGENTS.md` is obeyed without anyone editing a config
 *  first — which is the entire point of the feature — and only an explicit
 *  `false` declines. */
export function projectInstructionsEnabled(config: { environment?: EnvironmentSettings } | undefined): boolean {
  return config?.environment?.projectInstructions !== false;
}

/** Minutes before the command watchdog asks the model to kill or keep (X-33),
 *  and `0` when the check is switched off. Absent means the default, for the
 *  same reason the two above default to on: a config nobody has edited — which
 *  is every config written before X-33 — must still get the behaviour. */
export function commandWatchdogMinutes(config: { commands?: CommandSettings } | undefined): number {
  const m = config?.commands?.watchdogMinutes;
  return typeof m === "number" && Number.isFinite(m) && m >= 0 ? m : DEFAULT_WATCHDOG_MINUTES;
}

/** Model turns one user message gets before the loop pauses to ask (D-79).
 *  Resolved here rather than defaulted in `Session` so the browser, the factory
 *  and the constructor cannot disagree about the number. `0` is not a way to
 *  disable the pause — an unbounded loop is the bug this exists to catch — so a
 *  non-positive value falls back to the default. */
export function toolRoundBudget(config: { commands?: CommandSettings } | undefined): number {
  const n = config?.commands?.toolRounds;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TOOL_ROUNDS;
}

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
  /** Stamp each user turn with the time it was sent (X-25e). Default on, so
   *  this is written only to record a deliberate choice either way. */
  turnTimestamps?: boolean;
  /** Read the workspace's `AGENTS.md` into the system prompt (X-15). Default on,
   *  written only to record a deliberate choice either way. */
  projectInstructions?: boolean;
  /** Minutes before the command watchdog asks the model to kill or keep (X-33);
   *  `0` switches the check off, `null` clears the field back to the default. */
  watchdogMinutes?: number | null;
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

  // Environment settings — the per-turn half (X-25) and the static half (X-15) —
  // merged into the one group, so flipping either leaves the other alone.
  const envPatch: EnvironmentSettings = {};
  if (patch.turnTimestamps !== undefined) envPatch.turnTimestamps = patch.turnTimestamps;
  if (patch.projectInstructions !== undefined) envPatch.projectInstructions = patch.projectInstructions;
  const environment: EnvironmentSettings | undefined =
    Object.keys(envPatch).length === 0 ? undefined : { ...(target.environment ?? {}), ...envPatch };

  // The command watchdog (X-33). `null` clears rather than writes, the same way
  // back to the default that `thresholdTokens` has — and `0` is a *value* here,
  // not an absence, since switching the check off is a deliberate choice.
  let commands: CommandSettings | undefined;
  if (patch.watchdogMinutes !== undefined) {
    commands = { ...(target.commands ?? {}) };
    if (patch.watchdogMinutes === null) delete commands.watchdogMinutes;
    else commands.watchdogMinutes = patch.watchdogMinutes;
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
    ...(environment ? { environment } : {}),
    ...(commands ? { commands } : {}),
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
