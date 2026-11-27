/**
 * Every editable field of a model config, described once (X-62, D-110).
 *
 * The browser's model manager renders its form **from this list** (served by
 * `GET /model-config-fields`) and the server validates writes against it, so the
 * dialog and the store cannot disagree about what a field is. Each entry carries
 * the label and the help text the dialog's ⓘ button shows.
 *
 * **KEEP THIS CURRENT.** A new `ModelConfig` field (or a new `jlcode config set`
 * flag) must get an entry here, or the dialog silently can't edit it. The
 * `COVERAGE` object below is typed as a deep-required copy of `ModelConfig`, so
 * adding a field to the type without listing it here **fails the build**, and
 * `test/model-config-fields.test.ts` checks every leaf of it has an entry.
 *
 * The key (`openRouterKey`) is deliberately not a field: it never leaves the
 * server, and the dialog handles it as keep / copy-from / new (see manage.ts).
 */
import type { ModelConfig, CompactionTrigger } from "./types.js";
import { APPROVAL_POLICIES, MODES, REASONING_EFFORTS } from "./types.js";

export type FieldType =
  | "text" // one line
  | "textarea" // multi-line text
  | "model" // an OpenRouter slug, picked from the catalog or typed
  | "int" // whole number
  | "number" // decimal
  | "bool" // on/off, with a stated default
  | "tristate" // auto / yes / no (absent = auto)
  | "enum" // one of `options`
  | "multi" // any of `options`
  | "json"; // a JSON object, sent verbatim

export interface FieldSpec {
  /** Dotted path into the config, e.g. `commands.watchdogMinutes`. */
  key: string;
  label: string;
  /** What the ⓘ button explains: what it does, its default, what blank means. */
  help: string;
  type: FieldType;
  /** Core fields show by default; the rest sit in the "Advanced" fold. */
  advanced: boolean;
  /** The advanced fold's sub-heading. */
  section?: string;
  options?: readonly string[];
  /** Must have a value (name, model, mode, approval). Others: blank = default. */
  required?: boolean;
  min?: number;
  /** The value a blank/absent field behaves as, for the form's placeholder. */
  defaultHint?: string;
}

const COMPACTION_TRIGGERS: readonly CompactionTrigger[] = ["auto", "manual", "suggest", "cancelable", "hard"];

export const MODEL_CONFIG_FIELDS: readonly FieldSpec[] = [
  // ---- Core
  {
    key: "name",
    label: "Name",
    help: "What this config is called in the pickers and on the CLI (e.g. \"Client A — Opus\"). Must be unique.",
    type: "text",
    advanced: false,
    required: true,
  },
  {
    key: "model",
    label: "Model",
    help: "The OpenRouter model this config runs, as its slug (e.g. anthropic/claude-opus-5). Pick from OpenRouter's catalog or type a slug it doesn't list.",
    type: "model",
    advanced: false,
    required: true,
  },
  {
    key: "reasoningEffort",
    label: "Reasoning effort",
    help: "How hard the model thinks before answering, passed to OpenRouter. Higher costs more. Blank = the model's own default. Ignored by models with no reasoning support.",
    type: "enum",
    options: REASONING_EFFORTS,
    advanced: false,
    defaultHint: "model default",
  },
  {
    key: "defaultMode",
    label: "Default mode",
    help: "The mode a new thread starts in: Ask (read-only questions), Plan (read and plan, no edits) or Code (edits and commands).",
    type: "enum",
    options: MODES,
    advanced: false,
    required: true,
  },
  {
    key: "defaultApproval",
    label: "Default approval",
    help: "Which actions need your OK in a new thread. manual: ask for every write and command. auto-safe: allow known-safe commands. full-auto: allow everything. read-only: refuse writes.",
    type: "enum",
    options: APPROVAL_POLICIES,
    advanced: false,
    required: true,
  },

  // ---- Advanced: prompt
  {
    key: "systemPromptAddendum",
    label: "System prompt addendum",
    help: "Extra instructions appended to the system prompt for every thread under this config — the per-client text. The workspace's own AGENTS.md (if read) comes before it, so this wins.",
    type: "textarea",
    advanced: true,
    section: "Prompt",
  },
  {
    key: "environment.projectInstructions",
    label: "Read project instructions",
    help: "Read the workspace's AGENTS.md / CLAUDE.md into the system prompt at thread start. Off means only this config's addendum applies.",
    type: "bool",
    advanced: true,
    section: "Prompt",
    defaultHint: "on",
  },
  {
    key: "environment.turnTimestamps",
    label: "Timestamp each message",
    help: "Stamp each of your messages with the time it was sent, so the model knows today's date instead of guessing from its training.",
    type: "bool",
    advanced: true,
    section: "Prompt",
    defaultHint: "on",
  },
  {
    key: "autoRetitle",
    label: "Re-title as the thread drifts",
    help: "Rename a thread as its topic changes. Each re-title is a billed model call, so it is off by default; threads are still named once after the first exchange.",
    type: "bool",
    advanced: true,
    section: "Prompt",
    defaultHint: "off",
  },

  // ---- Advanced: sampling
  {
    key: "sampling.temperature",
    label: "Temperature",
    help: "Sampling randomness (usually 0–2). Blank = the model's default.",
    type: "number",
    advanced: true,
    section: "Sampling",
    min: 0,
    defaultHint: "model default",
  },
  {
    key: "sampling.topP",
    label: "Top P",
    help: "Nucleus sampling cutoff (0–1). Blank = the model's default.",
    type: "number",
    advanced: true,
    section: "Sampling",
    min: 0,
    defaultHint: "model default",
  },
  {
    key: "sampling.maxTokens",
    label: "Max output tokens",
    help: "The most tokens one reply may produce. Blank = the provider's default. Above the model's output cap the request may be refused.",
    type: "int",
    advanced: true,
    section: "Sampling",
    min: 1,
    defaultHint: "provider default",
  },
  {
    key: "acceptsImages",
    label: "Accepts images",
    help: "Whether the model can be handed pictures. Auto asks OpenRouter's catalog (unknown models count as text-only); set Yes or No when the catalog is wrong.",
    type: "tristate",
    advanced: true,
    section: "Sampling",
    defaultHint: "auto",
  },

  // ---- Advanced: routing & pricing
  {
    key: "provider",
    label: "Provider routing (JSON)",
    help: "OpenRouter's `provider` object, sent verbatim, e.g. {\"only\":[\"openai/flex\"],\"allow_fallbacks\":false} to pin one endpoint. Replaces JLCode's automatic endpoint pin. Blank = automatic.",
    type: "json",
    advanced: true,
    section: "Routing & pricing",
  },
  {
    key: "pricing.promptPerMTok",
    label: "Fallback prompt price ($/M tokens)",
    help: "Used for spend accounting only when OpenRouter doesn't report a cost. Blank = unknown.",
    type: "number",
    advanced: true,
    section: "Routing & pricing",
    min: 0,
  },
  {
    key: "pricing.completionPerMTok",
    label: "Fallback completion price ($/M tokens)",
    help: "Used for spend accounting only when OpenRouter doesn't report a cost. Blank = unknown.",
    type: "number",
    advanced: true,
    section: "Routing & pricing",
    min: 0,
  },
  {
    key: "pricing.cachedPromptPerMTok",
    label: "Fallback cached-prompt price ($/M tokens)",
    help: "Price for cached prompt tokens when OpenRouter doesn't report a cost. Blank = the normal prompt price.",
    type: "number",
    advanced: true,
    section: "Routing & pricing",
    min: 0,
  },

  // ---- Advanced: compaction
  {
    key: "compaction.auto",
    label: "Compact automatically",
    help: "Summarize older context automatically when the conversation nears the model's window.",
    type: "bool",
    advanced: true,
    section: "Compaction",
    defaultHint: "off",
  },
  {
    key: "compaction.model",
    label: "Compaction model",
    help: "A different (often cheaper) model to write the summary. Blank = this config's own model.",
    type: "model",
    advanced: true,
    section: "Compaction",
    defaultHint: "this model",
  },
  {
    key: "compaction.contextLength",
    label: "Context window override",
    help: "The model's context window in tokens. Normally blank — OpenRouter's catalog supplies it; set it for a model the catalog lacks or gets wrong.",
    type: "int",
    advanced: true,
    section: "Compaction",
    min: 1,
    defaultHint: "from catalog",
  },
  {
    key: "compaction.thresholdTokens",
    label: "Compact at (tokens)",
    help: "Compact once the conversation exceeds this many tokens. Must be below the context window. Blank = window minus the buffer below.",
    type: "int",
    advanced: true,
    section: "Compaction",
    min: 1,
    defaultHint: "window − buffer",
  },
  {
    key: "compaction.bufferTokens",
    label: "Headroom (tokens)",
    help: "How far below the window to compact, when no absolute threshold is set. Blank ≈ 20,000.",
    type: "int",
    advanced: true,
    section: "Compaction",
    min: 0,
    defaultHint: "≈ 20,000",
  },
  {
    key: "compaction.keepRecentTokens",
    label: "Keep recent (tokens)",
    help: "Recent tokens kept verbatim through a compaction. Reserved: the current summarizer ignores it.",
    type: "int",
    advanced: true,
    section: "Compaction",
    min: 0,
  },
  {
    key: "compaction.triggerModes",
    label: "Trigger modes",
    help: "Which compaction triggers the thread's compaction menu offers. Blank = all of them.",
    type: "multi",
    options: COMPACTION_TRIGGERS,
    advanced: true,
    section: "Compaction",
    defaultHint: "all",
  },

  // ---- Advanced: commands & agents
  {
    key: "commands.watchdogMinutes",
    label: "Command watchdog (minutes)",
    help: "Minutes a foreground command may run before the model is asked whether to kill it, keep waiting, or move it to the background. 0 turns the check off. Blank = 30.",
    type: "int",
    advanced: true,
    section: "Commands & agents",
    min: 0,
    defaultHint: "30",
  },
  {
    key: "commands.toolRounds",
    label: "Model turns before pausing",
    help: "Model turns one message may take before the loop pauses to ask whether it's still getting somewhere (doubles on each Continue). 0 turns the pause off. Blank = 50.",
    type: "int",
    advanced: true,
    section: "Commands & agents",
    min: 0,
    defaultHint: "50",
  },
  {
    key: "commands.agentDepth",
    label: "Sub-agent depth",
    help: "How many levels of sub-agents may sit below the thread. 0 never spawns. Blank = the default.",
    type: "int",
    advanced: true,
    section: "Commands & agents",
    min: 0,
    defaultHint: "default",
  },
  {
    key: "commands.agentConcurrency",
    label: "Agents running at once",
    help: "How many agents of one tree may run at the same time. 0 = no cap. Blank = the default.",
    type: "int",
    advanced: true,
    section: "Commands & agents",
    min: 0,
    defaultHint: "default",
  },
];

/** Required, deeply — so a field added to `ModelConfig` (at any depth) must be
 *  added to `COVERAGE` for this file to compile. */
type DeepRequired<T> = T extends readonly (infer _U)[]
  ? T
  : T extends object
    ? { [K in keyof T]-?: DeepRequired<NonNullable<T[K]>> }
    : T;

/** Fields that are not form fields: identity, timestamps, and the key. */
export const NON_FIELDS = ["id", "createdAt", "updatedAt", "openRouterKey"] as const;

/**
 * A sample config with **every** field set. Its only job is the compile-time
 * check described at the top: its leaves are what the coverage test compares
 * with `MODEL_CONFIG_FIELDS`. Objects whose keys are free-form (`provider`) are
 * one leaf.
 */
export const COVERAGE: DeepRequired<Omit<ModelConfig, "provider">> & { provider: object } = {
  id: "",
  name: "",
  openRouterKey: "",
  model: "",
  reasoningEffort: "none",
  sampling: { temperature: 0, topP: 0, maxTokens: 0 },
  pricing: { promptPerMTok: 0, completionPerMTok: 0, cachedPromptPerMTok: 0 },
  systemPromptAddendum: "",
  defaultMode: "code",
  defaultApproval: "manual",
  autoRetitle: false,
  acceptsImages: false,
  provider: {},
  compaction: {
    model: "",
    auto: false,
    bufferTokens: 0,
    thresholdTokens: 0,
    keepRecentTokens: 0,
    triggerModes: [],
    contextLength: 0,
  },
  environment: { turnTimestamps: false, projectInstructions: false },
  commands: { watchdogMinutes: 0, toolRounds: 0, agentDepth: 0, agentConcurrency: 0 },
  createdAt: "",
  updatedAt: "",
};

// ---- Reading and writing by path

export type FieldValue = string | number | boolean | string[] | Record<string, unknown> | null;

function getPath(obj: unknown, key: string): unknown {
  let cur: unknown = obj;
  for (const part of key.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Set (or, with `undefined`, delete) a dotted path, creating parents and
 *  dropping a parent object the delete leaves empty. */
function setPath(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".");
  const last = parts.pop()!;
  let cur = obj;
  const chain: [Record<string, unknown>, string][] = [];
  for (const part of parts) {
    const next = cur[part];
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      if (value === undefined) return; // nothing to delete
      cur[part] = {};
    } else {
      cur[part] = { ...(next as Record<string, unknown>) }; // copy, never mutate the source config
    }
    chain.push([cur, part]);
    cur = cur[part] as Record<string, unknown>;
  }
  if (value === undefined) delete cur[last];
  else cur[last] = value;
  // Drop parents emptied by a delete, innermost first.
  for (let i = chain.length - 1; i >= 0; i--) {
    const [parent, part] = chain[i]!;
    if (Object.keys(parent[part] as object).length === 0) delete parent[part];
    else break;
  }
}

/** The form's values for one config: every field, `null` where absent. */
export function readFields(config: Partial<ModelConfig>): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const f of MODEL_CONFIG_FIELDS) {
    const v = getPath(config, f.key);
    out[f.key] = v === undefined ? null : (v as FieldValue);
  }
  return out;
}

/** Validate one incoming value. Returns the value to store (`undefined` =
 *  remove the field) or an error string. */
function coerce(f: FieldSpec, raw: unknown): { value: unknown } | { error: string } {
  const blank = raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "");
  if (blank) {
    if (f.required) return { error: `${f.label} is required.` };
    return { value: undefined };
  }
  switch (f.type) {
    case "text":
    case "model": {
      if (typeof raw !== "string") return { error: `${f.label} must be text.` };
      return { value: raw.trim() };
    }
    case "textarea":
      if (typeof raw !== "string") return { error: `${f.label} must be text.` };
      return { value: raw };
    case "int":
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) return { error: `${f.label} must be a number.` };
      if (f.type === "int" && !Number.isInteger(n)) return { error: `${f.label} must be a whole number.` };
      if (f.min !== undefined && n < f.min) return { error: `${f.label} must be at least ${f.min}.` };
      return { value: n };
    }
    case "bool":
    case "tristate":
      if (typeof raw !== "boolean") return { error: `${f.label} must be on or off.` };
      return { value: raw };
    case "enum":
      if (typeof raw !== "string" || !f.options!.includes(raw)) {
        return { error: `${f.label} must be one of ${f.options!.join(", ")}.` };
      }
      return { value: raw };
    case "multi": {
      if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string" || !f.options!.includes(x))) {
        return { error: `${f.label} must be a list of ${f.options!.join(", ")}.` };
      }
      return raw.length === 0 ? { value: undefined } : { value: [...new Set(raw as string[])] };
    }
    case "json": {
      let v: unknown = raw;
      if (typeof raw === "string") {
        try {
          v = JSON.parse(raw);
        } catch {
          return { error: `${f.label} is not valid JSON.` };
        }
      }
      if (v === null || typeof v !== "object" || Array.isArray(v)) return { error: `${f.label} must be a JSON object.` };
      return Object.keys(v).length === 0 ? { value: undefined } : { value: v };
    }
  }
}

/**
 * Apply form values over a base config. Only keys present in `values` are
 * touched, so fields the form didn't send — and anything hand-edited into the
 * file that no field speaks for (D-68) — survive. Returns the new config body
 * (without id/timestamps/key changes) or the per-field errors.
 */
export function applyFields(
  base: Partial<ModelConfig>,
  values: Record<string, unknown>,
): { config: Partial<ModelConfig> } | { errors: Record<string, string> } {
  const next = structuredClone(base) as Record<string, unknown>;
  const errors: Record<string, string> = {};
  for (const f of MODEL_CONFIG_FIELDS) {
    if (!(f.key in values)) continue;
    const r = coerce(f, values[f.key]);
    if ("error" in r) errors[f.key] = r.error;
    else setPath(next, f.key, r.value);
  }
  for (const k of Object.keys(values)) {
    if (!MODEL_CONFIG_FIELDS.some((f) => f.key === k)) errors[k] = `Unknown field "${k}".`;
  }
  // `compaction.auto` is the one required member of its group: a group that
  // exists without it (a threshold set, auto left blank) means "off".
  const compaction = next["compaction"] as Record<string, unknown> | undefined;
  if (compaction && typeof compaction["auto"] !== "boolean") compaction["auto"] = false;
  if (Object.keys(errors).length > 0) return { errors };
  return { config: next as Partial<ModelConfig> };
}
