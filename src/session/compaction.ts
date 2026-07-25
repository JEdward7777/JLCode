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
  opts: { system?: string; capChars?: number } = {},
): ChatMessage[] {
  const system = opts.system?.trim();
  const messages: ChatMessage[] = system ? [{ role: "system", content: system }] : [];
  let body: ChatMessage[] = [];
  for (const entry of pathToLeaf(conv)) {
    switch (entry.type) {
      case "compaction":
        // A prior summary resets the replay, same as the wire builder.
        body = [{ role: "user", content: `[Summary of the earlier conversation]\n${entry.summary}` }];
        break;
      case "user":
        body.push({ role: "user", content: entry.text });
        break;
      case "assistant": {
        // Fold the readable planning into visible content; drop the opaque signed
        // reasoning (non-portable across models) and the structured tool_calls
        // (the summarizer only needs to read what happened, not re-issue calls).
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
