/**
 * Compaction trigger detection (P6a, D-44/D-27) — the headless, deterministic
 * "when to compact" logic, kept pure so it is free to Tier-0 test with no model
 * call. Compaction itself (the summarize + overlay engine) is P6b; this module
 * only decides *whether* the next request would blow the budget.
 *
 * D-44's key move: react **one turn late** on *ground-truth* usage. Every LLM
 * response reports authoritative `prompt_tokens` + `completion_tokens`, so after
 * a turn the next request's known prefix is exactly `prompt + completion`. We
 * compare that to `window − buffer` and compact before the next send — never
 * estimating, never tokenizing (honors D-25). The ~20K buffer is precisely the
 * headroom that absorbs the single accepted overshoot turn.
 */
import type { Usage } from "../llm/types.js";
import type { CompactionSettings, CompactionTrigger } from "../config/types.js";

/** Headroom kept below the window (D-27/D-44): the ~20K one-overshoot-turn buffer.
 *  Per D-44 this buffer subsumes the output reserve for v1 (`budget = window − buffer`);
 *  a separate `reservedOutput` is only revisited if a model reserves a huge output. */
export const DEFAULT_BUFFER_TOKENS = 20_000;

/** Active trigger mode when auto is off (D-27: auto-but-cancelable is the default). */
export const DEFAULT_TRIGGER_MODE: CompactionTrigger = "cancelable";

export interface CompactionBudget {
  /** The model's context window (`context_length`) — injected in P6a. */
  window: number;
  /** Headroom kept below the window (buffer, D-44). */
  buffer: number;
  /** Compact once the known prefix exceeds this: `window − buffer`, floored at 0. */
  threshold: number;
}

/** Derive the compaction budget from an injected window and the config buffer. */
export function computeBudget(window: number, bufferTokens?: number): CompactionBudget {
  const buffer = bufferTokens ?? DEFAULT_BUFFER_TOKENS;
  return { window, buffer, threshold: Math.max(0, window - buffer) };
}

/** The next request's known prefix size (D-44): the just-finished turn's
 *  authoritative prompt + completion tokens — everything the next request
 *  resends, measured exactly by the provider. `undefined` usage → 0 (unknown). */
export function knownPrefixTokens(usage: Usage | undefined): number {
  if (!usage) return 0;
  return (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
}

/** Compactor-fit guard (D-44a): when a *smaller* compaction model is configured
 *  the history must also fit the summarizer, so trigger earlier. No authoritative
 *  count exists for a model we never send to, so proxy it with the working model's
 *  window under the same buffer slack and take the tighter threshold. Returns the
 *  budget unchanged when the compactor is the working model or its window is
 *  unknown (or is at least as roomy). */
export function applyCompactorFit(
  budget: CompactionBudget,
  compactorWindow: number | undefined,
  bufferTokens?: number,
): CompactionBudget {
  if (compactorWindow === undefined) return budget;
  const buffer = bufferTokens ?? DEFAULT_BUFFER_TOKENS;
  const compactorThreshold = Math.max(0, compactorWindow - buffer);
  if (compactorThreshold >= budget.threshold) return budget;
  return { ...budget, threshold: compactorThreshold };
}

export interface TriggerEvaluation {
  /** The next request's known prefix (`prompt + completion` from the last turn). */
  prefixTokens: number;
  budget: CompactionBudget;
  /** True once the prefix exceeds the budget threshold — compact before next send. */
  needsCompaction: boolean;
}

/** Evaluate the trigger from a turn's authoritative usage against a budget (D-44). */
export function evaluateTrigger(
  usage: Usage | undefined,
  budget: CompactionBudget,
): TriggerEvaluation {
  const prefixTokens = knownPrefixTokens(usage);
  return { prefixTokens, budget, needsCompaction: prefixTokens > budget.threshold };
}

/** The active trigger mode (D-27). `auto` wins when set; otherwise the first
 *  configured trigger mode, else the auto-but-cancelable default. */
export function activeTriggerMode(settings?: CompactionSettings): CompactionTrigger {
  if (settings?.auto) return "auto";
  return settings?.triggerModes?.[0] ?? DEFAULT_TRIGGER_MODE;
}

/** Recognize an over-window rejection (D-44b hard-wall fallback): a single turn's
 *  new content blew the whole buffer and the provider hard-errored (`prompt >
 *  context_length`). Matched heuristically on the error text since providers phrase
 *  it differently. P6b turns this into compact-and-retry; P6a only flags it. */
export function isOverWindowError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /context[ _]?length|maximum context|context window|too many tokens|prompt is too long|reduce the length|maximum.*tokens/.test(
    msg,
  );
}
