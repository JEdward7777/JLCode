/**
 * Pure operations over a Config: create/clone/find/filter/remove model configs
 * and manage per-directory bindings (D-05, D-06). All return new values; nothing
 * here does IO (the store handles that).
 */
import path from "node:path";
import { newId } from "../util/id.js";
import type { ProviderRouting } from "../llm/types.js";
import type {
  ApprovalPolicy,
  CommandSettings,
  CompactionSettings,
  Config,
  EnvironmentSettings,
  Mode,
  ModelConfig,
  ModelPricing,
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

/** The config's own OpenRouter routing (D-86), or why it is being ignored.
 *  `provider` is hand-edited and passed through on load (D-68), so this is the
 *  one place its shape is judged: only a non-empty plain object is routing. A
 *  string (`"provider": "openai/flex"` — the obvious typo for the object form)
 *  would spread into `{"0":"o",…}`, and `{}` would quietly switch the signature
 *  pin off with nothing in its place; both fall back to the pin instead, and
 *  `config which` names the problem. */
export function configuredRouting(config: { provider?: unknown } | undefined): {
  routing?: ProviderRouting;
  problem?: string;
} {
  const p = config?.provider;
  if (p === undefined || p === null) return {};
  if (typeof p !== "object" || Array.isArray(p)) {
    return { problem: `provider must be an object, e.g. {"only":["openai/flex"]} — got ${JSON.stringify(p)}` };
  }
  if (Object.keys(p).length === 0) return { problem: "provider is an empty object" };
  return { routing: { ...(p as ProviderRouting) } };
}

/** The config's routing as one short phrase for a CLI surface (D-86), judged
 *  by `configuredRouting` so no surface can call a block active that the
 *  session ignores: the block itself, `ignored — <why>`, or `undefined` when
 *  there is none. */
export function describeRouting(config: { provider?: unknown } | undefined): string | undefined {
  const { routing, problem } = configuredRouting(config);
  if (routing) return JSON.stringify(routing);
  return problem ? `ignored — ${problem}` : undefined;
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
 *  and the constructor cannot disagree about the number. A non-positive value
 *  falls back to the default **number**: `0` is the switch-off (P9d, D-89),
 *  which {@link toolRoundsOff} reads — the budget a session holds stays a real
 *  one, so a thread whose root turns the pause back on has a sane count. */
export function toolRoundBudget(config: { commands?: CommandSettings } | undefined): number {
  const n = config?.commands?.toolRounds;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TOOL_ROUNDS;
}

/** The tool-round pause is switched off (`config set --tool-rounds off`,
 *  stored as `commands.toolRounds: 0` — P9d, X-56 Q8, D-89; reverses D-79's
 *  "cannot be disabled", deliberately). The spend cap is then the only brake.
 *  Read from the **root** thread's config for a whole agent tree, live. */
export function toolRoundsOff(config: { commands?: CommandSettings } | undefined): boolean {
  return config?.commands?.toolRounds === 0;
}

/** Levels of sub-agents below the human-started root (X-56 Q12, D-89). */
export const DEFAULT_AGENT_DEPTH = 3;
/** Agents of one tree running at once (X-56 Q21, D-89); the root counts. */
export const DEFAULT_AGENT_CONCURRENCY = 4;

/** How deep a tree governed by this config may nest (D-89). `0` is a value —
 *  "this config never spawns" — so only a missing or malformed number falls back
 *  to the default. Resolved here, like the two above, so the coordinator and
 *  `config which` cannot disagree about the number. */
export function agentDepthLimit(config: { commands?: CommandSettings } | undefined): number {
  const n = config?.commands?.agentDepth;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_AGENT_DEPTH;
}

/** How many of a tree's agents may run at once (D-89); `0` = no cap. */
export function agentConcurrencyLimit(config: { commands?: CommandSettings } | undefined): number {
  const n = config?.commands?.agentConcurrency;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_AGENT_CONCURRENCY;
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
  /** Sub-agent levels below the root (D-89); `0` never spawns, `null` clears
   *  back to the default. */
  agentDepth?: number | null;
  /** Agents of one tree running at once (D-89); `0` = no cap, `null` clears. */
  agentConcurrency?: number | null;
  /** Model turns per message before the pause (D-79); `0` switches the pause
   *  off (P9d, D-89), `null` clears back to the default. */
  toolRounds?: number | null;
  /** Endpoint slugs to pin (D-86a) — `--provider openai/flex`. Merged into any
   *  hand-edited block so its other keys survive; `null` removes the block. */
  providerOnly?: string[] | null;
}

/** The routing block `--provider` writes (D-86a): the slugs as `only`, over
 *  whatever valid block the config already holds. `allow_fallbacks` defaults to
 *  **false** — a named endpoint you are quietly routed away from is not the one
 *  you named — but a hand-edited value wins, as does every key the flag does not
 *  speak for (`sort`, `data_collection`, …), so the flag never undoes a choice
 *  made in `config.json`. */
export function routingWithOnly(existing: { provider?: unknown }, only: string[]): ProviderRouting {
  // `only` is listed first so the block reads back the way a model card writes it.
  const kept: ProviderRouting = { ...(configuredRouting(existing).routing ?? {}) };
  delete kept.only;
  return { only, allow_fallbacks: false, ...kept };
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
  // The two sub-agent brakes (D-89) live in the same group, and clear the same way.
  let commands: CommandSettings | undefined;
  const commandPatch = [
    ["watchdogMinutes", patch.watchdogMinutes],
    ["agentDepth", patch.agentDepth],
    ["agentConcurrency", patch.agentConcurrency],
    ["toolRounds", patch.toolRounds],
  ] as const;
  for (const [field, value] of commandPatch) {
    if (value === undefined) continue;
    commands ??= { ...(target.commands ?? {}) };
    if (value === null) delete commands[field];
    else commands[field] = value;
  }

  const updated: ModelConfig = {
    ...target,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.reasoningEffort !== undefined ? { reasoningEffort: patch.reasoningEffort } : {}),
    ...(patch.systemPromptAddendum !== undefined ? { systemPromptAddendum: patch.systemPromptAddendum } : {}),
    ...(patch.defaultMode !== undefined ? { defaultMode: patch.defaultMode } : {}),
    ...(patch.defaultApproval !== undefined ? { defaultApproval: patch.defaultApproval } : {}),
    // X-17: since D-81 **off** is the default, so `false` clears the field and
    // only an explicit "on" is stored.
    ...(patch.autoRetitle === undefined ? {} : patch.autoRetitle ? { autoRetitle: true } : { autoRetitle: undefined }),
    ...(compaction ? { compaction } : {}),
    ...(environment ? { environment } : {}),
    ...(commands ? { commands } : {}),
    ...(patch.providerOnly === undefined
      ? {}
      : { provider: patch.providerOnly === null ? undefined : routingWithOnly(target, patch.providerOnly) }),
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
  // Prune the MRU list too (X-40). A picker is answered with a *number*, so a
  // dead id left in the list doesn't merely fail — it silently shifts every
  // other entry's number, which is the one way a numbered picker can hand
  // someone the wrong model without ever showing them a wrong name.
  const folderRecents = Object.fromEntries(
    Object.entries(config.folderRecents ?? {})
      .map(([dir, ids]) => [dir, ids.filter((id) => id !== target.id)] as const)
      .filter(([, ids]) => ids.length > 0),
  );
  return { ...withModelConfigs(config, modelConfigs), folderBindings, folderRecents };
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

// ---------------------------------------------------------------------------
// X-40 / D-82 — switching a folder's model without moving its key.
//
// The whole feature rests on one idea: a model configuration is identified by
// the pair **(key, model)**, not by its name. Switching is therefore a *derive*
// operation — take the key from the config this folder already resolves to, and
// find-or-create the sibling that holds the target model. Doing it that way is
// what makes switching back and forth converge on two rows instead of growing a
// new one every time, and it is why nobody has to copy a secret out of
// `config.json` by hand.
// ---------------------------------------------------------------------------

/** How many ids a folder's MRU list keeps. Long enough that the models you
 *  actually alternate between are all in the picker, short enough that the
 *  picker stays a list you read rather than one you scroll. */
export const RECENT_CONFIG_LIMIT = 12;

/** A model slug minus its vendor prefix — `anthropic/claude-sonnet-5` →
 *  `claude-sonnet-5`. The vendor is the inferable half (the same argument the
 *  browser's model chip makes, D-71), so the derived name spends its characters
 *  on the part that identifies the model. */
export function shortModelName(model: string): string {
  const slash = model.lastIndexOf("/");
  return slash < 0 ? model : model.slice(slash + 1);
}

/** The name a derived config gets: the folder's basename plus the model minus
 *  its vendor (`JLCode — claude-sonnet-5`). It is also the tiebreak when two
 *  rows share a key and a model, which is the only reason it has to be
 *  deterministic rather than merely pretty. */
export function deriveConfigName(dir: string, model: string): string {
  const base = path.basename(path.resolve(dir)) || dir;
  return `${base} — ${shortModelName(model)}`;
}

/** The nearest bound ancestor of `dir` — the directory whose binding a model
 *  switch should rewrite (D-82).
 *
 *  Deliberately **not** folded into `resolveForCwd`, which is exact-path and
 *  must stay that way: making *that* walk up would silently give `which`,
 *  `serve` and `chat` a config in folders that today resolve to nothing, which
 *  is a much larger behaviour change than this command asked for. Here the walk
 *  is right, because a project has a model — not whichever subdirectory you
 *  happened to be standing in when you typed the command. */
export function nearestBinding(
  config: Config,
  dir: string,
): { dir: string; config: ModelConfig } | undefined {
  let current = path.resolve(dir);
  for (;;) {
    const id = config.folderBindings[current];
    const bound = id === undefined ? undefined : config.modelConfigs.find((c) => c.id === id);
    if (bound) return { dir: current, config: bound };
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Every config that holds this key *and* this model — the (key, model) identity
 *  D-82 turns on. Usually 0 or 1; more than one is a tie the caller resolves
 *  with a picker rather than by guessing. */
export function configsWithKeyAndModel(config: Config, key: string, model: string): ModelConfig[] {
  return config.modelConfigs.filter((c) => c.openRouterKey === key && c.model === model);
}

/**
 * The fields that describe the **outgoing** model and must never ride along to
 * the new one (D-82). Each can only be silently wrong: a carried `pricing`
 * misreports spend, a carried `contextLength` or `thresholdTokens` can make
 * compaction fire far too early or (the H-06 shape) never at all, a carried
 * `acceptsImages` breaks a turn mid-task or hides a capability, and a carried
 * `provider` (D-86) pins the new model to an endpoint that may not serve it —
 * `openai/flex` means nothing to a Claude model. Everything else
 * — effort, mode, approval, addendum, sampling, watchdog, toolRounds,
 * environment, the cross-model compactor — is a choice *about how you work* and
 * carries over untouched.
 */
export const MODEL_SPECIFIC_FIELDS = [
  "pricing",
  "acceptsImages",
  "provider",
  "compaction.contextLength",
  "compaction.thresholdTokens",
] as const;

/**
 * Derive a sibling of `source` for a different model: same key, same working
 * settings, model-specific fields re-derived rather than inherited.
 *
 * `pricing` is written from the catalog when it is known and dropped when it is
 * not — never carried. Absent is honest (spend accounting falls back to what
 * OpenRouter reports per call, which is the authoritative number anyway); the
 * outgoing model's price would be quietly, precisely wrong.
 */
export function deriveModelConfig(
  source: ModelConfig,
  opts: { model: string; name: string; pricing?: ModelPricing },
): NewModelConfig {
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = source;
  const compaction: CompactionSettings | undefined = rest.compaction
    ? { ...rest.compaction }
    : undefined;
  if (compaction) {
    delete compaction.contextLength;
    delete compaction.thresholdTokens;
  }
  const derived: NewModelConfig = {
    ...rest,
    name: opts.name,
    model: opts.model,
    ...(compaction ? { compaction } : {}),
  };
  delete derived.acceptsImages;
  delete derived.provider;
  if (opts.pricing) derived.pricing = opts.pricing;
  else delete derived.pricing;
  return derived;
}

/** Move a config id to the front of a folder's MRU list (X-40), pruning ids
 *  whose config no longer exists so the picker's numbering can't drift. */
export function noteRecentConfig(config: Config, dir: string, configId: string): Config {
  const live = new Set(config.modelConfigs.map((c) => c.id));
  const previous = (config.folderRecents?.[dir] ?? []).filter((id) => id !== configId && live.has(id));
  const next = [configId, ...previous].slice(0, RECENT_CONFIG_LIMIT);
  return { ...config, folderRecents: { ...(config.folderRecents ?? {}), [dir]: next } };
}

/**
 * The models already set up under this folder's key, **most-recently-used
 * first** — what the bare `config model` picker lists.
 *
 * `current` is excluded on purpose: it is the one model you cannot be asking to
 * switch to, and leaving it out is what makes the back-and-forth round trip
 * always answer `1`. Configs the MRU list has never seen follow it, newest
 * first, so a folder with no history still gets a useful list.
 */
export function modelsUnderKey(
  config: Config,
  opts: { key: string; dir: string; exclude?: string },
): ModelConfig[] {
  const siblings = config.modelConfigs.filter(
    (c) => c.openRouterKey === opts.key && c.id !== opts.exclude,
  );
  const order = new Map((config.folderRecents?.[opts.dir] ?? []).map((id, i) => [id, i]));
  const rank = (c: ModelConfig): number => order.get(c.id) ?? Number.MAX_SAFE_INTEGER;
  return siblings.sort((a, b) => {
    const byRecency = rank(a) - rank(b);
    if (byRecency !== 0) return byRecency;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

/** Bind a folder to a config and record the switch in its MRU list — the two
 *  writes that always happen together, kept together so they cannot drift. */
export function bindAndRemember(config: Config, dir: string, configId: string): Config {
  return noteRecentConfig(setBinding(config, dir, configId), dir, configId);
}

/** Create a config *and* point a folder at it — the one path shared by
 *  `config add --use` and by `config model` in a folder that has no binding yet
 *  (D-82). Both are the same act ("set this project up"), so they are the same
 *  three lines rather than two spellings that can drift apart. */
export function createAndBind(
  config: Config,
  input: NewModelConfig,
  dir: string,
): { config: Config; added: ModelConfig } {
  const { config: withAdded, added } = addModelConfig(config, input);
  return { config: bindAndRemember(withAdded, dir, added.id), added };
}

/**
 * What the browser may know about a key (X-56 Q3, D-87): its last four
 * characters, and nothing else. A key too short to spare four characters
 * without giving most of itself away is shown as masked; no key at all is "".
 */
export function keyFingerprint(key: string): string {
  if (key === "") return "";
  return key.length >= 12 ? key.slice(-4) : "****";
}

/** One key's worth of configs, as the model picker shows it — the key itself
 *  never leaves the server; `fingerprint` is all of it that does. */
export interface ConfigKeyGroup {
  fingerprint: string;
  configs: { id: string; name: string; model: string }[];
}

/**
 * Every model config **grouped by key** (X-56 Q3), for the per-thread picker.
 * Groups are formed on the full key server-side, so two keys that happen to
 * share a last four still land in separate groups. With `currentKey`, that
 * key's group comes first and is marked — "current" is a fact about the
 * thread the picker was opened on, which only the caller knows.
 */
export function groupConfigsByKey(
  configs: ModelConfig[],
  currentKey?: string,
): (ConfigKeyGroup & { current: boolean })[] {
  const byKey = new Map<string, ModelConfig[]>();
  for (const c of configs) {
    const list = byKey.get(c.openRouterKey);
    if (list) list.push(c);
    else byKey.set(c.openRouterKey, [c]);
  }
  const groups = [...byKey.entries()].map(([key, list]) => ({
    fingerprint: keyFingerprint(key),
    current: currentKey !== undefined && key === currentKey,
    configs: list.map((c) => ({ id: c.id, name: c.name, model: c.model })),
  }));
  return groups.sort((a, b) => Number(b.current) - Number(a.current));
}
