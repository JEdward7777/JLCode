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
  /** Headroom below the window before compacting (default ≈ 20k, D-27). */
  bufferTokens?: number;
  /** Recent tokens kept verbatim — fast-follow (#2); v1 safe-harbor ignores it. */
  keepRecentTokens?: number;
  triggerModes?: CompactionTrigger[];
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
  compaction?: CompactionSettings;
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
