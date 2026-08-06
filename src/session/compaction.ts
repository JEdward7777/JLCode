/**
 * Compaction trigger detection (P6a, D-44/D-27) — the headless, deterministic
 * "when to compact" logic, kept pure so it is free to Tier-0 test with no model
 * call. Compaction itself (the summarize + overlay engine) is P6b; this module
 * only decides *whether* the next request would blow the budget.
 *
 * D-44's key move: react **one turn late** on *ground-truth* usage. Every LLM
 * response reports authoritative `prompt_tokens` + `completion_tokens`, so after
 * a turn the next request's known prefix is exactly `prompt + completion`. We
 * compare that to the threshold and compact before the next send — never
 * estimating, never tokenizing (honors D-25). The ~20K buffer is precisely the
 * headroom that absorbs the single accepted overshoot turn.
 *
 * X-27 makes that threshold *settable*: `compaction.thresholdTokens` states it
 * absolutely ("compact above 171,500"), and `window − buffer` remains the
 * derivation when it is absent.
 */
import type { ChatMessage, Usage } from "../llm/types.js";
import type { CompactionSettings, CompactionTrigger } from "../config/types.js";
import type { Conversation } from "../conversation/types.js";
import { pathToLeaf } from "../conversation/tree.js";

/** Headroom kept below the window (D-27/D-44): the ~20K one-overshoot-turn buffer.
 *  Per D-44 this buffer subsumes the output reserve for v1 (`budget = window − buffer`);
 *  a separate `reservedOutput` is only revisited if a model reserves a huge output. */
export const DEFAULT_BUFFER_TOKENS = 20_000;

/** Active trigger mode when auto is off (D-27: auto-but-cancelable is the default). */
export const DEFAULT_TRIGGER_MODE: CompactionTrigger = "cancelable";

/** Where a budget's threshold came from (X-27) — provenance rides with the
 *  number, the same way `WindowSource` rides with the window (D-60d), so a
 *  banner or `config which` can state *why* compaction fires where it does. */
export type ThresholdSource = "absolute" | "buffer" | "compactor-fit";

export interface CompactionBudget {
  /** The model's context window (`context_length`) — injected in P6a. */
  window: number;
  /** Headroom kept below the window (buffer, D-44). */
  buffer: number;
  /** Compact once the known prefix exceeds this. Either the absolute
   *  `thresholdTokens` (X-27) or the derived `window − buffer`, floored at 0. */
  threshold: number;
  /** How `threshold` was settled (X-27). */
  source: ThresholdSource;
  /** An absolute `thresholdTokens` that was **refused** because it does not fit
   *  the window (X-27d): a threshold at or above the window can only be crossed
   *  by a prefix the provider would already have rejected, so it would silently
   *  never fire. Kept here — rather than dropped — so the surfaces can say the
   *  configured value is being ignored instead of quietly disagreeing with it. */
  refusedThreshold?: number;
}

/** Settings that shape the budget: the absolute threshold (X-27) and the
 *  headroom it falls back to (D-44). */
export interface BudgetSettings {
  /** Absolute "compact above this many tokens" (X-27). Wins over `bufferTokens`. */
  thresholdTokens?: number;
  /** Headroom below the window; the derivation used when no absolute threshold
   *  is set, so existing configs keep their meaning exactly (D-44/D-44c). */
  bufferTokens?: number;
}

/** Is an absolute threshold usable against this window (X-27d)? It must be a
 *  positive integer strictly *below* the window — at the window it could only
 *  fire on a request the provider has already rejected. Shared with the CLI so
 *  `config set` refuses the same values the budget would ignore. */
export function thresholdFitsWindow(thresholdTokens: number, window: number): boolean {
  return Number.isFinite(thresholdTokens) && thresholdTokens > 0 && thresholdTokens < window;
}

/**
 * Settle the compaction budget from an injected window and the config.
 *
 * **Precedence (X-27a): an absolute `thresholdTokens` wins; otherwise the
 * threshold is derived as `window − bufferTokens` (D-44c), the pre-X-27
 * behaviour.** So nothing existing changes meaning: a config with only a buffer
 * computes exactly what it always did. An absolute threshold that does not fit
 * the window is refused and the derivation is used instead, with the refused
 * value reported (see {@link CompactionBudget.refusedThreshold}).
 *
 * The compactor-fit guard (D-44a) is applied *after* this, by
 * {@link applyCompactorFit} — an absolute threshold the summarizer itself
 * cannot read must still tighten, or compaction fails at the moment it is
 * needed.
 */
export function computeBudget(window: number, settings: BudgetSettings = {}): CompactionBudget {
  const buffer = settings.bufferTokens ?? DEFAULT_BUFFER_TOKENS;
  const derived = Math.max(0, window - buffer);
  const absolute = settings.thresholdTokens;
  if (absolute === undefined) return { window, buffer, threshold: derived, source: "buffer" };
  if (!thresholdFitsWindow(absolute, window)) {
    return { window, buffer, threshold: derived, source: "buffer", refusedThreshold: absolute };
  }
  return { window, buffer, threshold: absolute, source: "absolute" };
}

/** Human wording for where a threshold came from (X-27), for the serve banner
 *  and `config which`. The refusal, when there is one, is stated separately. */
export function describeThresholdSource(budget: CompactionBudget): string {
  switch (budget.source) {
    case "absolute":
      return "set in this config (compaction.thresholdTokens)";
    case "compactor-fit":
      return "tightened to fit the compaction model";
    case "buffer":
      return `derived: window − ${budget.buffer.toLocaleString()} buffer`;
  }
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
 *  unknown (or is at least as roomy).
 *
 *  Applied **after** {@link computeBudget}, so it caps an absolute
 *  `thresholdTokens` too (X-27a): a threshold above what the summarizer can read
 *  would fail exactly when compaction is needed. */
export function applyCompactorFit(
  budget: CompactionBudget,
  compactorWindow: number | undefined,
  bufferTokens?: number,
): CompactionBudget {
  if (compactorWindow === undefined) return budget;
  const buffer = bufferTokens ?? DEFAULT_BUFFER_TOKENS;
  const compactorThreshold = Math.max(0, compactorWindow - buffer);
  if (compactorThreshold >= budget.threshold) return budget;
  return { ...budget, threshold: compactorThreshold, source: "compactor-fit" };
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

// ---------------------------------------------------------------------------
// P6b — the safe-harbor compaction engine's pure pieces (D-28/D-29/D-38). The
// Session drives the model call + tree overlay; the deterministic string/shape
// work lives here so it stays Tier-0 testable with no model call.
// ---------------------------------------------------------------------------

/** The summary's output cap (~4K tokens, D-28's anchored template budget), sent
 *  as the summary request's `max_tokens`. */
export const COMPACTION_MAX_TOKENS = 4096;

/** Per-tool-output cap (chars ≈ ~2K tokens, D-28) used only when a summary input
 *  must be shrunk to fit — the forced over-window fallback (D-44b). The normal
 *  budget-triggered path sends the exact live prefix for cache reuse (D-29). */
export const SUMMARY_TOOL_OUTPUT_CAP_CHARS = 8_000;

/** The fixed Markdown section headings of the anchored structured summary (D-28),
 *  in order. Exported so a renderer/test can rely on the shape. */
export const COMPACTION_SECTIONS = [
  "Goal",
  "Constraints",
  "Progress",
  "Key Decisions",
  "Next Steps",
  "Critical Context",
  "Relevant Files",
] as const;

/** The ephemeral compaction instruction (D-28/D-29): appended as the final user
 *  message of the summary request and **never persisted to the tree**. It asks
 *  the model to fold the entire conversation above into one self-contained,
 *  anchored structured summary that a fresh assistant could resume from. When a
 *  prior summary is already in the replayed prefix (a later compaction, D-28's
 *  "evolving" summary) the instruction tells the model to fold it in. */
export function buildCompactionInstruction(opts: { hasPriorSummary?: boolean } = {}): string {
  const headings = COMPACTION_SECTIONS.map((s) => `## ${s}`).join("\n");
  const priorLine = opts.hasPriorSummary
    ? "- A summary of the earlier conversation already appears above; treat it as authoritative " +
      "for that earlier part and fold it into this single updated summary.\n"
    : "";
  return (
    "[compaction] Summarize the ENTIRE conversation above into one self-contained summary. " +
    "Everything above will be replaced by this summary, so a fresh assistant with no other " +
    "memory must be able to continue the work seamlessly from it alone.\n\n" +
    "Write it under exactly these Markdown headings, in this order (drop a heading only if it " +
    "would be genuinely empty):\n\n" +
    headings +
    "\n\nRules:\n" +
    "- Quote the user's original request and the most recent exchange near-verbatim, as prose.\n" +
    "- Preserve exact identifiers verbatim: file paths, function/type names, shell commands, " +
    "config keys, and concrete values.\n" +
    priorLine +
    "- Be faithful and specific; never invent facts. Stay concise (well under ~4000 tokens).\n" +
    "- Output ONLY the summary Markdown — no preamble, no sign-off, no code fences around it."
  );
}

/** Shrink a summary **input** so it fits when the live prefix itself over-windowed
 *  (D-44b forced fallback): truncate each tool result to the tail cap, keeping a
 *  visible marker. Only tool outputs are capped — they are the usual source of a
 *  sudden over-window jump, and user/assistant text carries the intent we must
 *  keep. Pure; returns a new array (inputs untouched). */
export function truncateToolOutputsForSummary(
  messages: ChatMessage[],
  capChars: number = SUMMARY_TOOL_OUTPUT_CAP_CHARS,
): ChatMessage[] {
  return messages.map((m) => {
    if (m.role !== "tool" || typeof m.content !== "string" || m.content.length <= capChars) return m;
    const kept = m.content.slice(-capChars);
    return { ...m, content: `[…tool output truncated for summary…]\n${kept}` };
  });
}

/** Build the summary **input** for the cross-model path (D-29, refined per
 *  Joshua): when a *different*, cheaper compactor is configured we can't reuse
 *  the working model's prompt cache, and — the one genuinely non-portable field —
 *  the working model's **signed/encrypted `reasoning_details`** must not cross to
 *  another model (the same tamper hazard as D-28, pointed the other way). So we
 *  send the branch as ordinary structured messages "as if we'd talked to the
 *  cheaper model all along": keep the **readable** reasoning text (the planning —
 *  the substantial part, which is just text and fully portable) folded into the
 *  assistant content, **drop** the opaque `reasoning_details` blob, and truncate
 *  tool outputs so the request fits. Pure (walks the active branch); the caller
 *  appends the compaction instruction and sets `model` to the compactor.
 *
 *  Note we keep only the readable `reasoningText` and never inspect the opaque
 *  `reasoning_details` — honoring "we never interpret reasoning" (D-14) while
 *  still preserving the planning Joshua wants carried into the summary. */
export function buildCrossModelSummaryInput(
  conv: Conversation,
  opts: { system?: string; capChars?: number; leafId?: string | null } = {},
): ChatMessage[] {
  const system = opts.system?.trim();
  const messages: ChatMessage[] = system ? [{ role: "system", content: system }] : [];
  let body: ChatMessage[] = [];
  for (const entry of pathToLeaf(conv, opts.leafId ?? conv.activeLeaf)) {
    switch (entry.type) {
      case "compaction":
        // A prior summary resets the replay, same as the wire builder.
        body = [{ role: "user", content: `[Summary of the earlier conversation]\n${entry.summary}` }];
        break;
      case "user":
        body.push({ role: "user", content: entry.text });
        break;
      case "assistant": {
        // Fold the readable planning into visible content; drop the opaque
        // reasoning blob — signed OR encrypted/redacted — which is non-portable
        // across models, plus the structured tool_calls (the summarizer only reads
        // what happened, it doesn't re-issue calls). Keying off the SDK's split
        // (readable `reasoningText` vs opaque `reasoning`) is exactly "keep the
        // planning, redact only the redacted": a redacted turn has no readable text,
        // so nothing of its thinking survives — correct, and by construction.
        const planning = entry.reasoningText?.trim();
        const said = entry.text?.trim() ?? "";
        const content = [planning ? `[reasoning] ${planning}` : "", said].filter(Boolean).join("\n\n");
        body.push({ role: "assistant", content: content || null });
        break;
      }
      case "tool":
        body.push({ role: "user", content: `[tool ${entry.name} result]\n${entry.content}` });
        break;
    }
  }
  const merged = [...messages, ...body];
  // Truncate oversized tool-derived content so the whole request fits the
  // (often smaller) compactor window — the cross-model analog of the forced
  // same-model truncation.
  return truncateCrossModelToolOutputs(merged, opts.capChars);
}

/** Cap oversized `[tool …]` user messages produced by {@link buildCrossModelSummaryInput}. */
function truncateCrossModelToolOutputs(messages: ChatMessage[], capChars = SUMMARY_TOOL_OUTPUT_CAP_CHARS): ChatMessage[] {
  return messages.map((m) => {
    if (m.role !== "user" || typeof m.content !== "string") return m;
    if (!m.content.startsWith("[tool ") || m.content.length <= capChars) return m;
    return { ...m, content: `[…tool output truncated for summary…]\n${m.content.slice(-capChars)}` };
  });
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
