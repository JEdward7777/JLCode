/**
 * Spend accounting (D-33). The cost of one model call is the provider's
 * authoritative `cost` when reported (OpenRouter, cache-aware), else computed
 * from token counts × the config's fallback pricing. Whole-tree spend is the
 * sum over every model call charged to the conversation — all branches, plus
 * out-of-band calls like the watchdog (§25) — so it only ever grows.
 */
import type { Usage } from "../llm/types.js";
import type { ModelPricing } from "../config/types.js";

const PER_MTOK = 1_000_000;

/** Cost of a single call in USD. Prefers the provider's `costUsd`; otherwise
 *  prices tokens from `pricing` (cached prompt tokens at the cached rate when
 *  given, the rest at the prompt rate). Returns 0 when neither is available. */
export function computeCost(usage: Usage | undefined, pricing?: ModelPricing): number {
  if (!usage) return 0;
  if (typeof usage.costUsd === "number") return usage.costUsd;
  if (!pricing) return 0;
  const prompt = usage.promptTokens ?? 0;
  const cached = Math.min(usage.cachedTokens ?? 0, prompt);
  const uncachedPrompt = prompt - cached;
  const completion = usage.completionTokens ?? 0;
  const promptRate = pricing.promptPerMTok ?? 0;
  const cachedRate = pricing.cachedPromptPerMTok ?? promptRate;
  const completionRate = pricing.completionPerMTok ?? 0;
  return (
    (uncachedPrompt * promptRate + cached * cachedRate + completion * completionRate) / PER_MTOK
  );
}
