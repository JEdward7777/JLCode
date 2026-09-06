/**
 * The config-store schema (SPEC §4/§7, D-05/D-06/D-13). A single hand-editable
 * `config.json` holding named model configurations (with keys), per-directory
 * bindings, and the Auto-safe allowlist. Kept in the OS-level config store,
 * never in the project.
 */

export const CONFIG_VERSION = 1;

export type Mode = "ask" | "plan" | "code";
export const MODES: readonly Mode[] = ["ask", "plan", "code"];

export type ApprovalPolicy = "manual" | "auto-safe" | "full-auto" | "read-only";
export const APPROVAL_POLICIES: readonly ApprovalPolicy[] = [
  "manual",
  "auto-safe",
  "full-auto",
  "read-only",
];

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "adaptive";
export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "none",
  "low",
  "medium",
  "high",
  "adaptive",
];

/** Compaction trigger modes (SPEC §15, D-27). */
export type CompactionTrigger = "auto" | "manual" | "suggest" | "cancelable" | "hard";

export interface SamplingParams {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

/** Fallback pricing for spend accounting (D-33), in USD per million tokens. Used
 *  only when OpenRouter doesn't return an authoritative `cost` (e.g. the fake
 *  driver, or a provider that omits it). Cached prompt tokens bill at
 *  `cachedPromptPerMTok` when set, else at the normal prompt rate. */
export interface ModelPricing {
  promptPerMTok?: number;
  completionPerMTok?: number;
  cachedPromptPerMTok?: number;
}

export interface CompactionSettings {
  /** Summarizer model id; default = the working model (D-27/D-38). */
  model?: string;
  auto: boolean;
  /** Headroom below the window before compacting (default ≈ 20k, D-27). The
   *  derivation used when `thresholdTokens` is absent (X-27). */
  bufferTokens?: number;
  /** Compact once the known prefix exceeds this many tokens (X-27) — the
   *  threshold stated absolutely ("condense at 171500") instead of as headroom.
   *  Wins over `bufferTokens`; must be below the context window or it is refused
   *  (a threshold at/above the window could never fire). The compactor-fit guard
   *  (D-44a) still applies on top. */
  thresholdTokens?: number;
  /** Recent tokens kept verbatim — fast-follow (#2); v1 safe-harbor ignores it. */
  keepRecentTokens?: number;
  triggerModes?: CompactionTrigger[];
  /** The model's context window (`context_length`), when known. An explicit
   *  override / manual source for the compaction budget (D-27/D-44); a live
   *  OpenRouter `/models` fetch that populates this automatically lands later.
   *  A Session may also be handed the window directly via `contextWindow`. */
  contextLength?: number;
}

/** What JLCode tells the model about the world around the conversation. Two
 *  halves, deliberately separate because only one of them can live in the cached
 *  system message: the **per-turn** half (X-25 — the `<environment_details>`
 *  block appended to each user turn) and the **static** half (X-15 — the
 *  workspace's own instruction file, read once into the system prompt). */
export interface EnvironmentSettings {
  /** Stamp each user turn with the time it was sent (X-25). **Default on** —
   *  absent means on, and it takes an explicit `false` to turn it off, because
   *  the failure being fixed (a model writing today's notes under a date from
   *  its training cutoff) is silent. */
  turnTimestamps?: boolean;
  /** Read the workspace's own agent-instruction file (`AGENTS.md`, `CLAUDE.md`,
   *  …) into the system prompt at session start (X-15). **Default on** — a repo
   *  that ships instructions did so meaning them to be followed, and the file is
   *  the user's own, not a third party's. Explicit `false` opts out, e.g. for a
   *  client config that must run only under its own addendum. */
  projectInstructions?: boolean;
}

/** How `run_command` behaves (D-34, X-33). Per model config rather than global
 *  because the watchdog's check is a **billed model call** — how patient to be
 *  with a long command is a question about the model you are paying for. */
export interface CommandSettings {
  /** Minutes a background command may run before the watchdog asks the model
   *  whether to kill it (D-34). Absent = the 30-minute default; **0 disables the
   *  check entirely**, after which only a person (or a per-call `timeout`) ends
   *  a runaway. The number is also stated in `run_command`'s description, so
   *  changing it changes what the model is told. */
  watchdogMinutes?: number;
  /** Model turns one user message may take before the loop pauses to ask whether
   *  it is still getting somewhere (D-79). Absent = 50; the budget **doubles**
   *  on each Continue, so this is where the first question lands, not a ceiling.
   *  Lives beside the watchdog for the same reason: how patient to be with a
   *  long run is a question about the model you are paying for. */
  toolRounds?: number;
}

/** A named model configuration a user works under (e.g. "Client A — Opus"). */
export interface ModelConfig {
  id: string;
  name: string;
  /** OpenRouter API key (secret; never logged or printed). */
  openRouterKey: string;
  /** OpenRouter model slug. */
  model: string;
  reasoningEffort?: ReasoningEffort;
  sampling?: SamplingParams;
  /** Fallback per-token pricing (D-33) when the API doesn't report `cost`. */
  pricing?: ModelPricing;
  systemPromptAddendum?: string;
  defaultMode: Mode;
  defaultApproval: ApprovalPolicy;
  /** Re-title a thread as it drifts (X-17). Default **on**; `false` keeps the
   *  name the opening exchange earned. The opt-out exists because every
   *  re-title is a billed model call — cheap (the question rides the cached
   *  live prefix, D-29/D-26) and rare (roughly log2(turns) over a thread's
   *  life), but not free. Auto-*titling* itself stays on either way. */
  autoRetitle?: boolean;
  /** Override the catalog's answer to "can this model see images?" (P8b, D-78c).
   *  Absent = ask OpenRouter's `architecture.input_modalities`, and treat an
   *  unknown model as text-only. Hand-edited, like every field the CLI has no
   *  flag for (D-68 keeps unknown keys); it exists for the same reason
   *  `compaction.contextLength` does — a catalog can lag a model, and a
   *  capability that can only be wrong in one direction needs a way back. */
  acceptsImages?: boolean;
  compaction?: CompactionSettings;
  /** Per-turn environment details (X-25). Absent = defaults, i.e. stamped. */
  environment?: EnvironmentSettings;
  /** `run_command` behaviour — the watchdog interval (X-33). Absent = defaults. */
  commands?: CommandSettings;
  createdAt: string;
  updatedAt: string;
}

/** Server-mode auth material for outward binds (D-40, P5f). Server-wide (not
 *  per model-config): a hashed password + a persisted cookie-signing secret.
 *  Kept here so it inherits the config file's chmod-600 protection. */
export interface AuthConfig {
  /** scrypt hash of the serve password, hex. */
  passwordHash: string;
  /** Per-password random salt, hex. */
  salt: string;
  /** HMAC key for signing session cookies, hex (persisted → cookies survive restart). */
  cookieSecret: string;
  updatedAt: string;
}

/** The whole config-store document. */
export interface Config {
  version: number;
  modelConfigs: ModelConfig[];
  /** Absolute working directory → model-config id (D-06). */
  folderBindings: Record<string, string>;
  /** Absolute working directory → extra allowed sandbox roots (D-19 "remember"). */
  folderRoots?: Record<string, string[]>;
  /** Commands auto-approved under the Auto-safe policy (D-08). */
  autoSafeAllowlist: string[];
  /** Outward-serve auth (D-40); absent until a password is provisioned. */
  auth?: AuthConfig;
  prefs?: Record<string, unknown>;
}
